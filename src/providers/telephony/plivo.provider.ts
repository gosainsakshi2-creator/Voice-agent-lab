/**
 * plivo.provider.ts
 *
 * Concrete `TelephonyProvider` implementation backed by Plivo's
 * official Node.js SDK (`plivo`). Satisfies the existing
 * `TelephonyProvider` contract exactly — the `VoiceSessionManager`
 * never imports this file directly; it is resolved through the
 * `ProviderRegistry` by `ProviderIdentifier`.
 *
 * Scope note: this adapter only places/ends calls via Plivo's REST
 * Call API. Answer-URL/XML webhook handling, media streaming, and
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

  constructor(config: PlivoEnvConfig = loadEnvConfig()) {
    this.config = config;
    this.client = new PlivoClient(config.authId, config.authToken);
  }

  async startCall(params: TelephonyCallParams): Promise<TelephonyCallHandle> {
    if (!params.destinationNumber) {
      throw new Error(
        `Plivo telephony provider requires "destinationNumber" to start a call for session "${params.sessionId}".`,
      );
    }

    // Diagnostic logging only — the call itself is unchanged.
    //
    // `JSON.stringify` (rather than plain interpolation) is deliberate
    // for the two phone numbers: it makes stray whitespace and the
    // unedited `"+91 xxxxxxxxxx"` placeholder visible in the logs,
    // which bare interpolation hides. Plivo requires bare E.164.
    // eslint-disable-next-line no-console
    console.log(
      `[Plivo] calls.create request: session=${params.sessionId} ` +
        `from=${JSON.stringify(this.config.fromNumber)} ` +
        `to=${JSON.stringify(params.destinationNumber)} ` +
        `answerUrl=${this.config.answerUrl}`,
    );

    const startedAt = Date.now();
    // `.catch` that rethrows, rather than try/catch, so `response`
    // stays a `const` with its inferred `CreateCallResponse` type.
    const response = await this.client.calls.create(
      this.config.fromNumber,
      params.destinationNumber,
      this.config.answerUrl,
    ).catch((error: unknown) => {
      // The SDK rejects with `error.stack` — a STRING, not an Error —
      // on transport-level failures (see plivo/dist/rest/axios.js), so
      // `typeof` and `String()` are logged instead of `.message`, which
      // would be `undefined` in exactly the case we care about.
      // Elapsed time discriminates the failure mode: ~0-500ms is
      // client-side/API validation, ~5000ms is the SDK's voice-request
      // timeout, longer means retries were exhausted.
      // eslint-disable-next-line no-console
      console.error(
        `[Plivo] calls.create FAILED after ${Date.now() - startedAt}ms: ` +
          `typeof=${typeof error} ` +
          `name=${(error as { constructor?: { name?: string } })?.constructor?.name ?? "n/a"} ` +
          `value=${String(error)}`,
      );
      throw error;
    });

    // eslint-disable-next-line no-console
    console.log(
      `[Plivo] calls.create OK in ${Date.now() - startedAt}ms: ${JSON.stringify(response)}`,
    );

    const providerCallId = Array.isArray(response.requestUuid)
      ? response.requestUuid[0]
      : response.requestUuid;

    if (!providerCallId) {
      throw new Error(
        `Plivo did not return a requestUuid for the call placed in session "${params.sessionId}".`,
      );
    }

    return {
      sessionId: params.sessionId,
      providerCallId,
    };
  }

  async endCall(handle: TelephonyCallHandle): Promise<void> {
    await this.client.calls.hangup(handle.providerCallId);
  }

  async checkHealth(): Promise<ProviderHealthStatus> {
    return probeHealth(this.descriptor, async () => {
      await this.client.accounts.get();
    });
  }
}
