/**
 * http-keepalive.ts
 *
 * Extends the keep-alive window of Node's GLOBAL fetch pool, so the
 * HTTPS connections to the LLM and TTS vendors survive the quiet gap
 * between two turns of a call instead of being torn down and rebuilt
 * on every reply.
 *
 * ── The defect this fixes ──────────────────────────────────────────
 *
 * Node's built-in fetch (undici) closes an idle connection after
 * 4 SECONDS by default. A phone call's request pattern is a burst of
 * vendor requests per turn (one LLM completion, one TTS synthesis per
 * sentence) followed by 5-30 seconds of silence while the caller
 * talks and the reply plays — always longer than 4s. So EVERY turn's
 * first request to each vendor paid a fresh DNS + TCP + TLS setup on
 * the caller's clock. Production traces show the cost as the gap
 * between a turn's FIRST TTS chunk and the warm chunks that follow
 * it: Cartesia 267ms vs 125-145ms, Smallest AI 429ms vs ~250ms, and
 * a cold Cartesia greeting measured at 1335ms vs 369ms warm.
 *
 * Verified out of process against the real origins (two fetches, 6s
 * apart, socket connects counted via diagnostics_channel):
 *
 *   default    api.openai.com          2 connects  second=465ms
 *   keep-alive api.openai.com          1 connect   second=349ms
 *   default    api.cartesia.ai         2 connects  second=276ms
 *   keep-alive api.cartesia.ai         1 connect   second=191ms
 *   default    waves-api.smallest.ai   2 connects
 *   keep-alive waves-api.smallest.ai   1 connect
 *
 * ── Why ONE global setting covers every vendor ─────────────────────
 *
 * All four HTTP vendors go through global fetch: the OpenAI SDK (v7)
 * and the Cartesia SDK (v3.5) both default to `globalThis.fetch`
 * (verified in their shims), and the Sarvam / Smallest AI adapters
 * call `fetch` directly. Native fetch reads the global dispatcher on
 * every call, and the npm `undici` package (pinned to the same major
 * as the one bundled in Node) registers it under the shared
 * `Symbol.for` key the bundled fetch reads — proven by the connect
 * counts above. So no provider file changes, no per-vendor code, and
 * a vendor added tomorrow is covered automatically.
 *
 * ── Why 30 seconds ─────────────────────────────────────────────────
 *
 * Long enough to cover the ordinary inter-turn gap (caller speech +
 * reply playback), short enough to stay well inside common
 * load-balancer idle timeouts (60s is the usual floor), which keeps
 * the stale-socket race — the server closing a connection we are
 * about to reuse — out of the window we hold sockets for. undici
 * additionally honours a server's own Keep-Alive hint when one is
 * sent, so a vendor that asks for less gets less.
 *
 * ── What this does NOT touch ───────────────────────────────────────
 *
 * WebSocket traffic (Deepgram STT, Sarvam streaming TTS, the
 * telephony media streams) uses the `ws` package, not fetch, and is
 * unaffected. Postgres uses its own TCP pool. Request semantics,
 * payloads, provider behaviour, timing thresholds and turn logic are
 * all byte-identical — this changes connection HYGIENE only.
 */
import { setGlobalDispatcher, Agent } from "undici";

/** Idle sockets now survive the inter-turn gap. Node's default is 4s. */
const KEEP_ALIVE_TIMEOUT_MS = 30_000;
/** Ceiling undici may extend to when a server's own hint allows it. */
const KEEP_ALIVE_MAX_TIMEOUT_MS = 600_000;

/**
 * Installs the extended keep-alive on the global fetch pool. Called
 * once at server boot, before any vendor request. Failure is not
 * fatal: the process simply keeps Node's default 4s behaviour, which
 * is exactly what it did before this file existed.
 */
export function installHttpKeepAlive(): void {
  try {
    setGlobalDispatcher(
      new Agent({
        keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
        keepAliveMaxTimeout: KEEP_ALIVE_MAX_TIMEOUT_MS,
      }),
    );
    // eslint-disable-next-line no-console
    console.log(
      `[http] global fetch keep-alive extended to ${KEEP_ALIVE_TIMEOUT_MS / 1000}s — vendor connections now survive the inter-turn gap`,
    );
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(
      `[http] could not extend fetch keep-alive — continuing with Node defaults: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
