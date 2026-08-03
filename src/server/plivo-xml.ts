/**
 * plivo-xml.ts
 *
 * Builds the Plivo Answer-URL XML response. Plivo's REST Call API
 * (already used, unmodified, by `PlivoTelephonyProvider.startCall`)
 * requires an `answerUrl` that Plivo's servers fetch once the callee
 * picks up; the XML returned from that URL tells Plivo what to do
 * with the call. Here that is exactly one verb: open a bidirectional
 * Media Stream WebSocket back to this application so real-time audio
 * can flow both ways.
 */

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildStreamAnswerXml(streamWsUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000">${escapeXml(
    streamWsUrl,
  )}</Stream>
</Response>`;
}
