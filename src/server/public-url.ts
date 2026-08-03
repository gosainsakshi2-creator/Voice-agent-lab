/**
 * public-url.ts
 *
 * Plivo's <Stream> verb requires a fully-qualified `wss://` URL — it
 * cannot resolve a relative path the way a browser can. `APP_PUBLIC_BASE_URL`
 * is the one new environment variable this integration layer
 * introduces (e.g. your render URL in development, or your
 * deployed domain in production); see `.env.example`.
 */

export function getPublicHttpBaseUrl(): string {
  const base = process.env.APP_PUBLIC_BASE_URL;
  if (!base) {
    throw new Error(
      "APP_PUBLIC_BASE_URL is not set. It must be a publicly reachable https URL " +
        "(e.g. your render tunnel or deployed domain) so Plivo can reach the Answer-URL " +
        "webhook and open the Media Stream WebSocket back to this app.",
    );
  }
  return base.replace(/\/+$/, "");
}

export function getPublicWsBaseUrl(): string {
  return getPublicHttpBaseUrl().replace(/^https:/, "wss:").replace(/^http:/, "ws:");
}
