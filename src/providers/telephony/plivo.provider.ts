/**
 * plivo.provider.ts
 *
 * Concrete `TelephonyProvider` implementation backed by Plivo's
 * official Node.js SDK (`plivo`). Satisfies the existing
 * `TelephonyProvider` contract exactly — the `VoiceSessionManager`
 * never imports this file directly; it is resolved through the
 * `ProviderRegistry` by `ProviderIdentifier`.
 *
 * Scope note: this adapter only places/ends/records calls via Plivo's
 * REST Call API. Answer-URL/XML webhook handling, media streaming, and
 * WebSocket audio bridging are out of scope for the Provider Layer
 * (see task boundaries) and belong to a future API-routes package.
 */

import { Client as PlivoClient } from "plivo";
import { TELEPHONY_PROVIDER_IDS } from "../../constants/providers.constants";
import { ProviderCategory, SupportedLanguage } from "../../types/enums";
import type { ProviderDescriptor, ProviderHealthStatus } from "../../types/provider.types";
import type {
  TelephonyCallHandle,
  TelephonyCallParams,
    TelephonyProvider,
} from "../../interfaces/providers/telephony-provider.interface";
import { probeHealth } from "../shared/health";
import { requireEnv } from "../shared/env";

/**
 * Environment variables consumed by this adapter. See
 * `.env.example` for the authoritative list.
 */
interface PlivoEnvConfig {
  readonly authId: string;
  readonly authToken: string;
  readonly fromNumber: string;
  readonly answerUrl: string;
}

function loadEnvConfig(): PlivoEnvConfig {
  return {
    authId: requireEnv("PLIVO_AUTH_ID", TELEPHONY_PROVIDER_IDS.PLIVO),
    authToken: requireEnv("PLIVO_AUTH_TOKEN", TELEPHONY_PROVIDER_IDS.PLIVO),
    fromNumber: requireEnv("PLIVO_FROM_NUMBER", TELEPHONY_PROVIDER_IDS.PLIVO),
    answerUrl: requireEnv("PLIVO_ANSWER_URL", TELEPHONY_PROVIDER_IDS.PLIVO),
  };
}

/**
 * `time_limit` sent with every Start-Recording request, in seconds.
 *
 * Plivo's Record API defaults this to 60 seconds, so omitting it cuts
 * every recording at one minute while the call carries on — the exact
 * silent truncation `VOBIZ_RECORDING_TIME_LIMIT_SECONDS` was raised to
 * fix. Held at the same 900 as Vobiz so a recording's lifetime does not
 * depend on which telephony provider placed the call; it covers the
 * campaign watchdog's `maxCallSeconds` (180) five times over, and the
 * recording still stops when the call ends, so in practice recording
 * lifetime == call lifetime.
 */
export const PLIVO_RECORDING_TIME_LIMIT_SECONDS = 900;

/**
 * Normalizes a dialled number to E.164.
 *
 * Plivo tolerates `+`, spaces and dashes, but it REQUIRES a country
 * code: a bare national number like `9876543210` is parsed as US
 * `+1 234-567-890`, and the API answers
 * `403 Calls to this destination region are barred.` — the call is
 * never created, so there is not even a CDR to look at. A number
 * typed the way people actually say it locally is therefore the one
 * input that silently produces "Plivo doesn't call at all".
 *
 * When the country code is missing, it is taken from the caller-id
 * number (`PLIVO_FROM_NUMBER`): the digits of `from` that sit in
 * front of a national number of the dialled number's length. For
 * `from = +918031452733` and `to = 9876543210` that is `91`, giving
 * `+919876543210`.
 */
export function toE164(rawDestination: string, fromNumber: string): string {
  const trimmed = rawDestination.trim();
  const hadPlus = trimmed.startsWith("+") || trimmed.startsWith("00");
  const digits = trimmed.replace(/\D/g, "").replace(/^00/, "");
  if (digits.length === 0) return trimmed;
  if (hadPlus) return `+${digits}`;

  const fromDigits = fromNumber.replace(/\D/g, "");
  if (digits.length < fromDigits.length) {
    const countryCode = fromDigits.slice(0, fromDigits.length - digits.length);
    return `+${countryCode}${digits}`;
  }
  return `+${digits}`;
}

/**
 * How long a `requestUuid` is remembered as "this call has not been
 * answered yet". Comfortably longer than any ring timeout (the
 * campaign's is 35s, Plivo's own default is 120s), short enough that
 * the map cannot grow without bound on a long-running process.
 */
const REQUEST_UUID_TTL_MS = 10 * 60 * 1000;

