/**
 * sarvam-stream-tests.ts — `npm run test:sarvam-stream`
 *
 * HOW A SARVAM UTTERANCE ENDS, AND THE TRUNCATION THAT ENDED WHEN IT
 * WAS READ FROM THE PROTOCOL INSTEAD OF INFERRED FROM SILENCE.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────
 *
 * Sarvam's WebSocket TTS sends no end-of-utterance marker BY DEFAULT.
 * The streaming WAV header declares `0xFFFFFFFF` for both sizes and the
 * server never closes, so for a long time completion here was inferred
 * from an idle gap — first fixed (700ms), then adaptive (300-1200ms,
 * sized from the frame cadence and the delivery quantum). Every version
 * of that inference had the same flaw: the vendor's generation rate is
 * not bounded below by real time. Measured live, a healthy 68-character
 * utterance paused 786ms mid-stream and then finished; under a 550, 672
 * or 700ms budget that utterance is declared over and the rest of the
 * sentence is discarded. Those three numbers are exactly what the live
 * call logs showed at each truncation.
 *
 * ── THE SIGNAL ─────────────────────────────────────────────────────
 *
 * The marker exists; it is opt-in. With `send_completion_event=true` on
 * the connection url the server follows the last audio frame with
 * `{type:"event", data:{event_type:"final"}}`. Live, 22/22 completed
 * utterances (8-201 chars, cold and after a 3s virgin idle): the event
 * arrived 0-2ms after the final frame, never before it, never followed
 * by audio. `synthesizeStream` now completes on that event and on
 * nothing else. Silence after the first frame is no longer completion;
 * it is only bounded — at `COMPLETION_EVENT_FALLBACK_MS` (2000ms) — for
 * the vendor-fault case where the stream is dropped and `final` never
 * comes (observed once in 34 live runs).
 *
 * ── HOW THIS SUITE TESTS IT ────────────────────────────────────────
 *
 * Against the REAL `SarvamTextToSpeechProvider`, over a REAL WebSocket,
 * to a LOCAL fake Sarvam server on 127.0.0.1 whose frame schedule each
 * test writes — and which sends the `final` event exactly as the live
 * vendor does, unless a test turns it off to exercise the fallback.
 * Nothing here contacts Sarvam, places a call, reads the database or
 * touches Google. The provider's socket handling, RIFF stripping, parity
 * guard, abort path, REST fallback, warm-socket lifecycle and completion
 * logic are all the shipped code.
 *
 * `A1` and `A7` keep the retired budget rule as a pure function and
 * assert their schedules WOULD have truncated under it, so the suite
 * cannot quietly stop reproducing the defect it exists for. Section F is
 * the completion-event contract itself.
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import type { AddressInfo } from "node:net";

const { SarvamTextToSpeechProvider } = await import(
  "../../providers/text-to-speech/sarvam.provider"
);
const { estimateTtsCost } = await import("../../core/session/cost-estimator");
const { TEXT_TO_SPEECH_PROVIDER_IDS } = await import("../../constants/providers.constants");
const { SupportedLanguage } = await import("../../types/enums");

import type { SynthesisTaskRequest } from "../../interfaces/providers/text-to-speech-provider.interface";
import type { TtsAudioChunk } from "../../types/streaming.types";
import type { SessionId } from "../../types/session.types";

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  [FAIL] ${name}`);
    console.log(
      `         ${(error instanceof Error ? error.message : String(error)).split("\n").slice(0, 8).join("\n         ")}`,
    );
  }
}

const section = (t: string) => console.log(`\n${t}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ═════════════════════════════════════════════════════════════════
// THE VENDOR'S MEASURED SHAPE
// ═════════════════════════════════════════════════════════════════

/** 8kHz PCM_16 mono: 2 bytes per sample, so 16000 bytes per second. */
const SAMPLE_RATE_HZ = 8000;
const BYTES_PER_SECOND = SAMPLE_RATE_HZ * 2;

/**
 * The four frame sizes the live account actually emits, and the audio
 * each carries. Quantised multiples of 2200 bytes.
 */
const FRAME_138MS = 2200;
const FRAME_275MS = 4400;
const FRAME_413MS = 6600;
const FRAME_550MS = 8800;

const audioMs = (bytes: number) => (bytes / BYTES_PER_SECOND) * 1000;

/** The RETIRED idle-gap constants, kept only so the tripwires can restate the old rule. */
const SHIPPED_MIN_IDLE_GAP_MS = 300;
const SHIPPED_SAFETY_FACTOR = 4;
const CONFIGURED_IDLE_GAP_MS = 700;
const CONFIGURED_START_TIMEOUT_MS = 6000;
/** `COMPLETION_EVENT_FALLBACK_MS` in the provider — reached ONLY when the vendor never sends `final`. */
const FALLBACK_MS = 2000;
/**
 * How long after the last audio frame a stream that ends on the `final`
 * event may take to return. Live the event trails the last frame by
 * 0-2ms; this is slack for the local event loop, and is still a fraction
 * of the 300ms floor the retired idle gap paid at every chunk boundary.
 */
const EVENT_TAIL_MAX_MS = 150;

/**
 * The RETIRED budget rule (the adaptive idle gap), reimplemented as a
 * pure function over a frame schedule. Used by `A1`/`A7` to assert that
 * their schedule really does trigger the defect it replaced. Not used by
 * production code.
 */
function shippedRuleTruncatesAt(
  schedule: ReadonlyArray<{ readonly bytes: number; readonly gapMsBefore: number }>,
): number {
  let widestGap = 0;
  for (let i = 0; i < schedule.length; i += 1) {
    const gap = schedule[i]!.gapMsBefore;
    if (i > 0) {
      const budget = Math.min(
        CONFIGURED_IDLE_GAP_MS,
        Math.max(SHIPPED_MIN_IDLE_GAP_MS, widestGap * SHIPPED_SAFETY_FACTOR),
      );
      if (gap > budget) return i;
      widestGap = Math.max(widestGap, gap);
    }
  }
  return -1;
}

// ═════════════════════════════════════════════════════════════════
// THE LOCAL FAKE SARVAM
//
// A real `ws` server on 127.0.0.1 that speaks Sarvam's protocol: the
// 44-byte streaming RIFF header as its own frame (`0xFFFFFFFF` sizes,
// exactly as the live account sends), then base64 audio frames on the
// schedule the test gives it, then NOTHING — it never closes the
// socket and never sends an end marker, because the real vendor does
// not either. The same HTTP server also answers `POST /text-to-speech`
// so the provider's REST fallback has somewhere to land.
// ═════════════════════════════════════════════════════════════════

interface Frame {
  /** Payload size in bytes. Use the measured `FRAME_*` constants. */
  readonly bytes: number;
  /** Wall-clock gap before this frame is sent, from the previous one. */
  readonly gapMsBefore: number;
}

