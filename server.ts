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
 * `attachPlivoMediaBridge`.
 *
 * Nothing in the Dashboard, VoiceSessionManager, or Provider Layer
 * changes because of this file — it only changes how the process is
 * started (`next dev` -> `tsx server.ts`).
 */

import { createServer, type IncomingMessage } from "node:http";
import { parse } from "node:url";
import next from "next";
import { WebSocketServer, type WebSocket } from "ws";

import { getRuntime } from "./src/server/runtime";
import { attachPlivoMediaBridge } from "./src/server/plivo-media-bridge";
import type { SessionId } from "./src/types/session.types";

const dev = process.env.NODE_ENV !== "production";
const hostname = "localhost";
const port = Number(process.env.PORT ?? 3000);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

const STREAM_PATH = "/api/voice/plivo/stream";

async function main(): Promise<void> {
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

    if (pathname !== STREAM_PATH) {
      // Let Next.js handle its own WebSocket upgrades (HMR, etc.).
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
    console.log(`[ws-upgrade] upgrading Plivo media stream for sessionId="${sessionId}"`);
    wss.handleUpgrade(req, req.socket, head, (ws: WebSocket) => {
      const { manager } = getRuntime();
      attachPlivoMediaBridge(ws, sessionId as SessionId, manager);
    });
  });

  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`> Voice Agent Lab ready on http://localhost:${port} (dev=${dev})`);
    // eslint-disable-next-line no-console
    console.log(`> Plivo Media Stream endpoint: ws(s)://<APP_PUBLIC_BASE_URL>${STREAM_PATH}`);
  });
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Fatal error starting server:", error);
  process.exit(1);
});