/**
 * Appends the session id to the configured answer URL.
 *
 * WHY, and it is the difference between Plivo working for campaigns
 * and not working at all:
 *
 * `PLIVO_ANSWER_URL` is ONE static URL shared by every call, so the
 * webhook it fires cannot say which session it belongs to. That was
 * previously resolved by `server/pending-call.ts`, a single-slot
 * process-global FIFO whose own header states the assumption it was
 * built on — "the Dashboard only ever runs one active call at a time".
 * A campaign runs several concurrently, and each `registerPendingCall`
 * clears the queue, so concurrent calls would claim each other's
 * sessions or find none and be answered with `<Hangup/>`.
 *
 * Carrying the session id on the URL removes the shared state
 * entirely, exactly as the Vobiz provider already does. Plivo's REST
 * API takes the answer URL PER CALL — it is the third argument to
 * `calls.create` — so this needs no account or Application change.
 *
 * An existing query string is preserved rather than clobbered, so an
 * answer URL that already carries parameters keeps them.
 */
export function withSessionId(answerUrl: string, sessionId: string): string {
  const separator = answerUrl.includes("?") ? "&" : "?";
  return `${answerUrl}${separator}sessionId=${encodeURIComponent(sessionId)}`;
}

export class PlivoTelephonyProvider implements TelephonyProvider {
  readonly descriptor: ProviderDescriptor = {
    category: ProviderCategory.TELEPHONY,
    id: TELEPHONY_PROVIDER_IDS.PLIVO,
    displayName: "Plivo",
    supportedLanguages: [SupportedLanguage.ENGLISH, SupportedLanguage.HINDI, SupportedLanguage.HINGLISH],
    version: "node-sdk",
  };

  private readonly client: PlivoClient;
  private readonly config: PlivoEnvConfig;

  /**
   * `requestUuid`s this provider has issued that have not been
   * superseded by a CallUUID, with the time they were issued.
   *
   * Exists only so `endCall` can tell the two identifiers apart — see
   * there. Pruned on every `startCall`, so a process that runs for
   * weeks does not accumulate entries for calls that ended long ago.
   */
  private readonly pendingRequestUuids = new Map<string, number>();

  constructor(config: PlivoEnvConfig = loadEnvConfig()) {
    this.config = config;
    this.client = new PlivoClient(config.authId, config.authToken);
  }

  /**
   * Starts server-side recording for an ALREADY-ANSWERED call.
   *
   * IMPORTANT: this needs the CallUUID, NOT the `requestUuid` that
   * `startCall()` returns. The two are different identifiers — the
   * CallUUID only exists once the callee actually answers, so it is
   * only available from the Answer-URL webhook payload. That webhook
   * (`/api/voice/plivo/answer`) is what calls this method.
   *
   * Recording is deliberately NOT expressed in the Answer XML:
   * it is not an attribute of `<Stream>` (a `record="true"` there is
   * silently ignored), it is this separate REST call
   * (POST .../Call/{call_uuid}/Record/). The `<Stream>` verb the call
   * depends on is left exactly as it was.
   */
  async startRecording(callUuid: string): Promise<void> {
    // The SDK rewrites request params camelCase -> snake_case and
    // response keys snake_case -> camelCase (see `camelCaseRequestWrapper`),
    // so `timeLimit` goes out as `time_limit` and Plivo's `recording_id`
    // comes back as `recordingId`. Rejects on a non-2xx, which is what
    // the caller's catch is for.
    const response = (await this.client.calls.record(callUuid, {
      fileFormat: "mp3",
      timeLimit: PLIVO_RECORDING_TIME_LIMIT_SECONDS,
    })) as { recordingId?: string; url?: string };

    // eslint-disable-next-line no-console
    console.log(
      `[Plivo] recording started: call_uuid=${callUuid} recording_id=${response.recordingId ?? "n/a"} url=${response.url ?? "n/a"}`,
    );
  }

