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

 async startCall(params: TelephonyCallParams): Promise<{ sessionId: string; providerCallId: string }> {
  if (!params.destinationNumber) {
    throw new Error(
      `Plivo telephony provider requires "destinationNumber" to start a call for session "${params.sessionId}".`,
    );
  }

  console.log(
    `[plivo] startCall: from=${this.config.fromNumber} destination=${params.destinationNumber} answerUrl=${this.config.answerUrl}`,
  );

  try {
    const response = await this.client.calls.create(
      this.config.fromNumber,
      params.destinationNumber,
      this.config.answerUrl,
    );

    console.log(
      `[plivo] calls.create succeeded: requestUuid=${JSON.stringify(response.requestUuid)}`,
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
  } catch (error) {
    console.error(
      `[plivo] calls.create FAILED:`,
      error,
    );

    throw error;
  }
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
