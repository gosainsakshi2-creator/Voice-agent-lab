/**
 * webhook-auth.ts
 *
 * The telephony answer webhooks and the media WebSockets are reached by
 * the carrier, not by a logged-in operator, so they cannot sit behind the
 * dashboard's login. They were identified by `sessionId` alone, and a
 * session id is a timestamp plus a counter (`sess_<base36 ms>_<n>`):
 * guessable, so anyone could open a live call's audio stream.
 *
 * With `TELEPHONY_WEBHOOK_SECRET` set, every URL we hand the carrier
 * carries `wt=<secret>`, and the answer routes and the WebSocket upgrade
 * refuse a request without it. Unset, nothing changes.
 */

export const WEBHOOK_TOKEN_PARAM = "wt";

function webhookSecret(): string | undefined {
  const secret = process.env.TELEPHONY_WEBHOOK_SECRET?.trim();
  return secret !== undefined && secret.length > 0 ? secret : undefined;
}

/** `url` with the webhook token appended, or unchanged when no secret is configured. */
export function withWebhookToken(url: string): string {
  const secret = webhookSecret();
  if (secret === undefined) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${WEBHOOK_TOKEN_PARAM}=${encodeURIComponent(secret)}`;
}

/** Does this request carry the right token? Always true when no secret is configured. */
export function webhookTokenValid(token: string | null | undefined): boolean {
  const secret = webhookSecret();
  if (secret === undefined) return true;
  return typeof token === "string" && constantTimeEqual(token, secret);
}

/** String comparison whose time does not depend on where the strings first differ. */
export function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
