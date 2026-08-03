import { NextResponse } from "next/server";

import { claimPendingSession } from "../../../../../server/pending-call";
import { getPublicWsBaseUrl } from "../../../../../server/public-url";
import { buildStreamAnswerXml } from "../../../../../server/plivo-xml";

export const dynamic = "force-dynamic";

/**
 * Plivo POSTs `application/x-www-form-urlencoded` to the
 * Answer-URL configured on the Provider Layer's `PLIVO_ANSWER_URL`
 * env var once the callee answers. The response body is XML telling
 * Plivo what to do next — here, always "open a bidirectional Media
 * Stream back to this app".
 */
async function respondToAnswer(callUuid: string | undefined): Promise<NextResponse> {
  // eslint-disable-next-line no-console
  console.log(`[plivo-answer] webhook hit, CallUUID="${callUuid}"`);

  const sessionId = claimPendingSession(callUuid);
  if (!sessionId) {
    // eslint-disable-next-line no-console
    console.log(`[plivo-answer] no pending session found for CallUUID="${callUuid}" -> replying <Hangup/>`);
    // No session was waiting — nothing we can bridge this call to.
    // Politely hang up rather than opening an orphaned stream.
    return new NextResponse(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`,
      { headers: { "Content-Type": "application/xml" } },
    );
  }

  // Session claiming happens here (Plivo only calls this once the
  // callee picks up), but the conversation pipeline itself is NOT
  // started here — see plivo-media-bridge.ts's "start" event handler
  // for why.

  const streamUrl = `${getPublicWsBaseUrl()}/api/voice/plivo/stream?sessionId=${encodeURIComponent(sessionId)}`;
  const xml = buildStreamAnswerXml(streamUrl);
  // eslint-disable-next-line no-console
  console.log(`[plivo-answer] claimed session "${sessionId}" -> replying with Stream XML pointing to ${streamUrl}`);

  return new NextResponse(xml, { headers: { "Content-Type": "application/xml" } });
}

export async function POST(request: Request) {
  const form = await request.formData();
  const callUuid = (form.get("CallUUID") as string | null) ?? undefined;
  return respondToAnswer(callUuid);
}

export async function GET(request: Request) {
  // Plivo's Application "Answer Method" can be configured for GET,
  // in which case CallUUID arrives as a query parameter, not a form
  // body. A GET request has no body, so calling request.formData()
  // here (as a previous version of this handler did by delegating to
  // POST) throws and Next.js returns an empty 500 — Plivo then hangs
  // up the call the instant the callee answers, since it never gets
  // valid Stream XML back.
  const callUuid = new URL(request.url).searchParams.get("CallUUID") ?? undefined;
  return respondToAnswer(callUuid);
}