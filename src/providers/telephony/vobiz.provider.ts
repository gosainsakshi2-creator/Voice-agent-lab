/**
 * vobiz.provider.ts
 *
 * Concrete `TelephonyProvider` implementation backed by Vobiz's
 * Voice REST API (https://vobiz.ai/docs).
 *
 * Authentication: header-based `X-Auth-ID` + `X-Auth-Token`
 * (obtained from console.vobiz.ai).
 *
 * Call lifecycle:
 *   1. `startCall()` — POST /api/v1/Account/{auth_id}/Call/
 *      with `from`, `to`, `answer_url`, `answer_method`.
 *      Returns `{ request_uuid }` used as the call handle.
 *
 *   2. Vobiz places the call and, once the callee answers,
 *      fetches the `answer_url`. The server returns VobizXML
 *      with a `<Stream bidirectional="true">` element pointing
 *      at the app's WebSocket endpoint. This triggers the
 *      WebSocket connection handled by `vobiz-media-bridge.ts`.
 *
 *   3. `endCall()` — DELETE /api/v1/Account/{auth_id}/Call/{call_uuid}
 *
 * This provider does NOT implement `openMediaStream` because,
 * like Plivo, the media connection is asynchronous — the WebSocket
 * arrives only after the answer-URL webhook fires. The bridge
 * calls `manager.confirmCallAnswered()` instead.
 */

import { TELEPHONY_PROVIDER_IDS } from "../../constants/providers.constants";
import { ProviderCategory, SupportedLanguage } from "../../types/enums";
import type { ProviderDescriptor, ProviderHealthStatus } from "../../types/provider.types";
import type {
  TelephonyCallHandle,
  TelephonyCallParams,
  TelephonyProvider,
} from "../../interfaces/providers/telephony-provider.interface";
import { probeHealth } from "../shared/health";
import { requireEnv, optionalEnv } from "../shared/env";

interface VobizEnvConfig {
  readonly authId: string;
  readonly authToken: string;
  readonly fromNumber: string;
  readonly baseUrl: string;
  readonly answerUrl: string;
}

function loadEnvConfig(): VobizEnvConfig {
  return {
    authId: requireEnv("VOBIZ_AUTH_ID", TELEPHONY_PROVIDER_IDS.VOBIZ),
    authToken: requireEnv("VOBIZ_AUTH_TOKEN", TELEPHONY_PROVIDER_IDS.VOBIZ),
    fromNumber: requireEnv("VOBIZ_FROM_NUMBER", TELEPHONY_PROVIDER_IDS.VOBIZ),
    baseUrl: optionalEnv("VOBIZ_API_BASE_URL", "https://api.vobiz.ai"),
    answerUrl: requireEnv("VOBIZ_ANSWER_URL", TELEPHONY_PROVIDER_IDS.VOBIZ),
  };
}

interface VobizCallResponse {
  readonly request_uuid?: string;
  readonly api_id?: string;
  readonly error?: string;
  readonly message?: string;
}
private async startRecording(callUuid: string): Promise<void> {
  const { authId, authToken, baseUrl } = this.config;

  const url = `${baseUrl}/api/v1/Account/${authId}/Call/${callUuid}/Record/`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Auth-ID": authId,
      "X-Auth-Token": authToken,
    },
    body: JSON.stringify({
      file_format: "mp3",
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "(no body)");
    throw new Error(
      `[Vobiz] startRecording failed: HTTP ${response.status} — ${body}`,
    );
  }

  const result = await response.json();

  console.log(
    `[Vobiz] recording started: call_uuid=${callUuid} recording_id=${result.recording_id ?? "n/a"}`,
  );
}
export class VobizTelephonyProvider implements TelephonyProvider {
  readonly descriptor: ProviderDescriptor = {
    category: ProviderCategory.TELEPHONY,
    id: TELEPHONY_PROVIDER_IDS.VOBIZ,
    displayName: "Vobiz",
    supportedLanguages: [
      SupportedLanguage.ENGLISH,
      SupportedLanguage.HINDI,
      SupportedLanguage.HINGLISH,
    ],
    version: "v1",
  };

  private readonly config: VobizEnvConfig;

  constructor(config: VobizEnvConfig = loadEnvConfig()) {
    this.config = config;
  }

  async startCall(params: TelephonyCallParams): Promise<TelephonyCallHandle> {
    const { authId, authToken, baseUrl, fromNumber, answerUrl } = this.config;
    const destination = params.destinationNumber;
    if (!destination) {
      throw new Error(
        `Vobiz telephony provider requires "destinationNumber" to start a call for session "${params.sessionId}".`,
      );
    }

    // The answer_url includes the sessionId so the webhook handler
    // knows which session to wire the WebSocket stream to.
    const answerUrlWithSession = `${answerUrl}?sessionId=${encodeURIComponent(params.sessionId)}`;

    // eslint-disable-next-line no-console
    console.log(
      `[Vobiz] startCall: session=${params.sessionId} from=${fromNumber} to=${destination}`,
    );

    const url = `${baseUrl}/api/v1/Account/${authId}/Call/`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Auth-ID": authId,
        "X-Auth-Token": authToken,
      },
      body: JSON.stringify({
        from: fromNumber,
        to: destination,
        answer_url: answerUrlWithSession,
        answer_method: "POST",
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "(no body)");
      throw new Error(`[Vobiz] startCall failed: HTTP ${response.status} — ${body}`);
    }

    const result: VobizCallResponse = await response.json();

    if (!result.request_uuid) {
      throw new Error(
        `[Vobiz] startCall succeeded (HTTP 2xx) but no request_uuid in response: ${JSON.stringify(result)}`,
      );
    }

    // eslint-disable-next-line no-console
    console.log(
      `[Vobiz] call placed: request_uuid=${result.request_uuid} api_id=${result.api_id ?? "n/a"}`,
    );

    return {
      sessionId: params.sessionId,
      providerCallId: result.request_uuid,
    };
  }

  async endCall(handle: TelephonyCallHandle): Promise<void> {
    const { authId, authToken, baseUrl } = this.config;
    const callUuid = handle.providerCallId;

    // eslint-disable-next-line no-console
    console.log(`[Vobiz] endCall: call_uuid=${callUuid}`);

    const url = `${baseUrl}/api/v1/Account/${authId}/Call/${callUuid}/`;
    const response = await fetch(url, {
      method: "DELETE",
      headers: {
        "X-Auth-ID": authId,
        "X-Auth-Token": authToken,
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "(no body)");
      // eslint-disable-next-line no-console
      console.warn(`[Vobiz] endCall: HTTP ${response.status} — ${body} (call may already have ended)`);
    }
  }

  async checkHealth(): Promise<ProviderHealthStatus> {
    return probeHealth(this.descriptor, async () => {
      // Lightweight probe: hit the credential-verification endpoint
      // documented at https://vobiz.ai/docs/api-reference/authentication
      // — returns the full account object on success, confirming
      // both auth_id and auth_token are valid.
      const { authId, authToken, baseUrl } = this.config;
      const url = `${baseUrl}/api/v1/auth/me`;
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "X-Auth-ID": authId,
          "X-Auth-Token": authToken,
        },
      });
      if (!response.ok) {
        throw new Error(`Vobiz health check failed: HTTP ${response.status}`);
      }
    });
  }
}
