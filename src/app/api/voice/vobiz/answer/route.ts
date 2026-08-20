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
 *            record="true"
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
 */

import { type NextRequest, NextResponse } from "next/server";

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
    `  <Stream bidirectional="true" record="true" contentType="audio/x-mulaw;rate=8000" keepCallAlive="true">`,
    `    ${streamUrl}`,
    "  </Stream>",
    "</Response>",
  ].join("\n");
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

  const xml = buildStreamXml(sessionId);
  // eslint-disable-next-line no-console
  console.log(`[vobiz-answer] sessionId=${sessionId} -> returning Stream XML`);

  return new NextResponse(xml, {
    status: 200,
    headers: { "Content-Type": "application/xml" },
  });
}

// Vobiz may use GET depending on the answer_method config
export async function GET(request: NextRequest): Promise<NextResponse> {
  return POST(request);
}
