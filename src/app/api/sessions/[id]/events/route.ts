import { getRuntime } from "../../../../../server/runtime";
import type { SessionId } from "../../../../../types/session.types";

export const dynamic = "force-dynamic";

/**
 * Streams a JSON snapshot { session, transcript, metrics } every
 * time the session transitions state (LISTENING -> THINKING ->
 * SPEAKING -> ... is exactly one transition per turn boundary,
 * which is a good enough cadence for "live" without polling). A
 * heartbeat keeps intermediate proxies from closing the connection.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { manager } = getRuntime();
  const { id } = await params;
  const sessionId = id as SessionId;

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const send = async (): Promise<void> => {
        if (closed) return;
        try {
          const [session, metrics] = await Promise.all([
            manager.getSnapshot(sessionId),
            manager.getBenchmarkMetrics(sessionId),
          ]);
          const transcript = manager.getTranscript(sessionId);
          const payload = JSON.stringify({ session, transcript, metrics });
          controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        } catch {
          // Session not found yet / already gone — skip this tick.
        }
      };

      void send();

      unsubscribe = manager.onStateChange((eventSessionId) => {
        if (eventSessionId === sessionId) void send();
      });

      heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(`: ping\n\n`));
      }, 15_000);

      const onAbort = () => {
        closed = true;
        unsubscribe?.();
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      request.signal.addEventListener("abort", onAbort);
    },
    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
