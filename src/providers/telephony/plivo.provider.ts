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

 async startCall(
  params: TelephonyCallParams,
): Promise<TelephonyCallHandle> {
    if (!params.destinationNumber) {
      throw new Error(
        `Plivo telephony provider requires "destinationNumber" to start a call for session "${params.sessionId}".`,
      );
    }

    const destination = toE164(params.destinationNumber, this.config.fromNumber);

    // eslint-disable-next-line no-console
    console.log(
      `[Plivo] startCall:\n  sessionId=${params.sessionId}\n  from=${this.config.fromNumber}\n  to=${destination} (raw="${params.destinationNumber}")\n  answerUrl=${this.config.answerUrl}`,
    );

    const startedAt = Date.now();
    let response: Awaited<ReturnType<PlivoClient["calls"]["create"]>>;
    try {
      response = await this.client.calls.create(
        this.config.fromNumber,
        destination,
        this.config.answerUrl,
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

