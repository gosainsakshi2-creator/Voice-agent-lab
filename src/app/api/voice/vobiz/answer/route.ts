/**
 * route.ts — Vobiz Answer-URL webhook handler
 *
 * When Vobiz places an outbound call and the callee answers,
 * Vobiz fetches the `answer_url` provided in the startCall request.
 * This handler returns VobizXML instructing Vobiz to open a
 * bidirectional WebSocket audio stream to the app's Vobiz stream
 * endpoint (`/api/voice/vobiz/stream?sessionId=...`).
 *
 * This mirrors what the existing Plivo answer-URL route does —
 * the only differences are the XML dialect (VobizXML vs PlivoXML)
 * and the stream URL path.
 *
 * ---------------------------------------------------------------
 * XML returned:
 *   <Response>
 *     <Stream bidirectional="true"
 *            contentType="audio/x-mulaw;rate=8000"
 *            keepCallAlive="true">
 *       wss://{APP_PUBLIC_BASE_URL}/api/voice/vobiz/stream?sessionId={sessionId}
 *     </Stream>
 *   </Response>
 *
 * `contentType="audio/x-mulaw;rate=8000"` configures the INBOUND
 * direction — Vobiz will send caller audio as G.711 mu-law at 8kHz,
 * which the MulawVadSegmenter in the bridge already understands.
 * The OUTBOUND direction (playAudio) is independent and uses L16
 * at the TTS provider's native rate — configured in the bridge, not
 * in this XML.
 * ---------------------------------------------------------------
 * RECORDING
 *
 * Recording is NOT an attribute of `<Stream>` — a `record="true"`
 * attribute there is silently ignored. It is a separate REST call
 * (POST .../Call/{call_uuid}/Record/) which needs the call_uuid.
 * The call_uuid only exists once the callee has answered, and this
 * webhook is the first place it is available, so recording is
 * kicked off from here — fire-and-forget, so a recording failure
 * can never delay or break the Stream XML the call depends on.
 * ---------------------------------------------------------------
 */

import { type NextRequest, NextResponse } from "next/server";

import { VobizTelephonyProvider } from "../../../../../providers/telephony/vobiz.provider";

/**
 * The public-facing base URL of this app (e.g. https://voice.example.com).
 * Used to construct the absolute WebSocket URL Vobiz will connect to.
 * Must NOT include a trailing slash.
 */
function getPublicBaseUrl(): string {
  const base = process.env.APP_PUBLIC_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "";
  return base.replace(/\/+$/, "");
}

function buildStreamXml(sessionId: string): string {
  const base = getPublicBaseUrl();
  // Replace http(s):// with ws(s)://
  const wsBase = base.replace(/^http/, "ws");
  const streamUrl = `${wsBase}/api/voice/vobiz/stream?sessionId=${encodeURIComponent(sessionId)}`;

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    `  <Stream bidirectional="true" contentType="audio/x-mulaw;rate=8000" keepCallAlive="true">`,
    `    ${streamUrl}`,
    "  </Stream>",
    "</Response>",
  ].join("\n");
}

/** Vobiz spells this differently depending on transport, so accept the known variants. */
const CALL_UUID_KEYS = ["CallUUID", "call_uuid", "CallUuid", "calluuid"] as const;

function pickCallUuid(get: (key: string) => string | null): string | undefined {
  for (const key of CALL_UUID_KEYS) {
    const value = get(key);
    if (value) return value;
  }
  return undefined;
}

/**
 * Reads the call_uuid out of the webhook. POST bodies are
 * form-encoded (same as Plivo); the query string is the fallback.
 * Never throws — a missing/unreadable body must not break the call.
 */
async function extractCallUuid(request: NextRequest): Promise<string | undefined> {
  const params = new URL(request.url).searchParams;
  const fromQuery = pickCallUuid((key) => params.get(key));
  if (fromQuery) return fromQuery;

  if (request.method !== "POST") return undefined;

  try {
    const form = await request.formData();
    return pickCallUuid((key) => form.get(key) as string | null);
  } catch {
    return undefined;
  }
}

/**
 * Fire-and-forget: kicks off server-side recording without making
 * the webhook response wait on it.
 */
function startRecordingInBackground(callUuid: string | undefined, sessionId: string): void {
  if (!callUuid) {
    // eslint-disable-next-line no-console
    console.warn(
      `[vobiz-answer] no call_uuid in webhook payload — recording NOT started for session=${sessionId}`,
    );
    return;
  }

  void (async () => {
    try {
      await new VobizTelephonyProvider().startRecording(callUuid);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(
        `[vobiz-answer] startRecording failed for call_uuid=${callUuid} session=${sessionId}:`,
        error,
      );
    }
  })();
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId");

  if (!sessionId) {
    // eslint-disable-next-line no-console
    console.error("[vobiz-answer] No sessionId in query string");
    return new NextResponse(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup /></Response>',
      { status: 200, headers: { "Content-Type": "application/xml" } },
    );
  }

  const callUuid = await extractCallUuid(request);
  startRecordingInBackground(callUuid, sessionId);

  const xml = buildStreamXml(sessionId);
  // eslint-disable-next-line no-console
  console.log(
    `[vobiz-answer] sessionId=${sessionId} call_uuid=${callUuid ?? "n/a"} -> returning Stream XML`,
  );

  return new NextResponse(xml, {
    status: 200,
    headers: { "Content-Type": "application/xml" },
  });
}

// Vobiz may use GET depending on the answer_method config
export async function GET(request: NextRequest): Promise<NextResponse> {
  return POST(request);
}
