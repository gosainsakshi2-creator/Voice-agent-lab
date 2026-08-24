/**
 * server.ts
 *
 * Next.js App Router API routes run on a request/response model and
 * cannot terminate a long-lived WebSocket upgrade. Plivo's Media
 * Stream, however, IS a WebSocket. This custom server is the
 * smallest possible bridge: it delegates every normal HTTP request
 * to Next exactly as `next start`/`next dev` would, and additionally
 * handles the one `Upgrade: websocket` path Plivo needs
 * (`/api/voice/plivo/stream`), wiring each connection to
 * `attachPlivoMediaBridge`. A second path (`/api/voice/vobiz/stream`)
 * is handled identically for Vobiz calls via `attachVobizMediaBridge`.
 *
 * Nothing in the Dashboard, VoiceSessionManager, or Provider Layer
 * changes because of this file — it only changes how the process is
 * started (`next dev` -> `tsx server.ts`).
 */
import "dotenv/config";
import { createServer, type IncomingMessage } from "node:http";
import { parse } from "node:url";
import next from "next";
import { WebSocketServer, type WebSocket } from "ws";

import { getRuntime } from "./src/server/runtime";
import { installHttpKeepAlive } from "./src/server/http-keepalive";
import { attachPlivoMediaBridge } from "./src/server/plivo-media-bridge";
import { attachVobizMediaBridge } from "./src/server/vobiz-media-bridge";
import type { SessionId } from "./src/types/session.types";

const dev = process.env.NODE_ENV !== "production";
const hostname = "localhost";
const port = Number(process.env.PORT ?? 3000);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

const PLIVO_STREAM_PATH = "/api/voice/plivo/stream";
const VOBIZ_STREAM_PATH = "/api/voice/vobiz/stream";

async function main(): Promise<void> {
  // Before any vendor request can happen: extend the global fetch
  // pool's keep-alive so LLM/TTS connections survive the inter-turn
  // gap instead of paying a fresh TLS setup on every reply.
  installHttpKeepAlive();
  await app.prepare();

  const server = createServer(async (req, res) => {
    const parsedUrl = parse(req.url ?? "", true);
    await handle(req, res, parsedUrl);
  });

  const wss = new WebSocketServer({ noServer: true });
  const nextUpgradeHandler = app.getUpgradeHandler();

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const { pathname, query } = parse(req.url ?? "", true);
    // eslint-disable-next-line no-console
    console.log(`[ws-upgrade] request for pathname="${pathname}"`);

    // Determine which telephony bridge to use based on the path.
    // Each telephony provider has its own stream path so the same
    // server handles both without any provider-specific branching
    // elsewhere — adding a third provider means one more entry here.
    const bridgeForPath: Record<string, (ws: WebSocket, sid: SessionId, mgr: ReturnType<typeof getRuntime>["manager"]) => void> = {
      [PLIVO_STREAM_PATH]: attachPlivoMediaBridge,
      [VOBIZ_STREAM_PATH]: attachVobizMediaBridge,
    };

    const attachBridge = pathname ? bridgeForPath[pathname] : undefined;
    if (!attachBridge) {
      // Not a telephony stream path — let Next.js handle (HMR, etc.).
      nextUpgradeHandler(req, socket, head);
      return;
    }

    const sessionId = Array.isArray(query.sessionId) ? query.sessionId[0] : query.sessionId;
    if (!sessionId) {
      // eslint-disable-next-line no-console
      console.log(`[ws-upgrade] stream path hit but no sessionId in query string -> destroying socket`);
      socket.destroy();
      return;
    }

    // eslint-disable-next-line no-console
    console.log(`[ws-upgrade] upgrading media stream for sessionId="${sessionId}" on path="${pathname}"`);
    wss.handleUpgrade(req, req.socket, head, (ws: WebSocket) => {
      const { manager } = getRuntime();
      attachBridge(ws, sessionId as SessionId, manager);
    });
  });

  // Graceful shutdown.
  //
  // Node's default SIGTERM behaviour kills the process outright, which
  // leaves this instance's database sessions half-open. Supabase's
  // pooler keeps counting those against its per-tenant client limit
  // until its own TCP timeout, so the *next* instance can be refused
  // with `EMAXCONNSESSION` even though this one is already gone —
  // which is why a plain restart does not clear the condition.
  //
  // Closing the listeners and then the pool releases the slots
  // deterministically. Nothing about session, campaign or telephony
  // behaviour changes: the process was terminating either way.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(`> ${signal} received — closing listeners and database pool`);

    server.close();
    wss.close();

    try {
      const { closeDbPool } = await import("./src/campaign/db/client");
      await closeDbPool();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`> database pool close failed: ${(error as Error).message}`);
    }

    process.exit(0);
  };

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`> Voice Agent Lab ready on http://localhost:${port} (dev=${dev})`);
    // eslint-disable-next-line no-console
    console.log(`> Plivo Media Stream endpoint: ws(s)://<APP_PUBLIC_BASE_URL>${PLIVO_STREAM_PATH}`);
    // eslint-disable-next-line no-console
    console.log(`> Vobiz Media Stream endpoint: ws(s)://<APP_PUBLIC_BASE_URL>${VOBIZ_STREAM_PATH}`);
  });
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Fatal error starting server:", error);
  process.exit(1);
});