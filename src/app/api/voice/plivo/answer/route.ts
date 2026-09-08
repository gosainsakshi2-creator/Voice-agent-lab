import { NextResponse } from "next/server";

import { claimPendingSession } from "../../../../../server/pending-call";
import { getPublicWsBaseUrl } from "../../../../../server/public-url";
import { buildStreamAnswerXml } from "../../../../../server/plivo-xml";
import { PlivoTelephonyProvider } from "../../../../../providers/telephony/plivo.provider";

export const dynamic = "force-dynamic";

/**
 * Fire-and-forget: kicks off server-side recording without making the
 * webhook response wait on it.
 *
 * Recording is a separate REST call keyed by the CallUUID (see
 * `PlivoTelephonyProvider.startRecording`), not a `<Stream>` attribute,
 * so it cannot ride along on the XML below. Everything here is
 * therefore deliberately detached: nothing is awaited on the response
 * path, and every failure — including a missing-env throw from
 * constructing the provider — is swallowed after logging. A recording
 * problem can never delay or break the Stream XML the call depends on.
 */
function startRecordingInBackground(callUuid: string | undefined, sessionId: string): void {
  if (!callUuid) {
    // eslint-disable-next-line no-console
    console.warn(
      `[plivo-answer] no CallUUID in webhook payload — recording NOT started for session=${sessionId}`,
    );
    return;
  }

  void (async () => {
    try {
      await new PlivoTelephonyProvider().startRecording(callUuid);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(
        `[plivo-answer] startRecording failed for CallUUID=${callUuid} session=${sessionId}:`,
        error,
      );
    }
  })();
}

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

  // Both the CallUUID and the session are known now, and this webhook
  // is the earliest point at which the CallUUID exists at all. Started
  // after the guard above so the calls we are about to `<Hangup/>` are
  // not recorded. Detached — see `startRecordingInBackground`.
  startRecordingInBackground(callUuid, sessionId);

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