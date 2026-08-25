/**
 * sarvam-stream-tests.ts — `npm run test:sarvam-stream`
 *
 * THE SARVAM PREMATURE-TRUNCATION DEFECT, AND THE BOUNDED SAFETY
 * MECHANISM THAT REPLACES IT.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────
 *
 * Sarvam's WebSocket TTS protocol has NO end-of-stream marker. Every
 * frame is `{type:"audio"}` with identical keys, the socket is not
 * closed by the server, and the streaming WAV header it opens with
 * declares `0xFFFFFFFF` for both the RIFF size and the `data` subchunk
 * size — verified against the live account, so there is no declared
 * length to read either. Completion can only be inferred from silence.
 *
 * `synthesizeStream` inferred it from an idle gap sized
 * `min(SARVAM_STREAM_IDLE_GAP_MS, max(MIN_IDLE_GAP_MS,
 * widestFrameGapMs * IDLE_GAP_SAFETY_FACTOR))`. Two things were wrong
 * with that, and they compound:
 *
 *   1. `widestFrameGapMs` is 0 until two frames have arrived, so
 *      `widest * 4` is 0 and the budget collapsed to the 300ms floor
 *      exactly in the window where nothing about the cadence was known.
 *
 *   2. The 300ms floor is BELOW the vendor's own delivery quantum.
 *      Measured on the live account across 18 runs (8kHz PCM_16, so
 *      16000 bytes/s), frame sizes are quantised multiples of 2200
 *      bytes and which multiple you get varies run to run on identical
 *      text:
 *
 *        2200 B = 138ms of audio      6600 B = 413ms of audio
 *        4400 B = 275ms of audio      8800 B = 550ms of audio
 *
 *      On four of six runs of one 134-character sentence the stream was
 *      mostly 6600- and 8800-byte frames. A vendor that routinely hands
 *      over 413-550ms of audio per frame was being given 300ms to
 *      produce the next one.
 *
 * The audit's worst reproduction delivered `frames=2, audio=0.82s` of a
 * 5.97s sentence — 14%. Two 6600-byte frames is 13200 bytes is 0.825s.
 * The byte count matches the quantum EXACTLY: it was not a short read,
 * it was two ordinary frames followed by one ordinary gap that the
 * budget was too small to survive. The caller heard a fragment and the
 * pipeline recorded the whole text as spoken.
 *
 * ── HOW THIS SUITE TESTS IT ────────────────────────────────────────
 *
 * Against the REAL `SarvamTextToSpeechProvider`, over a REAL WebSocket,
 * to a LOCAL fake Sarvam server on 127.0.0.1 whose frame schedule each
 * test writes. Nothing here contacts Sarvam, places a call, reads the
 * database or touches Google. The provider's socket handling, its RIFF
 * stripping, its parity guard, its abort path, its REST fallback and
 * its idle-gap arithmetic are all the shipped code — only the vendor on
 * the other end of the socket is local, which is what makes frame
 * timing exact instead of flaky.
 *
 * `A1` and `A7` assert their own premise: each recomputes the SHIPPED
 * budget rule over its own schedule and asserts that rule WOULD have
 * truncated, so neither test can quietly stop reproducing the defect it
 * exists for. `A6` is the opposite tripwire — it fails if someone
 * "fixes" truncation by reverting to a fixed 700ms wait, which would
 * hand back the per-chunk-boundary latency the adaptive gap won.
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

/** The shipped constants, restated here so the tripwires can use them. */
const SHIPPED_MIN_IDLE_GAP_MS = 300;
const SHIPPED_SAFETY_FACTOR = 4;
const CONFIGURED_IDLE_GAP_MS = 700;
const CONFIGURED_START_TIMEOUT_MS = 6000;
/** `MAX_IDLE_GAP_MS` in the provider — the hard bound on the budget. */
const HARD_BOUND_MS = 1200;