interface FakeSarvam {
  readonly baseUrl: string;
  /**
   * Every byte of audio the schedule INTENDED to send, header excluded.
   *
   * This, not `sentAudio()`, is what a truncation test must compare
   * against. The server stops sending the moment the provider closes
   * the socket — which is exactly what a truncating provider does — so
   * `sentAudio()` shrinks to match whatever was delivered and the
   * comparison passes vacuously. Asserting against the intent is what
   * makes a truncation visible.
   */
  expectedAudio(): Uint8Array;
  /** Every byte of audio the server actually got onto the wire. */
  sentAudio(): Uint8Array;
  /** True once the server has finished its schedule. */
  scheduleDone(): boolean;
  /** How many REST fallback calls the provider made. */
  restCalls(): number;
  /** Every `{type:"config"}` frame the provider sent over the WebSocket, parsed. */
  configFrames(): ReadonlyArray<{ readonly data?: Record<string, unknown> }>;
  /** Every REST request body the provider posted, parsed. */
  restBodies(): ReadonlyArray<Record<string, unknown>>;
  // ── FIX #11 (virgin-socket pre-open) observability ──────────────
  /** How many WebSocket connections the provider has opened, ever. */
  connections(): number;
  /** How many of those the server has seen close. */
  closedConnections(): number;
  /**
   * The `type` of EVERY frame the provider sent, across every socket, in
   * order. A pre-opened socket must contribute nothing to this — that is
   * what "virgin" means, and asserting on it is what proves no `config`,
   * `text` or `flush` was written while the socket was parked.
   */
  receivedTypes(): ReadonlyArray<string>;
  /** How many streaming RIFF headers the server has sent, across every socket. */
  headerFrames(): number;
  /** The request url (path + query) of every connection the provider opened, in order. */
  connectionUrls(): ReadonlyArray<string>;
  /** Kill every open server-side socket — a vendor dropping a parked connection. */
  closeServerSockets(): void;
  /** Resolves once the provider has opened at least `n` connections. */
  awaitConnections(n: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

async function startFakeSarvam(input: {
  readonly frames: readonly Frame[];
  /** Send an `{type:"error"}` frame after this many audio frames. */
  readonly errorAfterFrames?: number;
  /** Bytes the REST fallback endpoint should return as a WAV clip. */
  readonly restClipBytes?: number;
  /** Close the socket after the schedule instead of holding it open. */
  readonly closeAfterSchedule?: boolean;
  /**
   * Send `{type:"event", event_type:"final"}` after the last frame, as
   * the live vendor does when `send_completion_event=true`. Default
   * true; a test sets false to model a vendor that dropped the stream.
   */
  readonly sendFinalEvent?: boolean;
  /** An `event` of some OTHER type, sent before the header. Must be ignored. */
  readonly preEventType?: string;
}): Promise<FakeSarvam> {
  const sent: number[] = [];
  let done = false;
  let restCalls = 0;
  const configFrames: Array<{ readonly data?: Record<string, unknown> }> = [];
  const restBodies: Array<Record<string, unknown>> = [];

  /**
   * Position-derived payloads, built up front. Non-zero and unique per
   * frame so a reordering or a lost frame is detectable rather than
   * invisible in a sea of zeroes.
   */
  const payloads = input.frames.map((frame, i) => {
    const payload = new Uint8Array(frame.bytes);
    for (let b = 0; b < payload.length; b += 1) payload[b] = (i * 7 + b) % 251;
    return payload;
  });
  /** Frames the schedule sends before it deliberately stops. */
  const intendedFrameCount = input.errorAfterFrames ?? input.frames.length;
  const expected = Buffer.concat(payloads.slice(0, intendedFrameCount).map((p) => Buffer.from(p)));

  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    // The REST fallback path. Returns the `{audios:[base64 wav]}`
    // envelope `synthesize()` parses.
    restCalls += 1;
    const body: Buffer[] = [];
    req.on("data", (c: Buffer) => body.push(c));
    req.on("end", () => {
      try {
        restBodies.push(JSON.parse(Buffer.concat(body).toString()) as Record<string, unknown>);
      } catch {
        // Not JSON — nothing to record; the response below is unaffected.
      }
      const pcmBytes = input.restClipBytes ?? FRAME_550MS;
      const wav = wavContainer(new Uint8Array(pcmBytes));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ request_id: "fake", audios: [Buffer.from(wav).toString("base64")] }));
    });
  });

  const wss = new WebSocketServer({ server: http, path: "/text-to-speech/ws" });

  // FIX #11 observability — see the `FakeSarvam` members.
  let connections = 0;
  let closedConnections = 0;
  let headerFrames = 0;
  const receivedTypes: string[] = [];
  const connectionUrls: string[] = [];
  const liveSockets = new Set<WsSocket>();

  wss.on("connection", (socket: WsSocket, req: IncomingMessage) => {
    connections += 1;
    connectionUrls.push(req.url ?? "");
    liveSockets.add(socket);
    socket.on("close", () => {
      closedConnections += 1;
      liveSockets.delete(socket);
    });
    let flushed = false;
    socket.on("message", async (raw: Buffer) => {
      let parsed: { type?: string; data?: Record<string, unknown> };
      try {
        parsed = JSON.parse(raw.toString()) as typeof parsed;
      } catch {
        return;
      }
      if (parsed.type !== undefined) receivedTypes.push(parsed.type);
      if (parsed.type === "config") configFrames.push(parsed);
      if (parsed.type !== "flush" || flushed) return;
      flushed = true;

      if (input.preEventType !== undefined) {
        socket.send(JSON.stringify({ type: "event", data: { event_type: input.preEventType } }));
      }

      // The streaming RIFF header, as its own frame, with the
      // placeholder sizes the live account really sends.
      headerFrames += 1;
      socket.send(
        JSON.stringify({
          type: "audio",
          data: { audio: Buffer.from(streamingWavHeader()).toString("base64") },
        }),
      );

      for (let i = 0; i < input.frames.length; i += 1) {
        await sleep(input.frames[i]!.gapMsBefore);
        if (socket.readyState !== socket.OPEN) return;
        if (input.errorAfterFrames !== undefined && i === input.errorAfterFrames) {
          socket.send(JSON.stringify({ type: "error", data: { message: "synthetic vendor error" } }));
          done = true;
          return;
        }
        const payload = payloads[i]!;
        for (const byte of payload) sent.push(byte);
        socket.send(
          JSON.stringify({ type: "audio", data: { audio: Buffer.from(payload).toString("base64") } }),
        );
      }
      done = true;
      // The completion event, 0-2ms after the last frame as measured
      // live. The vendor does NOT close afterwards.
      if (input.sendFinalEvent !== false && socket.readyState === socket.OPEN) {
        await sleep(1);
        socket.send(JSON.stringify({ type: "event", data: { event_type: "final" } }));
      }
      if (input.closeAfterSchedule) socket.close();
    });
  });

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    expectedAudio: () => new Uint8Array(expected),
    sentAudio: () => new Uint8Array(sent),
    scheduleDone: () => done,
    restCalls: () => restCalls,
    configFrames: () => configFrames,
    restBodies: () => restBodies,
    connections: () => connections,
    closedConnections: () => closedConnections,
    receivedTypes: () => receivedTypes,
    headerFrames: () => headerFrames,
    connectionUrls: () => connectionUrls,
    closeServerSockets: () => {
      for (const socket of [...liveSockets]) socket.close();
    },
    async awaitConnections(n: number, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (connections < n) {
        if (Date.now() > deadline) {
          throw new Error(`only ${connections} of ${n} expected connections opened within ${timeoutMs}ms`);
        }
        await sleep(10);
      }
    },
    async close() {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

/** The 44-byte streaming header, `0xFFFFFFFF` sizes, as measured live. */
function streamingWavHeader(): Uint8Array {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(0xffffffff, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE_HZ, 24);
  header.writeUInt32LE(BYTES_PER_SECOND, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(0xffffffff, 40);
  return new Uint8Array(header);
}

/** A complete, honest WAV container — what the REST endpoint returns. */
function wavContainer(pcm: Uint8Array): Uint8Array {
  const header = Buffer.from(streamingWavHeader());
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.writeUInt32LE(pcm.byteLength, 40);
  return new Uint8Array(Buffer.concat([header, Buffer.from(pcm)]));
}

function providerFor(baseUrl: string) {
  return new SarvamTextToSpeechProvider({
    apiKey: "test-key",
    baseUrl,
    model: "bulbul:v2",
    defaultSpeaker: "test-speaker",
    sampleRateHz: SAMPLE_RATE_HZ,
    streamIdleGapMs: CONFIGURED_IDLE_GAP_MS,
    streamStartTimeoutMs: CONFIGURED_START_TIMEOUT_MS,
  });
}

const task = (text: string): SynthesisTaskRequest => ({
  sessionId: "sarvam-stream-test" as SessionId,
  request: { text, language: SupportedLanguage.HINGLISH },
});

/** FIX #11 — the same task under an explicit session id. */
const taskFor = (sessionId: string, text: string): SynthesisTaskRequest => ({
  sessionId: sessionId as SessionId,
  request: { text, language: SupportedLanguage.HINGLISH },
});

interface Drained {
  readonly chunks: readonly TtsAudioChunk[];
  /** Every audio byte the provider yielded, concatenated in order. */
  readonly audio: Uint8Array;
  /** Wall clock from the call starting to the generator returning. */
  readonly totalMs: number;
  /** Wall clock from the LAST non-empty chunk to the generator returning. */
  readonly tailMs: number;
  readonly error?: Error;
}

/**
 * Drives `synthesizeStream` to completion and records what came out.
 * `onChunk` lets a test abort mid-stream, which is the barge-in shape.
 */
async function drain(
  provider: InstanceType<typeof SarvamTextToSpeechProvider>,
  text: string,
  opts: {
    readonly signal?: AbortSignal;
    readonly onChunk?: (chunk: TtsAudioChunk, index: number) => void | Promise<void>;
    /** FIX #11 — drive the stream under a specific session id. */
    readonly sessionId?: string;
  } = {},
): Promise<Drained> {
  const chunks: TtsAudioChunk[] = [];
  const parts: Uint8Array[] = [];
  const startedAt = Date.now();
  let lastAudioAt = startedAt;
  let error: Error | undefined;

  try {
    let index = 0;
    const request = opts.sessionId === undefined ? task(text) : taskFor(opts.sessionId, text);
    for await (const chunk of provider.synthesizeStream!(request, opts.signal)) {
      chunks.push(chunk);
      if (chunk.audio.data.byteLength > 0) {
        parts.push(chunk.audio.data);
        lastAudioAt = Date.now();
      }
      await opts.onChunk?.(chunk, index);
      index += 1;
    }
  } catch (err) {
    error = err instanceof Error ? err : new Error(String(err));
  }

  const returnedAt = Date.now();
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const audio = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    audio.set(part, offset);
    offset += part.byteLength;
  }

  return {
    chunks,
    audio,
    totalMs: returnedAt - startedAt,
    tailMs: returnedAt - lastAudioAt,
    ...(error ? { error } : {}),
  };
}

/** Same bytes, same order — the whole point. */
function assertSameAudio(got: Uint8Array, expected: Uint8Array, what: string): void {
  assert.equal(
    got.byteLength,
    expected.byteLength,
    `${what}: expected ${expected.byteLength} bytes (${(expected.byteLength / BYTES_PER_SECOND).toFixed(2)}s) but got ${got.byteLength} (${(got.byteLength / BYTES_PER_SECOND).toFixed(2)}s) — ${((got.byteLength / Math.max(1, expected.byteLength)) * 100).toFixed(0)}% delivered`,
  );
  assert.deepEqual(Buffer.from(got), Buffer.from(expected), `${what}: bytes differ or are out of order`);
}

const TEXT_LONG =
  "Actually, I am calling you with a very interesting invitation. " +
  "We have created Flexi Genie which helps you build your online business.";
const TEXT_SHORT = "Haan ji, bilkul.";

// ═════════════════════════════════════════════════════════════════
section("SECTION A — the truncation defect (real provider, local socket)");
// ═════════════════════════════════════════════════════════════════

/**
 * THE REPRODUCTION, byte for byte.
 *
 * Two 6600-byte (413ms) frames, then a 450ms gap, then the rest of a
 * ~6s utterance. Under the shipped rule the budget after frame 1 was
 * `max(300, 0 * 4)` = 300ms and after frame 2 still 300ms (the widest
 * gap so far being 60ms), so the 450ms gap ended the stream at frame 3
 * — leaving exactly the `frames=2, audio=0.82s` the audit recorded.
 */
await test("A1 — the audit's exact failure: two 413ms frames then a 450ms gap does NOT truncate", async () => {
  const frames: Frame[] = [
    { bytes: FRAME_413MS, gapMsBefore: 20 },
    { bytes: FRAME_413MS, gapMsBefore: 60 },
    { bytes: FRAME_413MS, gapMsBefore: 450 },
    { bytes: FRAME_413MS, gapMsBefore: 80 },
    { bytes: FRAME_413MS, gapMsBefore: 90 },
    { bytes: FRAME_413MS, gapMsBefore: 70 },
    { bytes: FRAME_413MS, gapMsBefore: 60 },
    { bytes: FRAME_275MS, gapMsBefore: 75 },
    { bytes: FRAME_138MS, gapMsBefore: 65 },
  ];

  // The premise. If this ever stops being true the test has stopped
  // reproducing the defect and must be re-derived, not relaxed.
  assert.equal(
    shippedRuleTruncatesAt(frames),
    2,
    "premise broken: the SHIPPED budget rule no longer truncates this schedule at frame 3",
  );

  const server = await startFakeSarvam({ frames });
  try {
    const result = await drain(providerFor(server.baseUrl), TEXT_LONG);
    assert.equal(result.error, undefined, `unexpected error: ${result.error?.message}`);
    assertSameAudio(result.audio, server.expectedAudio(), "A1 full utterance");
    // And the whole clip really is multi-second, so this is not a
    // vacuous pass on a short one.
    assert.ok(
      result.audio.byteLength / BYTES_PER_SECOND > 2.5,
      `expected a multi-second utterance, got ${(result.audio.byteLength / BYTES_PER_SECOND).toFixed(2)}s`,
    );
  } finally {
    await server.close();
  }
});

await test("A2 — first frame with no cadence yet: a 600ms gap after frame 1 does NOT truncate", async () => {
  const frames: Frame[] = [
    { bytes: FRAME_138MS, gapMsBefore: 20 },
    { bytes: FRAME_138MS, gapMsBefore: 600 },
    { bytes: FRAME_138MS, gapMsBefore: 60 },
    { bytes: FRAME_138MS, gapMsBefore: 55 },
    { bytes: FRAME_138MS, gapMsBefore: 70 },
  ];
  assert.equal(shippedRuleTruncatesAt(frames), 1, "premise broken: shipped rule must truncate at frame 2");

  const server = await startFakeSarvam({ frames });
  try {
    const result = await drain(providerFor(server.baseUrl), TEXT_LONG);
    assert.equal(result.error, undefined, `unexpected error: ${result.error?.message}`);
    assertSameAudio(result.audio, server.expectedAudio(), "A2 full utterance");
  } finally {
    await server.close();
  }
});

await test("A3 — sparse cadence throughout: 350ms gaps between frames does NOT truncate", async () => {
  const frames: Frame[] = [
    { bytes: FRAME_138MS, gapMsBefore: 20 },
    { bytes: FRAME_138MS, gapMsBefore: 350 },
    { bytes: FRAME_138MS, gapMsBefore: 350 },
    { bytes: FRAME_138MS, gapMsBefore: 350 },
    { bytes: FRAME_138MS, gapMsBefore: 350 },
    { bytes: FRAME_138MS, gapMsBefore: 350 },
  ];
  assert.equal(shippedRuleTruncatesAt(frames), 1, "premise broken: shipped rule must truncate at frame 2");

  const server = await startFakeSarvam({ frames });
  try {
    const result = await drain(providerFor(server.baseUrl), TEXT_LONG);
    assert.equal(result.error, undefined, `unexpected error: ${result.error?.message}`);
    assertSameAudio(result.audio, server.expectedAudio(), "A3 full utterance");
  } finally {
    await server.close();
  }
});

/**
 * The delivery-quantum floor on its own. Two tight gaps first, so the
 * adaptive term IS established and IS small (60ms * 4 = 240, floored to
 * 300ms) — the warm-up rule cannot help here. Only "never conclude the
 * vendor stopped in less than the 550ms it just delivered" survives the
 * 480ms gap.
 */
await test("A7 — established-but-tight cadence, 550ms frames, 480ms gap: the delivery quantum saves it", async () => {
  const frames: Frame[] = [
    { bytes: FRAME_550MS, gapMsBefore: 20 },
    { bytes: FRAME_550MS, gapMsBefore: 60 },
    { bytes: FRAME_550MS, gapMsBefore: 60 },
    { bytes: FRAME_550MS, gapMsBefore: 480 },
    { bytes: FRAME_550MS, gapMsBefore: 60 },
    { bytes: FRAME_413MS, gapMsBefore: 70 },
  ];
  assert.equal(
    shippedRuleTruncatesAt(frames),
    3,
    "premise broken: shipped rule must truncate at frame 4",
  );
  // And the warm-up rule alone would NOT have been enough: by frame 4
  // three gaps have been observed, so the adaptive term is live.
  assert.ok(audioMs(FRAME_550MS) > 480, "premise broken: the quantum must exceed the gap");

  const server = await startFakeSarvam({ frames });
  try {
    const result = await drain(providerFor(server.baseUrl), TEXT_LONG);
    assert.equal(result.error, undefined, `unexpected error: ${result.error?.message}`);
    assertSameAudio(result.audio, server.expectedAudio(), "A7 full utterance");
  } finally {
    await server.close();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION B — the safety mechanism is still BOUNDED");
// ═════════════════════════════════════════════════════════════════

await test("A4 — a genuinely short utterance completes, and returns bounded", async () => {
  const frames: Frame[] = [{ bytes: FRAME_138MS, gapMsBefore: 20 }];
  const server = await startFakeSarvam({ frames });
  try {
    const result = await drain(providerFor(server.baseUrl), TEXT_SHORT);
    assert.equal(result.error, undefined, `unexpected error: ${result.error?.message}`);
    assertSameAudio(result.audio, server.expectedAudio(), "A4 short utterance");
    // One frame, then `final`. The generator returns on the event —
    // not on the 6s start timeout, not on any idle budget.
    assert.ok(
      result.tailMs <= EVENT_TAIL_MAX_MS,
      `tail ${result.tailMs}ms — should have returned on the final event, not a timer`,
    );
  } finally {
    await server.close();
  }
});

await test("A5 — genuine completion then long silence with the socket held open: returns on the final event, not on the silence", async () => {
  const frames: Frame[] = Array.from({ length: 12 }, (_, i) => ({
    bytes: FRAME_275MS,
    gapMsBefore: i === 0 ? 20 : 60,
  }));
  const server = await startFakeSarvam({ frames });
  try {
    const result = await drain(providerFor(server.baseUrl), TEXT_LONG);
    assert.equal(result.error, undefined, `unexpected error: ${result.error?.message}`);
    assertSameAudio(result.audio, server.expectedAudio(), "A5 full utterance");
    assert.ok(server.scheduleDone(), "the server should have finished its schedule");
    // The vendor never closes — the generator returns on the event.
    assert.ok(
      result.tailMs <= EVENT_TAIL_MAX_MS,
      `tail ${result.tailMs}ms — should have returned on the final event, not a timer`,
    );
    // The last chunk is the empty final sentinel.
    const last = result.chunks[result.chunks.length - 1];
    assert.equal(last?.isFinal, true, "the last chunk must be the final sentinel");
    assert.equal(last?.audio.data.byteLength, 0, "the final sentinel must carry no audio");
  } finally {
    await server.close();
  }
});

/**
 * THE LATENCY TRIPWIRE. The pipeline awaits this generator once per
 * sentence chunk, so every millisecond between the last frame and the
 * return is pure serialisation at a chunk boundary. The retired idle gap
 * paid 300ms here on its best day; the event pays ~1ms. This fails if
 * anyone reintroduces a wait after the final event.
 */
await test("A6 — common cadence: the tail is the event, not a timer — no chunk-boundary wait is reintroduced", async () => {
  const frames: Frame[] = Array.from({ length: 14 }, (_, i) => ({
    bytes: FRAME_138MS,
    gapMsBefore: i === 0 ? 20 : 55,
  }));
  const server = await startFakeSarvam({ frames });
  try {
    const result = await drain(providerFor(server.baseUrl), TEXT_LONG);
    assert.equal(result.error, undefined, `unexpected error: ${result.error?.message}`);
    assertSameAudio(result.audio, server.expectedAudio(), "A6 full utterance");
    assert.ok(
      result.tailMs <= EVENT_TAIL_MAX_MS,
      `tail ${result.tailMs}ms — a wait after the final event has been reintroduced (the retired floor was ${SHIPPED_MIN_IDLE_GAP_MS}ms)`,
    );
  } finally {
    await server.close();
  }
});

await test("A8 — one enormous frame cannot license an unbounded tail", async () => {
  // 4 seconds of audio in a single frame. Under the retired rule the
  // delivery-quantum floor would have licensed a 4s tail; the event
  // makes the frame's size irrelevant to the tail.
  const frames: Frame[] = [{ bytes: BYTES_PER_SECOND * 4, gapMsBefore: 20 }];
  const server = await startFakeSarvam({ frames });
  try {
    const result = await drain(providerFor(server.baseUrl), TEXT_LONG);
    assert.equal(result.error, undefined, `unexpected error: ${result.error?.message}`);
    assertSameAudio(result.audio, server.expectedAudio(), "A8 full utterance");
    assert.ok(
      result.tailMs <= EVENT_TAIL_MAX_MS,
      `tail ${result.tailMs}ms — should have returned on the final event, not on anything derived from the 4000ms frame`,
    );
  } finally {
    await server.close();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION C — the contract around the fix, unchanged");
// ═════════════════════════════════════════════════════════════════

await test("C1 — the 44-byte streaming RIFF header is stripped, never played", async () => {
  const frames: Frame[] = [
    { bytes: FRAME_275MS, gapMsBefore: 20 },
    { bytes: FRAME_275MS, gapMsBefore: 60 },
    { bytes: FRAME_275MS, gapMsBefore: 60 },
  ];
  const server = await startFakeSarvam({ frames });
  try {
    const result = await drain(providerFor(server.baseUrl), TEXT_LONG);
    assertSameAudio(result.audio, server.expectedAudio(), "C1 audio");
    assert.equal(
      Buffer.from(result.audio.subarray(0, 4)).toString("ascii") === "RIFF",
      false,
      "the RIFF header reached the pipeline as if it were samples",
    );
    assert.equal(result.audio.byteLength, FRAME_275MS * 3, "exactly the three payloads, no header bytes");
  } finally {
    await server.close();
  }
});

await test("C2 — every chunk is sample-aligned, sequenced from 0, and PCM_16 at the configured rate", async () => {
  const frames: Frame[] = [
    { bytes: FRAME_413MS, gapMsBefore: 20 },
    { bytes: FRAME_138MS, gapMsBefore: 60 },
    { bytes: FRAME_550MS, gapMsBefore: 60 },
  ];
  const server = await startFakeSarvam({ frames });
  try {
    const result = await drain(providerFor(server.baseUrl), TEXT_LONG);
    result.chunks.forEach((chunk, i) => {
      assert.equal(chunk.sequence, i, `chunk ${i} has sequence ${chunk.sequence}`);
      assert.equal(chunk.audio.encoding, "PCM_16", `chunk ${i} encoding`);
      assert.equal(chunk.audio.sampleRateHz, SAMPLE_RATE_HZ, `chunk ${i} sample rate`);
      assert.equal(chunk.audio.data.byteLength % 2, 0, `chunk ${i} is odd-length — a sample was split`);
    });
    assertSameAudio(result.audio, server.expectedAudio(), "C2 audio");
  } finally {
    await server.close();
  }
});

await test("C3 — an odd-length frame carries its orphan byte instead of shifting every later sample", async () => {
  const frames: Frame[] = [
    { bytes: FRAME_138MS + 1, gapMsBefore: 20 },
    { bytes: FRAME_138MS, gapMsBefore: 60 },
    { bytes: FRAME_138MS, gapMsBefore: 60 },
  ];
  const server = await startFakeSarvam({ frames });
  try {
    const result = await drain(providerFor(server.baseUrl), TEXT_LONG);
    for (const chunk of result.chunks) {
      assert.equal(chunk.audio.data.byteLength % 2, 0, "an odd-length chunk escaped the parity guard");
    }
    // The guard drops the orphan rather than mis-aligning what follows,
    // so exactly one byte of a 4401-byte stream is unaccounted for and
    // every remaining byte is still in its original order.
    const sent = server.expectedAudio();
    assert.equal(result.audio.byteLength, sent.byteLength - 1, "expected exactly one orphan byte held back");
    assert.deepEqual(
      Buffer.from(result.audio.subarray(0, FRAME_138MS)),
      Buffer.from(sent.subarray(0, FRAME_138MS)),
      "the first frame's samples were reordered",
    );
  } finally {
    await server.close();
  }
});

await test("C4 — barge-in mid-stream stops emission promptly and emits no final sentinel", async () => {
  const frames: Frame[] = Array.from({ length: 20 }, (_, i) => ({
    bytes: FRAME_275MS,
    gapMsBefore: i === 0 ? 20 : 60,
  }));
  const server = await startFakeSarvam({ frames });
  try {
    const controller = new AbortController();
    const startedAt = Date.now();
    const result = await drain(providerFor(server.baseUrl), TEXT_LONG, {
      signal: controller.signal,
      onChunk: (_chunk, index) => {
        if (index === 2) controller.abort();
      },
    });
    const elapsed = Date.now() - startedAt;
    assert.equal(result.error, undefined, `unexpected error: ${result.error?.message}`);
    assert.ok(result.chunks.length <= 4, `expected emission to stop, got ${result.chunks.length} chunks`);
    assert.ok(
      !result.chunks.some((c) => c.isFinal),
      "an aborted stream must not claim it completed",
    );
    // 20 frames at 60ms is >1.2s of schedule; aborting must not wait it
    // out, and must not wait out an idle gap either.
    assert.ok(elapsed < 900, `abort took ${elapsed}ms — it should return promptly`);
  } finally {
    await server.close();
  }
});

await test("C5 — a vendor error AFTER audio has started throws instead of truncating silently", async () => {
  const frames: Frame[] = [
    { bytes: FRAME_275MS, gapMsBefore: 20 },
    { bytes: FRAME_275MS, gapMsBefore: 60 },
    { bytes: FRAME_275MS, gapMsBefore: 60 },
    { bytes: FRAME_275MS, gapMsBefore: 60 },
  ];
  const server = await startFakeSarvam({ frames, errorAfterFrames: 2 });
  try {
    const result = await drain(providerFor(server.baseUrl), TEXT_LONG);
    assert.ok(result.error, "a mid-stream vendor error must surface, not look like a completed utterance");
    assert.match(result.error!.message, /Sarvam TTS stream error/u);
    assert.equal(server.restCalls(), 0, "no REST re-synthesis after audio has already been queued");
  } finally {
    await server.close();
  }
});

await test("C6 — a vendor error BEFORE any audio falls back to the blocking REST call", async () => {
  const frames: Frame[] = [
    { bytes: FRAME_275MS, gapMsBefore: 20 },
    { bytes: FRAME_275MS, gapMsBefore: 60 },
  ];
  const server = await startFakeSarvam({ frames, errorAfterFrames: 0, restClipBytes: FRAME_550MS });
  try {
    const result = await drain(providerFor(server.baseUrl), TEXT_LONG);
    assert.equal(result.error, undefined, `the fallback should absorb this: ${result.error?.message}`);
    assert.equal(server.restCalls(), 1, "expected exactly one REST fallback call");
    assert.equal(result.audio.byteLength, FRAME_550MS, "the fallback clip should be delivered whole");
    assert.ok(result.chunks.some((c) => c.isFinal), "the fallback path still marks completion");
  } finally {
    await server.close();
  }
});

await test("C7 — a server that DOES close ends the stream on the close, not on a timer", async () => {
  const frames: Frame[] = [
    { bytes: FRAME_275MS, gapMsBefore: 20 },
    { bytes: FRAME_275MS, gapMsBefore: 60 },
    { bytes: FRAME_275MS, gapMsBefore: 60 },
  ];
  // No `final` here on purpose: this test is about the CLOSE ending the
  // stream, so the event must not be what ends it first.
  const server = await startFakeSarvam({ frames, closeAfterSchedule: true, sendFinalEvent: false });
  try {
    const result = await drain(providerFor(server.baseUrl), TEXT_LONG);
    assert.equal(result.error, undefined, `unexpected error: ${result.error?.message}`);
    assertSameAudio(result.audio, server.expectedAudio(), "C7 audio");
    // A real close is a definite end, so no idle gap is paid at all.
    assert.ok(result.tailMs < 250, `tail ${result.tailMs}ms — a server close should end the stream immediately`);
  } finally {
    await server.close();
  }
});

await test("C8 — FIX #9: BOTH synthesis paths send the same speaking rate (`pace`), and it is a conservative, in-range value", async () => {
  const frames: Frame[] = [{ bytes: FRAME_275MS, gapMsBefore: 20 }];
  const server = await startFakeSarvam({ frames });
  try {
    const provider = providerFor(server.baseUrl);
    // WebSocket path: the `config` frame carries it.
    const streamed = await drain(provider, TEXT_SHORT);
    assert.equal(streamed.error, undefined, `unexpected error: ${streamed.error?.message}`);
    assert.equal(server.configFrames().length, 1, "exactly one config frame per streamed utterance");
    const wsPace = server.configFrames()[0]!.data?.pace;
    assert.equal(typeof wsPace, "number", "the WebSocket config must carry a numeric `pace`");
    // REST path: the request body carries it.
    await provider.synthesize(task(TEXT_SHORT));
    assert.equal(server.restBodies().length, 1, "exactly one REST body recorded");
    const restPace = server.restBodies()[0]!.pace;
    assert.equal(typeof restPace, "number", "the REST body must carry a numeric `pace`");
    assert.equal(wsPace, restPace, "both paths must speak at the SAME rate — the caller must not hear a different voice depending on which path was taken");
    // Conservative: faster than the vendor default that was heard as too
    // slow, inside the documented range of both models (v3 0.5–2.0,
    // v2 0.3–3.0), and short of anything that could sound rushed.
    assert.ok((wsPace as number) > 1.0 && (wsPace as number) <= 1.2, `pace ${wsPace} must be in (1.0, 1.2]`);
  } finally {
    await server.close();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION D — duration and cost accounting");
// ═════════════════════════════════════════════════════════════════

await test("D1 — generated audio duration equals the audio actually delivered", async () => {
  const frames: Frame[] = [
    { bytes: FRAME_550MS, gapMsBefore: 20 },
    { bytes: FRAME_413MS, gapMsBefore: 60 },
    { bytes: FRAME_275MS, gapMsBefore: 60 },
    { bytes: FRAME_138MS, gapMsBefore: 60 },
  ];
  const server = await startFakeSarvam({ frames });
  try {
    const result = await drain(providerFor(server.baseUrl), TEXT_LONG);
    // What the pipeline sums per chunk via `estimateAudioSeconds`.
    const seconds = result.chunks.reduce(
      (sum, c) => sum + c.audio.data.byteLength / BYTES_PER_SECOND,
      0,
    );
    const expected = (FRAME_550MS + FRAME_413MS + FRAME_275MS + FRAME_138MS) / BYTES_PER_SECOND;
    assert.ok(
      Math.abs(seconds - expected) < 1e-9,
      `generated duration ${seconds.toFixed(4)}s should equal ${expected.toFixed(4)}s`,
    );
    // Truncation would have shown up here as a short duration that the
    // pipeline nonetheless recorded the full text against.
    assert.ok(seconds > 0.8, "a truncated stream would under-report duration");
  } finally {
    await server.close();
  }
});

await test("D2 — Sarvam TTS cost stays non-zero and character-billed on the streaming path", async () => {
  const sarvamId = TEXT_TO_SPEECH_PROVIDER_IDS.SARVAM;
  const withDuration = estimateTtsCost(sarvamId, TEXT_LONG.length, 6.2);
  const withoutDuration = estimateTtsCost(sarvamId, TEXT_LONG.length);
  assert.ok(withDuration > 0, "Sarvam TTS cost must not be zero on the streaming branch");
  assert.equal(
    withDuration,
    withoutDuration,
    "Sarvam bills per character, so the duration argument must not change the cost",
  );
  // Proportional to characters, which is what the vendor charges for.
  assert.ok(
    Math.abs(estimateTtsCost(sarvamId, 2000) - 2 * estimateTtsCost(sarvamId, 1000)) < 1e-12,
    "character billing should be linear",
  );
});

// ═════════════════════════════════════════════════════════════════
section("SECTION E — FIX #11: virgin-socket pre-open");
// ═════════════════════════════════════════════════════════════════

/**
 * These run against the same real provider over the same real local
 * socket as every test above. The load-bearing observable is
 * `server.connections()`: the pre-open path must produce exactly ONE
 * connection for an utterance that consumed a warm socket, and TWO
 * whenever the warm socket was not usable — which is what distinguishes
 * "the handshake was moved off the caller's clock" from "a second socket
 * was opened and the first leaked".
 *
 * `server.receivedTypes()` is the virginity proof: a parked socket must
 * contribute nothing to it.
 */

/** A short, healthy schedule — these tests are about the socket, not the cadence. */
const PREOPEN_FRAMES: Frame[] = [
  { bytes: FRAME_550MS, gapMsBefore: 20 },
  { bytes: FRAME_413MS, gapMsBefore: 60 },
  { bytes: FRAME_275MS, gapMsBefore: 60 },
  { bytes: FRAME_138MS, gapMsBefore: 60 },
];

await test("E1 — a pre-opened socket is handed out EXACTLY ONCE: the first utterance reuses it, the second opens its own", async () => {
  const server = await startFakeSarvam({ frames: PREOPEN_FRAMES });
  try {
    const provider = providerFor(server.baseUrl);
    provider.prepareSession("session-E1");
    await server.awaitConnections(1);
    assert.equal(server.connections(), 1, "pre-open should have opened exactly one socket");

    // First utterance consumes the warm socket — no new connection.
    const first = await drain(provider, TEXT_LONG, { sessionId: "session-E1" });
    assert.equal(first.error, undefined, `first utterance errored: ${first.error?.message}`);
    assertSameAudio(first.audio, server.expectedAudio(), "E1 first utterance (warm socket)");
    assert.equal(server.connections(), 1, "the warm socket should have been REUSED, not supplemented");

    // Second utterance: the warm socket is spent, so this one opens its
    // own. A socket handed out twice would show up as connections still
    // being 1 — and as two utterances sharing one socket, which is the
    // contamination Phase C refused.
    const second = await drain(provider, TEXT_LONG, { sessionId: "session-E1" });
    assert.equal(second.error, undefined, `second utterance errored: ${second.error?.message}`);
    assert.equal(server.connections(), 2, "the second utterance must open a socket of its own");
    provider.disposeSession("session-E1");
  } finally {
    await server.close();
  }
});

await test("E2 — session A's warm socket can NEVER be used by session B", async () => {
  const server = await startFakeSarvam({ frames: PREOPEN_FRAMES });
  try {
    const provider = providerFor(server.baseUrl);
    provider.prepareSession("session-A");
    await server.awaitConnections(1);

    // Session B synthesizes. It must open its OWN socket and leave A's
    // parked one alone.
    const result = await drain(provider, TEXT_LONG, { sessionId: "session-B" });
    assert.equal(result.error, undefined, `session B errored: ${result.error?.message}`);
    assertSameAudio(result.audio, server.expectedAudio(), "E2 session B audio");
    assert.equal(
      server.connections(),
      2,
      "session B must not consume session A's socket — it needs a second connection",
    );

    // And A's socket is still there, still virgin, still claimable by A.
    const aResult = await drain(provider, TEXT_LONG, { sessionId: "session-A" });
    assert.equal(aResult.error, undefined, `session A errored: ${aResult.error?.message}`);
    assert.equal(server.connections(), 2, "session A should now consume the socket opened for it");
    provider.disposeSession("session-A");
    provider.disposeSession("session-B");
  } finally {
    await server.close();
  }
});

await test("E3 — concurrent prepareSession calls do NOT create duplicate sockets", async () => {
  const server = await startFakeSarvam({ frames: PREOPEN_FRAMES });
  try {
    const provider = providerFor(server.baseUrl);
    // Same synchronous tick — the race the map insert has to win.
    for (let i = 0; i < 8; i += 1) provider.prepareSession("session-E3");
    // And again after the handshake has had time to land, which is the
    // other ordering: a second hint arriving for a socket that is now OPEN.
    await server.awaitConnections(1);
    for (let i = 0; i < 5; i += 1) provider.prepareSession("session-E3");
    await sleep(150);
    assert.equal(
      server.connections(),
      1,
      `13 prepareSession calls opened ${server.connections()} sockets — exactly 1 is required`,
    );
    provider.disposeSession("session-E3");
  } finally {
    await server.close();
  }
});

await test("E4/E5 — a warm socket the vendor has closed is discarded, and synthesis falls back to the EXISTING fresh-socket path with identical audio", async () => {
  const server = await startFakeSarvam({ frames: PREOPEN_FRAMES });
  try {
    const provider = providerFor(server.baseUrl);
    provider.prepareSession("session-E4");
    await server.awaitConnections(1);

    // The vendor drops the parked connection.
    server.closeServerSockets();
    await sleep(200);
    assert.ok(server.closedConnections() >= 1, "the server should have closed the parked socket");

    // Synthesis must not attempt to use it, and must be byte-identical
    // to the ordinary path.
    const result = await drain(provider, TEXT_LONG, { sessionId: "session-E4" });
    assert.equal(result.error, undefined, `fallback path errored: ${result.error?.message}`);
    assertSameAudio(result.audio, server.expectedAudio(), "E5 fallback audio");
    assert.equal(server.connections(), 2, "a dead warm socket must be replaced by a fresh connection");
    assert.equal(server.restCalls(), 0, "the WebSocket path should still have been used — no REST fallback");
    provider.disposeSession("session-E4");
  } finally {
    await server.close();
  }
});

await test("E6 — an unused pre-opened socket expires after ~5s and is closed", async () => {
  const server = await startFakeSarvam({ frames: PREOPEN_FRAMES });
  try {
    const provider = providerFor(server.baseUrl);
    provider.prepareSession("session-E6");
    await server.awaitConnections(1);
    assert.equal(server.closedConnections(), 0, "should still be parked well before the TTL");

    await sleep(3000);
    assert.equal(
      server.closedConnections(),
      0,
      "expired early — the TTL must not fire before ~5s or a normal turn would lose its warm socket",
    );

    await sleep(2800);
    assert.equal(server.closedConnections(), 1, "the unused socket should have expired and closed by ~5.8s");

    // And the session is left clean: the next utterance opens fresh.
    const result = await drain(provider, TEXT_LONG, { sessionId: "session-E6" });
    assert.equal(result.error, undefined, `post-expiry synthesis errored: ${result.error?.message}`);
    assertSameAudio(result.audio, server.expectedAudio(), "E6 post-expiry audio");
    assert.equal(server.connections(), 2, "after expiry the utterance must open its own socket");
  } finally {
    await server.close();
  }
});

await test("E7 — aborting the session's signal closes and discards the warm socket", async () => {
  const server = await startFakeSarvam({ frames: PREOPEN_FRAMES });
  try {
    const provider = providerFor(server.baseUrl);
    const controller = new AbortController();
    provider.prepareSession("session-E7", controller.signal);
    await server.awaitConnections(1);

    controller.abort();
    await sleep(200);
    assert.equal(server.closedConnections(), 1, "abort should have closed the parked socket");

    const result = await drain(provider, TEXT_LONG, { sessionId: "session-E7" });
    assert.equal(result.error, undefined, `post-abort synthesis errored: ${result.error?.message}`);
    assert.equal(server.connections(), 2, "after abort the utterance must open its own socket");

    // An already-aborted signal must not open anything at all.
    const connectionsBefore = server.connections();
    provider.prepareSession("session-E7b", controller.signal);
    await sleep(150);
    assert.equal(
      server.connections(),
      connectionsBefore,
      "prepareSession on an already-aborted signal must not open a socket",
    );
  } finally {
    await server.close();
  }
});

await test("E8 — disposeSession (session teardown) closes the warm socket and is idempotent", async () => {
  const server = await startFakeSarvam({ frames: PREOPEN_FRAMES });
  try {
    const provider = providerFor(server.baseUrl);
    provider.prepareSession("session-E8");
    await server.awaitConnections(1);

    provider.disposeSession("session-E8");
    await sleep(200);
    assert.equal(server.closedConnections(), 1, "dispose should have closed the parked socket");

    // Idempotent, and safe for a session that was never prepared —
    // `end()` calls this unconditionally.
    provider.disposeSession("session-E8");
    provider.disposeSession("session-never-prepared");
    await sleep(50);
    assert.equal(server.closedConnections(), 1, "repeat dispose must not close anything else");
    assert.equal(server.connections(), 1, "dispose must never open a socket");
  } finally {
    await server.close();
  }
});

await test("E9 — NO config, text or flush is sent while a socket is pre-opened", async () => {
  const server = await startFakeSarvam({ frames: PREOPEN_FRAMES });
  try {
    const provider = providerFor(server.baseUrl);
    provider.prepareSession("session-E9");
    await server.awaitConnections(1);
    // Sit on it well past the point any handshake work would be done.
    await sleep(600);

    assert.deepEqual(
      [...server.receivedTypes()],
      [],
      `a parked socket must send NOTHING, but the server received: ${server.receivedTypes().join(", ")}`,
    );
    assert.equal(server.configFrames().length, 0, "no config frame may be sent during pre-open");
    assert.equal(server.headerFrames(), 0, "the vendor must not have been asked to synthesize anything");

    // The frames appear only once synthesis claims the socket, and in
    // the documented order.
    const result = await drain(provider, TEXT_LONG, { sessionId: "session-E9" });
    assert.equal(result.error, undefined, `synthesis errored: ${result.error?.message}`);
    assert.deepEqual(
      [...server.receivedTypes()],
      ["config", "text", "flush"],
      "claiming the socket must send exactly config, then text, then flush",
    );
  } finally {
    await server.close();
  }
});

await test("E10 — exactly ONE RIFF header per socket, and it is still stripped exactly once", async () => {
  const server = await startFakeSarvam({ frames: PREOPEN_FRAMES });
  try {
    const provider = providerFor(server.baseUrl);
    provider.prepareSession("session-E10");
    await server.awaitConnections(1);

    const result = await drain(provider, TEXT_LONG, { sessionId: "session-E10" });
    assert.equal(result.error, undefined, `warm-socket synthesis errored: ${result.error?.message}`);
    assert.equal(server.headerFrames(), 1, "the vendor should have sent exactly one streaming RIFF header");
    // Stripped exactly once: the yielded audio is the payload bytes and
    // nothing else, so no header survived into the caller's audio.
    assertSameAudio(result.audio, server.expectedAudio(), "E10 warm-socket audio");
    assert.equal(
      Buffer.from(result.audio).indexOf(Buffer.from("RIFF", "ascii")),
      -1,
      "no RIFF magic may survive into the audio handed to the pipeline",
    );
    provider.disposeSession("session-E10");
  } finally {
    await server.close();
  }
});

await test("E11/E12 — on the warm path the config payload, pace, sample rate and output format are unchanged", async () => {
  const server = await startFakeSarvam({ frames: PREOPEN_FRAMES });
  try {
    const warmProvider = providerFor(server.baseUrl);
    warmProvider.prepareSession("session-E11");
    await server.awaitConnections(1);
    const warm = await drain(warmProvider, TEXT_LONG, { sessionId: "session-E11" });
    assert.equal(warm.error, undefined, `warm path errored: ${warm.error?.message}`);
    const warmConfig = server.configFrames()[0]?.data ?? {};

    // Same provider, same text, no pre-open — the reference.
    const cold = await drain(providerFor(server.baseUrl), TEXT_LONG, { sessionId: "session-E11-cold" });
    assert.equal(cold.error, undefined, `cold path errored: ${cold.error?.message}`);
    const coldConfig = server.configFrames()[1]?.data ?? {};

    assert.deepEqual(
      warmConfig,
      coldConfig,
      "the config frame must be identical whether the socket was pre-opened or not",
    );
    // And it is the shipped payload, asserted by value rather than only
    // against itself.
    assert.equal(warmConfig.pace, 1.0, "pace must be unchanged on the warm path");
    assert.equal(warmConfig.output_audio_codec, "wav", "output format must be unchanged");
    assert.equal(warmConfig.speech_sample_rate, SAMPLE_RATE_HZ, "sample rate must be unchanged");
    assert.equal(warmConfig.target_language_code, "hi-IN", "language must be unchanged");
    assert.equal(warmConfig.speaker, "test-speaker", "speaker must be unchanged");

    // Audio is byte-identical between the two paths.
    assertSameAudio(warm.audio, cold.audio, "E11 warm vs cold audio");
  } finally {
    await server.close();
  }
});

await test("E13 — a barge-in on the warm path still aborts, and leaves nothing claimable behind", async () => {
  const server = await startFakeSarvam({ frames: PREOPEN_FRAMES });
  try {
    const provider = providerFor(server.baseUrl);
    provider.prepareSession("session-E13");
    await server.awaitConnections(1);

    const controller = new AbortController();
    const result = await drain(provider, TEXT_LONG, {
      sessionId: "session-E13",
      signal: controller.signal,
      onChunk: (_chunk, index) => {
        if (index === 0) controller.abort();
      },
    });
    assert.equal(result.error, undefined, `abort should end the stream cleanly: ${result.error?.message}`);
    assert.ok(
      result.audio.byteLength < server.expectedAudio().byteLength,
      "a barge-in must cut the utterance short",
    );
    await sleep(150);
    assert.ok(server.closedConnections() >= 1, "the claimed socket must be closed after the abort");

    // The warm socket was consumed by that utterance, so the next one
    // opens its own — it can never be handed out a second time.
    const connectionsBefore = server.connections();
    const next = await drain(provider, TEXT_LONG, { sessionId: "session-E13" });
    assert.equal(next.error, undefined, `post-abort synthesis errored: ${next.error?.message}`);
    assert.equal(
      server.connections(),
      connectionsBefore + 1,
      "the aborted socket must not be reclaimable",
    );
  } finally {
    await server.close();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION F — the completion event is THE end of an utterance");
// ═════════════════════════════════════════════════════════════════

/** The live vendor's common shape: mixed quanta, tight gaps. */
const COMMON_FRAMES: Frame[] = [
  { bytes: FRAME_550MS, gapMsBefore: 20 },
  { bytes: FRAME_413MS, gapMsBefore: 70 },
  { bytes: FRAME_275MS, gapMsBefore: 80 },
  { bytes: FRAME_413MS, gapMsBefore: 60 },
  { bytes: FRAME_138MS, gapMsBefore: 65 },
];

await test("F1 — `final` event: every byte is delivered and the stream returns on the event", async () => {
  const server = await startFakeSarvam({ frames: COMMON_FRAMES });
  try {
    const result = await drain(providerFor(server.baseUrl), TEXT_LONG);
    assert.equal(result.error, undefined, `unexpected error: ${result.error?.message}`);
    assertSameAudio(result.audio, server.expectedAudio(), "F1 full utterance");
    assert.ok(result.tailMs <= EVENT_TAIL_MAX_MS, `tail ${result.tailMs}ms — did not return on the event`);
    const last = result.chunks[result.chunks.length - 1];
    assert.equal(last?.isFinal, true, "the last chunk must be the final sentinel");
    assert.equal(last?.audio.data.byteLength, 0, "the final sentinel must carry no audio");
  } finally {
    await server.close();
  }
});

await test("F2 — a 1500ms mid-stream stall does NOT truncate: the utterance ends on `final`, not on the silence", async () => {
  // Wider than every retired budget (550/672/700/1200ms) and than the
  // widest stall measured live (786ms). Under any silence-based rule
  // this is the truncation the call logs showed.
  const frames: Frame[] = [
    { bytes: FRAME_550MS, gapMsBefore: 20 },
    { bytes: FRAME_550MS, gapMsBefore: 60 },
    { bytes: FRAME_550MS, gapMsBefore: 1500 },
    { bytes: FRAME_413MS, gapMsBefore: 60 },
    { bytes: FRAME_275MS, gapMsBefore: 70 },
  ];
  assert.ok(shippedRuleTruncatesAt(frames) < frames.length, "premise broken: the retired rule must truncate here");
  const server = await startFakeSarvam({ frames });
  try {
    const result = await drain(providerFor(server.baseUrl), TEXT_LONG);
    assert.equal(result.error, undefined, `unexpected error: ${result.error?.message}`);
    assertSameAudio(result.audio, server.expectedAudio(), "F2 full utterance across the stall");
    assert.ok(result.tailMs <= EVENT_TAIL_MAX_MS, `tail ${result.tailMs}ms — did not return on the event`);
  } finally {
    await server.close();
  }
});

await test("F3 — no `final` ever (vendor dropped the stream): all delivered audio is kept and the wait is bounded at the fallback", async () => {
  const server = await startFakeSarvam({ frames: COMMON_FRAMES, sendFinalEvent: false });
  try {
    const result = await drain(providerFor(server.baseUrl), TEXT_LONG);
    assert.equal(result.error, undefined, `unexpected error: ${result.error?.message}`);
    assertSameAudio(result.audio, server.expectedAudio(), "F3 delivered audio");
    assert.ok(
      result.tailMs >= FALLBACK_MS - 50 && result.tailMs <= FALLBACK_MS + 300,
      `tail ${result.tailMs}ms should be the ${FALLBACK_MS}ms fallback — neither the retired idle gap nor an unbounded hang`,
    );
    const last = result.chunks[result.chunks.length - 1];
    assert.equal(last?.isFinal, true, "the fallback still emits the final sentinel");
  } finally {
    await server.close();
  }
});

await test("F4 — audio already in `pending` is drained BEFORE the stream ends on `final` (slow consumer)", async () => {
  // Frames burst out fast and `final` follows within 1ms, while the
  // consumer takes 150ms over every chunk — so the event is observed
  // long before the consumer has taken the frames it precedes.
  const frames: Frame[] = Array.from({ length: 8 }, (_, i) => ({
    bytes: FRAME_275MS,
    gapMsBefore: i === 0 ? 20 : 5,
  }));
  const server = await startFakeSarvam({ frames });
  try {
    const result = await drain(providerFor(server.baseUrl), TEXT_LONG, {
      onChunk: () => sleep(150),
    });
    assert.equal(result.error, undefined, `unexpected error: ${result.error?.message}`);
    assertSameAudio(result.audio, server.expectedAudio(), "F4 every frame drained before completion");
    const last = result.chunks[result.chunks.length - 1];
    assert.equal(last?.isFinal, true, "the final sentinel comes after every audio chunk");
    assert.equal(
      result.chunks.filter((c) => c.audio.data.byteLength > 0).length,
      frames.length,
      "one yielded chunk per frame — none dropped behind the event",
    );
  } finally {
    await server.close();
  }
});

await test("F5 — pre-opened (warm) socket: same url with send_completion_event=true, still virgin, completes on `final`", async () => {
  const server = await startFakeSarvam({ frames: COMMON_FRAMES });
  const provider = providerFor(server.baseUrl);
  try {
    provider.prepareSession("session-F5");
    await server.awaitConnections(1);
    await sleep(150);
    assert.deepEqual(server.receivedTypes(), [], "a parked socket must carry no config/text/flush");

    const result = await drain(provider, TEXT_LONG, { sessionId: "session-F5" });
    assert.equal(result.error, undefined, `unexpected error: ${result.error?.message}`);
    assertSameAudio(result.audio, server.expectedAudio(), "F5 warm-path utterance");
    assert.equal(server.connections(), 1, "the warm socket was used; no second socket was opened");
    assert.ok(result.tailMs <= EVENT_TAIL_MAX_MS, `tail ${result.tailMs}ms — warm path did not return on the event`);

    // The url both paths share — the pre-open is to the very same url the
    // fresh path uses, so the opt-in parameter is present on it.
    for (const url of server.connectionUrls()) {
      assert.match(url, /[?&]send_completion_event=true(&|$)/, `connection url lacks the opt-in: ${url}`);
    }
  } finally {
    provider.disposeSession("session-F5");
    await server.close();
  }
});

await test("F6 — virgin-socket rule intact: the warm socket is handed out once, and a second utterance opens its own", async () => {
  const server = await startFakeSarvam({ frames: COMMON_FRAMES });
  const provider = providerFor(server.baseUrl);
  try {
    provider.prepareSession("session-F6");
    await server.awaitConnections(1);
    const first = await drain(provider, TEXT_LONG, { sessionId: "session-F6" });
    assertSameAudio(first.audio, server.expectedAudio(), "F6 first utterance");
    const second = await drain(provider, TEXT_LONG, { sessionId: "session-F6" });
    assertSameAudio(second.audio, server.expectedAudio(), "F6 second utterance");
    assert.equal(server.connections(), 2, "one warm socket + one fresh socket — never a reuse");
    assert.equal(server.headerFrames(), 2, "exactly one RIFF header per socket");
    for (const url of server.connectionUrls()) assert.match(url, /send_completion_event=true/);
  } finally {
    provider.disposeSession("session-F6");
    await server.close();
  }
});

await test("F7 — barge-in DURING a stall aborts immediately: the abort wakes the wait, no fallback is paid, no sentinel", async () => {
  const frames: Frame[] = [
    { bytes: FRAME_413MS, gapMsBefore: 20 },
    { bytes: FRAME_413MS, gapMsBefore: 60 },
    { bytes: FRAME_413MS, gapMsBefore: 3000 }, // the stall the abort lands in
    { bytes: FRAME_413MS, gapMsBefore: 60 },
  ];
  const server = await startFakeSarvam({ frames });
  try {
    const controller = new AbortController();
    let abortedAt = 0;
    const result = await drain(providerFor(server.baseUrl), TEXT_LONG, {
      signal: controller.signal,
      onChunk: async (_chunk, index) => {
        if (index === 1) {
          await sleep(300); // well inside the 3000ms stall
          abortedAt = Date.now();
          controller.abort();
        }
      },
    });
    const returnedAfterAbortMs = Date.now() - abortedAt;
    assert.equal(result.error, undefined, `abort must not surface as an error: ${result.error?.message}`);
    assert.ok(
      returnedAfterAbortMs <= 100,
      `returned ${returnedAfterAbortMs}ms after abort — the abort did not wake the wait (fallback is ${FALLBACK_MS}ms)`,
    );
    assert.equal(result.chunks.filter((c) => c.audio.data.byteLength > 0).length, 2, "exactly the two chunks before the abort");
    assert.equal(result.chunks.some((c) => c.isFinal), false, "an interrupted utterance emits no final sentinel");
  } finally {
    await server.close();
  }
});

await test("F8 — consecutive sentence chunks each complete fully, each on its own `final`", async () => {
  const server = await startFakeSarvam({ frames: COMMON_FRAMES });
  const provider = providerFor(server.baseUrl);
  try {
    const texts = ["Haan ji, bilkul.", "Kya aap abhi do minute baat kar sakte hain?", TEXT_LONG];
    for (const [i, text] of texts.entries()) {
      const result = await drain(provider, text, { sessionId: "session-F8" });
      assert.equal(result.error, undefined, `chunk ${i}: ${result.error?.message}`);
      assertSameAudio(result.audio, server.expectedAudio(), `F8 chunk ${i}`);
      assert.ok(result.tailMs <= EVENT_TAIL_MAX_MS, `chunk ${i} tail ${result.tailMs}ms — did not return on the event`);
    }
    assert.equal(server.connections(), texts.length, "one socket per utterance, as always");
  } finally {
    await server.close();
  }
});

await test("F9 — an `event` of any other type is ignored: only event_type \"final\" completes the stream", async () => {
  const server = await startFakeSarvam({ frames: COMMON_FRAMES, preEventType: "start" });
  try {
    const result = await drain(providerFor(server.baseUrl), TEXT_LONG);
    assert.equal(result.error, undefined, `unexpected error: ${result.error?.message}`);
    assertSameAudio(result.audio, server.expectedAudio(), "F9 full utterance despite a non-final event");
  } finally {
    await server.close();
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(`failed: ${failures.join(", ")}`);
  process.exit(1);
}