 async startCall(
  params: TelephonyCallParams,
): Promise<TelephonyCallHandle> {
    if (!params.destinationNumber) {
      throw new Error(
        `Plivo telephony provider requires "destinationNumber" to start a call for session "${params.sessionId}".`,
      );
    }

    // The caller id goes through the same normalizer as the dialled
    // number. `PLIVO_FROM_NUMBER` is read verbatim from the process
    // environment, and a value pasted into a hosting provider's env
    // editor (or written by a CRLF-terminated env file) keeps its
    // trailing "\n"/"\r". Plivo rejects that with
    //   400 from parameter +918031452733\n is not a valid number
    // — and because the control character is invisible once the
    // message is printed, the error reads as though a perfectly valid,
    // account-owned number had been refused. A leading/trailing SPACE
    // is accepted by Plivo; only the line terminators are fatal.
    const fromNumber = toE164(this.config.fromNumber, this.config.fromNumber);
    const destination = toE164(params.destinationNumber, fromNumber);

    // Values are JSON-quoted so any stray whitespace is visible in logs.
    // eslint-disable-next-line no-console
    console.log(
      `[Plivo] startCall:\n  sessionId=${params.sessionId}\n  from=${JSON.stringify(fromNumber)} (raw=${JSON.stringify(
        this.config.fromNumber,
      )})\n  to=${JSON.stringify(destination)} (raw=${JSON.stringify(params.destinationNumber)})\n  answerUrl=${JSON.stringify(
        this.config.answerUrl,
      )}`,
    );

    const startedAt = Date.now();
    let response: Awaited<ReturnType<PlivoClient["calls"]["create"]>>;
    try {
      response = await this.client.calls.create(
        fromNumber,
        destination,
        // PER-CALL answer URL, carrying this session's id — see
        // `withSessionId`. This is the argument that makes concurrent
        // campaign calls correlate correctly; it is passed on the call
        // itself, so no Plivo Application setting changes.
        withSessionId(this.config.answerUrl, params.sessionId),
      );
    } catch (error) {
      const details = error as { status?: number; statusText?: string; moreInfo?: string };
      // eslint-disable-next-line no-console
      console.error(
        `[Plivo] calls.create FAILED\n  name=${error instanceof Error ? error.name : typeof error}\n  message=${
          error instanceof Error ? error.message : String(error)
        }\n  status=${details.status ?? "n/a"} ${details.statusText ?? ""}\n  body=${details.moreInfo ?? "n/a"}\n  elapsedMs=${
          Date.now() - startedAt
        }`,
      );
      throw error;
    }

    // eslint-disable-next-line no-console
    console.log(`[Plivo] calls.create OK in ${Date.now() - startedAt}ms`);

    const providerCallId = Array.isArray(response.requestUuid)
      ? response.requestUuid[0]
      : response.requestUuid;

    if (!providerCallId) {
      throw new Error(
        `Plivo did not return a requestUuid for the call placed in session "${params.sessionId}".`,
      );
    }

    // Remembered so `endCall` can tell a not-yet-answered call from a
    // live one. Pruned here rather than on a timer: the map only grows
    // when a call is placed, so that is the only moment it can need it.
    const now = Date.now();
    for (const [uuid, issuedAt] of this.pendingRequestUuids) {
      if (now - issuedAt > REQUEST_UUID_TTL_MS) this.pendingRequestUuids.delete(uuid);
    }
    this.pendingRequestUuids.set(providerCallId, now);

    return {
      sessionId: params.sessionId,
      providerCallId,
    };
  }

  /**
   * Ends a call, using the identifier Plivo expects for the state the
   * call is actually in.
   *
   * THE TWO IDENTIFIERS ARE NOT INTERCHANGEABLE, and treating them as
   * one was a real defect on this path — the same one already fixed for
   * Vobiz (see `vobiz-call-control-tests.ts`):
   *
   *   requestUuid  returned by `calls.create`. Exists from the moment
   *                the call is PLACED. Cancelled with
   *                `calls.cancel` -> DELETE /Request/{request_uuid}/
   *   CallUUID     exists only once the callee ANSWERS. Hung up with
   *                `calls.hangup` -> DELETE /Call/{call_uuid}/
   *
   * This method previously always called `hangup` with whatever the
   * handle carried, and the handle carried the `requestUuid` — so every
   * programmatic hangup was a DELETE on a /Call/ id that does not
   * exist. Plivo answered 404, the session manager's `.catch()`
   * swallowed it, and because the answer XML sets
   * `keepCallAlive="true"` the carrier leg stayed up until the person
   * hung up by themselves. Every campaign ending — the closing line,
   * the final-answer hangup, the silence and duration watchdogs —
   * failed this way.
   *
   * The handle is re-keyed to the CallUUID by the media bridge the
   * moment the stream opens (`manager.setProviderCallId`), so by the
   * time a conversation can end, `providerCallId` is the CallUUID and
   * `hangup` is correct. The `cancel` branch covers the other case,
   * which is just as real: a ring timeout ends a call that was never
   * answered, and there `requestUuid` is still all that exists.
   */
  async endCall(handle: TelephonyCallHandle): Promise<void> {
    const id = handle.providerCallId;
    const neverAnswered = this.pendingRequestUuids.has(id);
    this.pendingRequestUuids.delete(id);

    // eslint-disable-next-line no-console
    console.log(
      `[Plivo] endCall: ${neverAnswered ? `cancelling unanswered request_uuid=${id}` : `hanging up call_uuid=${id}`}`,
    );

    if (neverAnswered) {
      await this.client.calls.cancel(id);
      return;
    }
    await this.client.calls.hangup(id);
  }

  async checkHealth(): Promise<ProviderHealthStatus> {
    return probeHealth(this.descriptor, async () => {
      await this.client.accounts.get();
    });
  }
}