/**
 * The BUDGET RULE AS IT SHIPPED, reimplemented as a pure function over
 * a frame schedule. Used by `A1`/`A7` to assert that their schedule
 * really does trigger the defect, and by `A6` to state what the tail
 * used to be. Not used by production code.
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

  wss.on("connection", (socket: WsSocket) => {
    let flushed = false;
    socket.on("message", async (raw: Buffer) => {
      let parsed: { type?: string; data?: Record<string, unknown> };
      try {
        parsed = JSON.parse(raw.toString()) as typeof parsed;
      } catch {
        return;
      }
      if (parsed.type === "config") configFrames.push(parsed);
      if (parsed.type !== "flush" || flushed) return;
      flushed = true;

      // The streaming RIFF header, as its own frame, with the
      // placeholder sizes the live account really sends.
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
      // The real vendor sends nothing further and does NOT close.
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
  } = {},
): Promise<Drained> {
  const chunks: TtsAudioChunk[] = [];
  const parts: Uint8Array[] = [];
  const startedAt = Date.now();
  let lastAudioAt = startedAt;
  let error: Error | undefined;

  try {
    let index = 0;
    for await (const chunk of provider.synthesizeStream!(task(text), opts.signal)) {
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
    // One frame, no gap ever observed, so the budget is the configured
    // ceiling. It must NOT be the 6s start timeout, and must not hang.
    assert.ok(
      result.tailMs <= CONFIGURED_IDLE_GAP_MS + 250,
      `tail ${result.tailMs}ms should be bounded by the configured ceiling ${CONFIGURED_IDLE_GAP_MS}ms`,
    );
    assert.ok(result.tailMs >= 200, `tail ${result.tailMs}ms is implausibly short — did the wait vanish?`);
  } finally {
    await server.close();
  }
});

await test("A5 — genuine completion then long silence with the socket held open: returns on the gap, not on the silence", async () => {
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
    // The vendor never closes and never marks the end — the generator
    // must still return, and promptly.
    assert.ok(
      result.tailMs <= HARD_BOUND_MS + 250,
      `tail ${result.tailMs}ms must stay inside the hard bound ${HARD_BOUND_MS}ms`,
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
 * THE LATENCY TRIPWIRE. This is what fails if the truncation is "fixed"
 * by reverting to a fixed 700ms wait: on the common cadence — 138ms
 * frames, tight gaps — the tail must still be the 300ms floor, because
 * the pipeline awaits this generator once per sentence chunk and that
 * tail is pure serialisation at every chunk boundary.
 */
await test("A6 — common cadence keeps the ~300ms tail: the adaptive win is NOT given back", async () => {
  const frames: Frame[] = Array.from({ length: 14 }, (_, i) => ({
    bytes: FRAME_138MS,
    gapMsBefore: i === 0 ? 20 : 55,
  }));
  const server = await startFakeSarvam({ frames });
  try {
    const result = await drain(providerFor(server.baseUrl), TEXT_LONG);
    assert.equal(result.error, undefined, `unexpected error: ${result.error?.message}`);
    assertSameAudio(result.audio, server.expectedAudio(), "A6 full utterance");
    // 55ms gaps -> adaptive 220ms -> floored to 300ms. The quantum for
    // a 2200-byte frame is 138ms, below the floor, so the floor governs.
    assert.ok(
      result.tailMs < 550,
      `tail ${result.tailMs}ms should be the ~300ms floor, not the ${CONFIGURED_IDLE_GAP_MS}ms ceiling — the adaptive gap was given back`,
    );
    assert.ok(result.tailMs >= 250, `tail ${result.tailMs}ms is below the ${SHIPPED_MIN_IDLE_GAP_MS}ms floor`);
  } finally {
    await server.close();
  }
});

await test("A8 — one enormous frame cannot license an unbounded tail", async () => {
  // 4 seconds of audio in a single frame. Without the hard bound the
  // delivery-quantum floor would license a 4s tail.
  const frames: Frame[] = [{ bytes: BYTES_PER_SECOND * 4, gapMsBefore: 20 }];
  const server = await startFakeSarvam({ frames });
  try {
    const result = await drain(providerFor(server.baseUrl), TEXT_LONG);
    assert.equal(result.error, undefined, `unexpected error: ${result.error?.message}`);
    assertSameAudio(result.audio, server.expectedAudio(), "A8 full utterance");
    assert.ok(
      result.tailMs <= HARD_BOUND_MS + 300,
      `tail ${result.tailMs}ms must be bounded by ${HARD_BOUND_MS}ms, not by the 4000ms the frame carried`,
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
  const server = await startFakeSarvam({ frames, closeAfterSchedule: true });
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

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(`failed: ${failures.join(", ")}`);
  process.exit(1);
}
