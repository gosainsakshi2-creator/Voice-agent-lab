/**
 * smallest-ai-stream-tests.ts — `npm run test:smallest-stream`
 *
 * SMALLEST AI: BATCH SYNTHESIS -> SSE STREAMING, AND THE TWELVE
 * BEHAVIOURS IT MUST NOT COST.
 *
 * ── WHY THE CHANGE ─────────────────────────────────────────────────
 *
 * `synthesize()` goes through `postJsonForBinary`, which ends in
 * `await response.arrayBuffer()`. It cannot yield a byte until the LAST
 * byte of the body has landed, so its time-to-first-audio is the whole
 * render plus the whole body transfer. Production, 100 real turns on
 * this lane: **958ms p50 / 1928ms p90** — the slowest of the three
 * campaign lanes, on a third of all calls.
 *
 * Measured against the live account through the real provider class,
 * same text, same voice, same `speed: .92`:
 *
 *   chars   batch first audio   stream first audio   saved
 *     16          982ms               705ms          277ms
 *     80         1001ms               538ms          463ms
 *    110         1165ms               579ms          586ms
 *
 * ── WHY THE AUDIO IS THE SAME AUDIO ────────────────────────────────
 *
 * Four batch and four stream calls on one 110-character sentence:
 *
 *   BATCH  200428, 195684, 196548, 190112   spread 5.3%
 *   STREAM 196208, 195770, 195770, 195684   spread 0.3%
 *   mean stream / mean batch = 1.0008
 *
 * The vendor is NON-DETERMINISTIC in clip length — batch varies 5.3%
 * against itself — so a single-sample comparison can show the stream
 * 9% short and mean nothing. On means the two paths agree to **0.1%**,
 * and the stream is the more consistent of the two. `A13` is the
 * standing assertion of that parity against a server that renders one
 * clip and serves it down both paths, where it must be EXACT.
 *
 * ── WHAT THE WIRE ACTUALLY LOOKS LIKE ──────────────────────────────
 *
 * Traced, not assumed, because "streaming" does not promise the first
 * event is playable:
 *
 *   event: audio
 *   data: {"audio":"<base64 RAW PCM>","done":false,"status":"206"}
 *   ...
 *   data: {"status":"200","done":true}          <- no `event:` line
 *
 * Three consequences, each covered below: the payload is RAW PCM with
 * NO container even though the request asks for `output_format: "wav"`
 * (`A10`); the first audio event is immediately playable (`A1`); and
 * there IS an explicit end-of-stream marker (`A4`), unlike Sarvam.
 * Errors are HTTP 400 with a JSON body, not an SSE event (`A6`).
 *
 * ── HOW THIS SUITE TESTS IT ────────────────────────────────────────
 *
 * SECTION A drives the REAL `SmallestAiTextToSpeechProvider` over REAL
 * fetch/SSE to a LOCAL fake vendor on 127.0.0.1. SECTION B puts that
 * same real provider inside the REAL `ConversationPipeline` and
 * re-asserts every safety-critical behaviour on it — barge-in before
 * audio and mid-playback, background voice, the Hello attention check,
 * resume-after-Hello, the agent closing that drives the hang-up, and
 * cost. That is stronger than the fake-provider coverage in
 * `test:tts-streaming`, because here the thing under test is the
 * provider that will actually run in production.
 *
 * NOTHING HERE PLACES A CALL, CONTACTS SMALLEST AI, READS THE DATABASE
 * OR TOUCHES GOOGLE.
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const { SmallestAiTextToSpeechProvider } = await import(
  "../../providers/text-to-speech/smallest-ai.provider"
);
const { ConversationPipeline } = await import("../../core/session/conversation-pipeline");
const { SessionRecord } = await import("../../core/session/session-record");
const { agentClosedIn } = await import("../dispatch/call-runner");
const { estimateTtsCost } = await import("../../core/session/cost-estimator");
const { TEXT_TO_SPEECH_PROVIDER_IDS } = await import("../../constants/providers.constants");
const { SessionState, SupportedLanguage, CallDirection, ProviderCategory } = await import(
  "../../types/enums"
);

import type { AudioPayload, ConversationTurn, TranscriptSegment } from "../../types/provider.types";
import type { CompletionRequest } from "../../interfaces/providers/language-model-provider.interface";
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

/**
 * 8kHz PCM_16 so one second of audio is exactly 16000 bytes, which is
 * what lets a test say "interrupt 600ms into the reply" and mean it.
 * Production runs at 16000Hz; the rate is config, and `A3` asserts the
 * configured value is what both paths actually send.
 */
const SAMPLE_RATE_HZ = 8000;
const BYTES_PER_SECOND = SAMPLE_RATE_HZ * 2;

/** ~22 chars/second is ordinary speech — used to size a fake clip. */
const CHARS_PER_SECOND = 22;

/** Measured payload sizes ran 48-5516 bytes, always even. */
const EVENT_BYTES = 5122;
/** Measured: the vendor's first audio event arrives before the body ends. */
const VENDOR_FIRST_EVENT_MS = 25;
const VENDOR_EVENT_GAP_MS = 6;

function clipBytesFor(text: string): number {
  const seconds = Math.max(0.05, text.length / CHARS_PER_SECOND);
  // Even, so the parity guard is exercised only where a test asks for it.
  return Math.round((seconds * BYTES_PER_SECOND) / 2) * 2;
}

/** Position-derived, so a reorder or a dropped chunk is detectable. */
function clipFor(text: string): Uint8Array {
  const bytes = new Uint8Array(clipBytesFor(text));
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31 + text.length) % 251;
  return bytes;
}

// ═════════════════════════════════════════════════════════════════
// THE LOCAL FAKE SMALLEST AI
//
// One HTTP server on 127.0.0.1 serving BOTH endpoints, from the SAME
// rendered clip — which is what makes the batch/stream byte-parity
// assertion in `A13` meaningful rather than a comparison of two
// independent vendor renders.
//
//   POST /waves/v1/tts                       -> a WAV container
//   POST /api/v1/lightning-v3.1/stream       -> SSE, raw PCM payloads
// ═════════════════════════════════════════════════════════════════

interface FakeVendor {
  readonly baseUrl: string;
  /** Bodies received on the batch endpoint, in order. */
  readonly batchBodies: Array<Record<string, unknown>>;
  /** Bodies received on the stream endpoint, in order. */
  readonly streamBodies: Array<Record<string, unknown>>;
  /** The exact PCM the server rendered for a given text. */
  clipFor(text: string): Uint8Array;
  close(): Promise<void>;
}

interface FakeVendorOptions {
  /** Fail the stream request with this HTTP status before any audio. */
  readonly streamStatus?: number;
  /** Drop the connection after this many audio events (a mid-stream failure). */
  readonly killAfterEvents?: number;
  /** Omit the `done:true` terminal record and just end the body. */
  readonly omitDoneMarker?: boolean;
  /** Separate SSE records with CRLF CRLF rather than LF LF. */
  readonly useCrLf?: boolean;
  /** Prepend a 44-byte RIFF header to the first audio payload. */
  readonly riffOnFirstPayload?: boolean;
  /** Make the first audio payload odd-length. */
  readonly oddFirstPayload?: boolean;
  /** Emit comment/keep-alive and unknown-event records between audio. */
  readonly noiseRecords?: boolean;
  /** Emit records after the `done:true` marker. */
  readonly recordsAfterDone?: boolean;
  /** Bytes per audio event. */
  readonly eventBytes?: number;
  /**
   * Pad the STREAMED clip with digital silence, the way the live vendor
   * does (measured 80-300ms leading, 350-380ms trailing on every clip).
   * `internalSilenceMs` inserts a pause at the clip's midpoint, which
   * must survive untouched.
   */
  readonly leadSilenceMs?: number;
  readonly trailSilenceMs?: number;
  readonly internalSilenceMs?: number;
}

const silence = (ms: number): Uint8Array => new Uint8Array(Math.round((ms * BYTES_PER_SECOND) / 1000 / 2) * 2);

/** The clip as the fake vendor streams it: `clipFor(text)` with the requested silence padding. */
function paddedClipFor(text: string, options: FakeVendorOptions): Uint8Array {
  const core = clipFor(text);
  const mid = Math.floor(core.byteLength / 4) * 2;
  const body =
    options.internalSilenceMs === undefined
      ? core
      : Buffer.concat([core.subarray(0, mid), silence(options.internalSilenceMs), core.subarray(mid)]);
  return new Uint8Array(
    Buffer.concat([silence(options.leadSilenceMs ?? 0), body, silence(options.trailSilenceMs ?? 0)]),
  );
}

function wavContainer(pcm: Uint8Array): Uint8Array {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.byteLength, 4);
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
  header.writeUInt32LE(pcm.byteLength, 40);
  return new Uint8Array(Buffer.concat([header, Buffer.from(pcm)]));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const parts: Buffer[] = [];
  for await (const chunk of req) parts.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function startFakeVendor(options: FakeVendorOptions = {}): Promise<FakeVendor> {
  const batchBodies: Array<Record<string, unknown>> = [];
  const streamBodies: Array<Record<string, unknown>> = [];
  const sep = options.useCrLf === true ? "\r\n\r\n" : "\n\n";
  const nl = options.useCrLf === true ? "\r\n" : "\n";
  const eventBytes = options.eventBytes ?? EVENT_BYTES;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = req.url ?? "";
      const body = await readBody(req);
      const text = typeof body.text === "string" ? body.text : "";

      if (url.endsWith("/waves/v1/tts")) {
        batchBodies.push(body);
        const wav = wavContainer(clipFor(text));
        res.writeHead(200, { "Content-Type": "audio/wav" });
        res.end(Buffer.from(wav));
        return;
      }

      if (!url.endsWith("/api/v1/lightning-v3.1/stream")) {
        res.writeHead(404).end();
        return;
      }

      streamBodies.push(body);
      if (options.streamStatus !== undefined) {
        res.writeHead(options.streamStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: [{ code: "custom", path: ["voice_id"], message: "Invalid Voice ID" }] }));
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const pcm = paddedClipFor(text, options);
      await sleep(VENDOR_FIRST_EVENT_MS);

      let sent = 0;
      let events = 0;
      while (sent < pcm.byteLength) {
        if (res.destroyed) return;
        if (options.killAfterEvents !== undefined && events === options.killAfterEvents) {
          // A mid-stream vendor failure: the body simply stops.
          req.socket.destroy();
          return;
        }
        let slice: Uint8Array = pcm.subarray(sent, Math.min(sent + eventBytes, pcm.byteLength));
        sent += slice.byteLength;

        if (events === 0 && options.riffOnFirstPayload === true) {
          slice = new Uint8Array(Buffer.concat([Buffer.from(wavContainer(new Uint8Array(0))).subarray(0, 44), Buffer.from(slice)]));
        }
        if (events === 0 && options.oddFirstPayload === true) {
          // Hand back an odd number of bytes: half a PCM_16 sample.
          sent -= 1;
          slice = slice.subarray(0, slice.byteLength - 1);
        }

        if (options.noiseRecords === true && events === 1) {
          res.write(`: keep-alive${sep}`);
          res.write(`event: metadata${nl}data: {"status":"206"}${sep}`);
          res.write(`${nl}${sep}`);
        }

        res.write(
          `event: audio${nl}data: ${JSON.stringify({
            audio: Buffer.from(slice).toString("base64"),
            done: false,
            status: "206",
          })}${sep}`,
        );
        events += 1;
        await sleep(VENDOR_EVENT_GAP_MS);
      }

      if (options.omitDoneMarker !== true) {
        res.write(`data: ${JSON.stringify({ status: "200", done: true })}${sep}`);
      }
      if (options.recordsAfterDone === true) {
        // Must be ignored: audio after the end marker would be played
        // twice or played late.
        res.write(
          `event: audio${nl}data: ${JSON.stringify({
            audio: Buffer.from(new Uint8Array(2048)).toString("base64"),
            done: false,
            status: "206",
          })}${sep}`,
        );
      }
      res.end();
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    batchBodies,
    streamBodies,
    clipFor,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function providerFor(baseUrl: string) {
  return new SmallestAiTextToSpeechProvider({
    apiKey: "test-key",
    baseUrl,
    streamBaseUrl: baseUrl,
    defaultVoiceId: "test-voice",
    sampleRateHz: SAMPLE_RATE_HZ,
  });
}

const task = (text: string): SynthesisTaskRequest => ({
  sessionId: "smallest-stream-test" as SessionId,
  request: { text, language: SupportedLanguage.HINGLISH },
});

interface Drained {
  readonly chunks: readonly TtsAudioChunk[];
  readonly audio: Uint8Array;
  readonly firstAudioMs?: number;
  readonly totalMs: number;
  readonly error?: Error;
}

async function drain(
  provider: InstanceType<typeof SmallestAiTextToSpeechProvider>,
  text: string,
  opts: {
    readonly signal?: AbortSignal;
    readonly onChunk?: (chunk: TtsAudioChunk, index: number) => void | Promise<void>;
  } = {},
): Promise<Drained> {
  const chunks: TtsAudioChunk[] = [];
  const parts: Uint8Array[] = [];
  const startedAt = Date.now();
  let firstAudioMs: number | undefined;
  let error: Error | undefined;

  try {
    let index = 0;
    for await (const chunk of provider.synthesizeStream!(task(text), opts.signal)) {
      chunks.push(chunk);
      if (chunk.audio.data.byteLength > 0) {
        firstAudioMs ??= Date.now() - startedAt;
        parts.push(chunk.audio.data);
      }
      await opts.onChunk?.(chunk, index);
      index += 1;
    }
  } catch (err) {
    error = err instanceof Error ? err : new Error(String(err));
  }

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
    ...(firstAudioMs !== undefined ? { firstAudioMs } : {}),
    totalMs: Date.now() - startedAt,
    ...(error ? { error } : {}),
  };
}

function assertSameAudio(got: Uint8Array, expected: Uint8Array, what: string): void {
  assert.equal(
    got.byteLength,
    expected.byteLength,
    `${what}: expected ${expected.byteLength} bytes (${(expected.byteLength / BYTES_PER_SECOND).toFixed(2)}s) but got ${got.byteLength} (${(got.byteLength / BYTES_PER_SECOND).toFixed(2)}s)`,
  );
  assert.deepEqual(Buffer.from(got), Buffer.from(expected), `${what}: bytes differ or are out of order`);
}

const TEXT_LONG =
  "Actually, I am calling you with a very interesting invitation. " +
  "We have created Flexi Genie which helps you build your online business.";
const TEXT_SHORT = "Haan ji, bilkul.";

// ═════════════════════════════════════════════════════════════════
section("SECTION A — the provider contract (real fetch/SSE, local vendor)");
// ═════════════════════════════════════════════════════════════════

await test("A1 — first audio arrives BEFORE the whole clip has been transferred", async () => {
  const vendor = await startFakeVendor();
  try {
    const result = await drain(providerFor(vendor.baseUrl), TEXT_LONG);
    assert.equal(result.error, undefined, `unexpected error: ${result.error?.message}`);
    assert.ok(result.firstAudioMs !== undefined, "no audio was emitted at all");
    assert.ok(
      result.chunks.filter((c) => c.audio.data.byteLength > 0).length > 3,
      "expected a multi-event stream, so 'first' and 'last' are distinguishable",
    );
    // The whole point of the change: the first byte is available long
    // before the last one. `arrayBuffer()` could only ever return both
    // at the same instant.
    assert.ok(
      result.firstAudioMs! < result.totalMs * 0.6,
      `first audio at ${result.firstAudioMs}ms of a ${result.totalMs}ms transfer — that is not streaming`,
    );
  } finally {
    await vendor.close();
  }
});

await test("A2 — multi-chunk streaming delivers every byte, in order, exactly once", async () => {
  const vendor = await startFakeVendor();
  try {
    const result = await drain(providerFor(vendor.baseUrl), TEXT_LONG);
    assert.equal(result.error, undefined, `unexpected error: ${result.error?.message}`);
    assertSameAudio(result.audio, vendor.clipFor(TEXT_LONG), "A2 clip");
    result.chunks.forEach((chunk, i) => {
      assert.equal(chunk.sequence, i, `chunk ${i} sequence`);
      assert.equal(chunk.audio.encoding, "PCM_16", `chunk ${i} encoding`);
      assert.equal(chunk.audio.sampleRateHz, SAMPLE_RATE_HZ, `chunk ${i} sample rate`);
    });
    const last = result.chunks[result.chunks.length - 1];
    assert.equal(last?.isFinal, true, "the last chunk must be the final sentinel");
    assert.equal(last?.audio.data.byteLength, 0, "the final sentinel carries no audio");
  } finally {
    await vendor.close();
  }
});

/**
 * The voice-quality assertion, and the reason `requestBody` exists.
 * Both paths must send the SAME generation parameters — otherwise the
 * caller hears a different voice depending on which branch the pipeline
 * took, which is exactly what the ElevenLabs adapter does today.
 */
await test("A3 — batch and streaming request bodies are IDENTICAL: voice, sample rate, format, speed", async () => {
  const vendor = await startFakeVendor();
  try {
    const provider = providerFor(vendor.baseUrl);
    await provider.synthesize(task(TEXT_LONG));
    await drain(provider, TEXT_LONG);

    assert.equal(vendor.batchBodies.length, 1, "expected one batch request");
    assert.equal(vendor.streamBodies.length, 1, "expected one stream request");
    assert.deepEqual(
      vendor.streamBodies[0],
      vendor.batchBodies[0],
      "the two paths sent different bodies — voice, speed, rate or format can now drift",
    );
    // And state what those values are, so a silent change to any of
    // them fails here rather than in someone's ear.
    assert.deepEqual(vendor.streamBodies[0], {
      text: TEXT_LONG,
      voice_id: "test-voice",
      sample_rate: SAMPLE_RATE_HZ,
      output_format: "wav",
      speed: 0.92,
    });
  } finally {
    await vendor.close();
  }
});

await test("A13 — streaming and batch return the SAME audio: byte count and duration", async () => {
  const vendor = await startFakeVendor();
  try {
    const provider = providerFor(vendor.baseUrl);
    const batch = await provider.synthesize(task(TEXT_LONG));
    const streamed = await drain(provider, TEXT_LONG);

    assert.equal(
      streamed.audio.byteLength,
      batch.data.byteLength,
      `byte count differs: stream ${streamed.audio.byteLength} vs batch ${batch.data.byteLength}`,
    );
    assert.deepEqual(
      Buffer.from(streamed.audio),
      Buffer.from(batch.data),
      "the two paths returned different samples for the same text",
    );
    assert.equal(batch.sampleRateHz, SAMPLE_RATE_HZ, "batch decodes its rate from the WAV header");
    assert.equal(
      streamed.chunks[0]?.audio.sampleRateHz,
      batch.sampleRateHz,
      "streaming must report the same sample rate the batch WAV declares, or the duration maths diverge",
    );
    // Duration is what the cost and the drain both read.
    const streamSeconds = streamed.audio.byteLength / BYTES_PER_SECOND;
    const batchSeconds = batch.data.byteLength / BYTES_PER_SECOND;
    assert.ok(
      Math.abs(streamSeconds - batchSeconds) < 1e-9,
      `duration differs: ${streamSeconds}s vs ${batchSeconds}s`,
    );
  } finally {
    await vendor.close();
  }
});

// ── Edge-silence trim (2026-08-25) ────────────────────────────────
//
// Live measurement: the vendor bakes 80-300ms of leading and 350-380ms
// of trailing silence into EVERY clip, so with one request per sentence
// the caller heard ~430-680ms of dead air at each sentence boundary.
// Cartesia's edges are 0-90ms. The adapter now trims each edge down to
// 50ms. At 8kHz: 10ms window = 160 bytes, 50ms keep = 800 bytes; the
// window grid is evaluated per event, so at most one extra window may
// survive at an edge — hence the 960-byte ceiling.

const KEEP_BYTES = 800;
const EDGE_CEILING_BYTES = KEEP_BYTES + 160;

function isAllZero(bytes: Uint8Array): boolean {
  for (const b of bytes) if (b !== 0) return false;
  return true;
}

/** Where `core` sits inside `out`, or -1. */
function indexOfCore(out: Uint8Array, core: Uint8Array): number {
  return Buffer.from(out).indexOf(Buffer.from(core));
}

await test("A14 — vendor leading/trailing silence is trimmed to ≤50ms per edge; the speech itself is byte-exact", async () => {
  const vendor = await startFakeVendor({ leadSilenceMs: 300, trailSilenceMs: 360 });
  try {
    const result = await drain(providerFor(vendor.baseUrl), TEXT_LONG);
    assert.equal(result.error, undefined, `unexpected error: ${result.error?.message}`);
    const core = vendor.clipFor(TEXT_LONG);
    const at = indexOfCore(result.audio, core);
    assert.ok(at >= 0, "the speech bytes must be delivered intact and in order");
    const lead = result.audio.subarray(0, at);
    const trail = result.audio.subarray(at + core.byteLength);
    assert.ok(isAllZero(lead) && isAllZero(trail), "only silence may surround the speech");
    assert.ok(lead.byteLength <= EDGE_CEILING_BYTES, `leading silence ${lead.byteLength} bytes (${lead.byteLength / 16}ms) survived — expected ≤ ${EDGE_CEILING_BYTES / 16}ms of the vendor's 300ms`);
    assert.ok(trail.byteLength <= EDGE_CEILING_BYTES, `trailing silence ${trail.byteLength} bytes (${trail.byteLength / 16}ms) survived — expected ≤ ${EDGE_CEILING_BYTES / 16}ms of the vendor's 360ms`);
    assert.ok(lead.byteLength % 2 === 0 && trail.byteLength % 2 === 0, "trim must stay PCM_16 sample-aligned");
    const last = result.chunks[result.chunks.length - 1];
    assert.equal(last?.isFinal, true, "the final sentinel must still close the stream");
    result.chunks.forEach((chunk, i) => assert.equal(chunk.sequence, i, `chunk ${i} sequence`));
  } finally {
    await vendor.close();
  }
});

await test("A15 — an internal pause is preserved byte-for-byte; only the clip's edges are trimmed", async () => {
  const vendor = await startFakeVendor({ leadSilenceMs: 240, trailSilenceMs: 360, internalSilenceMs: 200 });
  try {
    const result = await drain(providerFor(vendor.baseUrl), TEXT_LONG);
    assert.equal(result.error, undefined, `unexpected error: ${result.error?.message}`);
    // The body = speech + 200ms pause + speech, exactly as the vendor sent it.
    const core = vendor.clipFor(TEXT_LONG);
    const mid = Math.floor(core.byteLength / 4) * 2;
    const body = new Uint8Array(Buffer.concat([core.subarray(0, mid), silence(200), core.subarray(mid)]));
    const at = indexOfCore(result.audio, body);
    assert.ok(at >= 0, "the internal 200ms pause must survive untouched between the two speech halves");
    assert.ok(at <= EDGE_CEILING_BYTES, `leading silence ${at / 16}ms survived`);
    assert.ok(result.audio.byteLength - at - body.byteLength <= EDGE_CEILING_BYTES, "trailing silence survived");
  } finally {
    await vendor.close();
  }
});

await test("A16 — a clip with no edge silence is delivered unchanged (the trim is a no-op on clean audio)", async () => {
  const vendor = await startFakeVendor();
  try {
    const result = await drain(providerFor(vendor.baseUrl), TEXT_LONG);
    assertSameAudio(result.audio, vendor.clipFor(TEXT_LONG), "A16 clip");
  } finally {
    await vendor.close();
  }
});

await test("A17 — trimming does not delay speech: the first yield is the first event carrying speech, not the end of the clip", async () => {
  // 300ms of leading silence at 8kHz is 4800 bytes — under one 5122-byte
  // event, so speech is in event 1. Whatever the vendor pads, the
  // first playable yield must arrive well before the transfer ends.
  const vendor = await startFakeVendor({ leadSilenceMs: 300, trailSilenceMs: 360 });
  try {
    const result = await drain(providerFor(vendor.baseUrl), TEXT_LONG);
    assert.ok(result.firstAudioMs !== undefined, "no audio emitted");
    assert.ok(
      result.firstAudioMs! < result.totalMs * 0.6,
      `first audio at ${result.firstAudioMs}ms of ${result.totalMs}ms — trimming must not turn the stream back into a batch`,
    );
    const first = result.chunks.find((c) => c.audio.data.byteLength > 0)!;
    assert.ok(!isAllZero(first.audio.data), "the first yielded chunk must contain speech, not the vendor's leading pad");
  } finally {
    await vendor.close();
  }
});

await test("A18 — the trimmer alone: an all-silent clip collapses to ≤50ms, and held silence is bounded by the 600ms cap", async () => {
  const { EdgeSilenceTrimmer } = await import("../../providers/text-to-speech/smallest-ai.provider");
  // All silent, under the cap: nothing emitted until finish, then ≤ keep.
  const t1 = new EdgeSilenceTrimmer(SAMPLE_RATE_HZ);
  assert.equal(t1.push(silence(200)), undefined);
  assert.equal(t1.push(silence(200)), undefined);
  const tail = t1.finish();
  assert.ok((tail?.byteLength ?? 0) <= KEEP_BYTES, `all-silent clip emitted ${tail?.byteLength} bytes`);

  // Leading silence beyond the cap is discarded down to the cap, never emitted.
  const t2 = new EdgeSilenceTrimmer(SAMPLE_RATE_HZ);
  for (let i = 0; i < 10; i += 1) assert.equal(t2.push(silence(100)), undefined, "leading silence is never emitted");
  const speech = clipFor(TEXT_SHORT);
  const out = t2.push(speech)!;
  assert.ok(indexOfCore(out, speech) <= KEEP_BYTES, "speech is preceded by at most the kept 50ms");

  // An internal pause longer than the cap is flushed intact, not dropped.
  const t3 = new EdgeSilenceTrimmer(SAMPLE_RATE_HZ);
  t3.push(speech);
  let flushed = 0;
  for (let i = 0; i < 7; i += 1) flushed += t3.push(silence(100))?.byteLength ?? 0;
  const after = t3.push(speech)!;
  const pauseBytes = flushed + indexOfCore(after, speech);
  assert.equal(pauseBytes, silence(700).byteLength, `internal pause of 700ms came out as ${pauseBytes / 16}ms`);
});

await test("A4 — the explicit done:true marker ends the stream, and anything after it is ignored", async () => {
  const vendor = await startFakeVendor({ recordsAfterDone: true });
  try {
    const result = await drain(providerFor(vendor.baseUrl), TEXT_LONG);
    assert.equal(result.error, undefined, `unexpected error: ${result.error?.message}`);
    // The 2048 zero bytes the server wrote after `done` must NOT appear.
    assertSameAudio(result.audio, vendor.clipFor(TEXT_LONG), "A4 clip");
  } finally {
    await vendor.close();
  }
});

await test("A5 — a stream that ends without a done marker still completes on the body ending", async () => {
  const vendor = await startFakeVendor({ omitDoneMarker: true });
  try {
    const result = await drain(providerFor(vendor.baseUrl), TEXT_LONG);
    assert.equal(result.error, undefined, `unexpected error: ${result.error?.message}`);
    assertSameAudio(result.audio, vendor.clipFor(TEXT_LONG), "A5 clip");
    assert.ok(result.chunks.some((c) => c.isFinal), "completion must still be marked");
  } finally {
    await vendor.close();
  }
});

await test("A6 — an HTTP error before any audio falls back to the blocking REST call, never to silence", async () => {
  const vendor = await startFakeVendor({ streamStatus: 400 });
  try {
    const result = await drain(providerFor(vendor.baseUrl), TEXT_LONG);
    assert.equal(result.error, undefined, `the fallback should absorb this: ${result.error?.message}`);
    assert.equal(vendor.batchBodies.length, 1, "expected exactly one REST fallback call");
    assertSameAudio(result.audio, vendor.clipFor(TEXT_LONG), "A6 fallback clip");
    assert.ok(result.chunks.some((c) => c.isFinal), "the fallback path still marks completion");
  } finally {
    await vendor.close();
  }
});

await test("A7 — a failure AFTER audio has been queued throws, and does NOT re-synthesize over it", async () => {
  const vendor = await startFakeVendor({ killAfterEvents: 3 });
  try {
    const result = await drain(providerFor(vendor.baseUrl), TEXT_LONG);
    assert.ok(result.error, "a mid-stream failure must surface, not look like a completed utterance");
    assert.equal(
      vendor.batchBodies.length,
      0,
      "re-synthesizing after audio was queued would replay what the caller already heard",
    );
    assert.ok(
      !result.chunks.some((c) => c.isFinal),
      "a broken stream must not claim it completed",
    );
    assert.ok(result.audio.byteLength > 0, "the audio already delivered is still delivered");
  } finally {
    await vendor.close();
  }
});

await test("A8 — cancellation stops emission promptly and emits no final sentinel", async () => {
  const vendor = await startFakeVendor({ eventBytes: 1024 });
  try {
    const controller = new AbortController();
    const result = await drain(providerFor(vendor.baseUrl), TEXT_LONG, {
      signal: controller.signal,
      onChunk: (_c, index) => {
        if (index === 2) controller.abort();
      },
    });
    assert.ok(result.chunks.length <= 4, `expected emission to stop, got ${result.chunks.length} chunks`);
    assert.ok(!result.chunks.some((c) => c.isFinal), "an aborted stream must not claim it completed");
    assert.ok(
      result.audio.byteLength < vendor.clipFor(TEXT_LONG).byteLength,
      "an aborted stream should not have delivered the whole clip",
    );
    assert.equal(vendor.batchBodies.length, 0, "an abort is not a failure and must not trigger the fallback");
  } finally {
    await vendor.close();
  }
});

await test("A9 — an odd-length event carries its orphan byte instead of shifting every later sample", async () => {
  const vendor = await startFakeVendor({ oddFirstPayload: true });
  try {
    const result = await drain(providerFor(vendor.baseUrl), TEXT_LONG);
    assert.equal(result.error, undefined, `unexpected error: ${result.error?.message}`);
    for (const chunk of result.chunks) {
      assert.equal(chunk.audio.data.byteLength % 2, 0, "an odd-length chunk escaped the parity guard");
    }
    // The carry means nothing is lost and nothing is reordered: the
    // reassembled stream is the clip, byte for byte.
    assertSameAudio(result.audio, vendor.clipFor(TEXT_LONG), "A9 clip");
  } finally {
    await vendor.close();
  }
});

await test("A10 — a RIFF header on the first payload is stripped, never played as samples", async () => {
  const vendor = await startFakeVendor({ riffOnFirstPayload: true });
  try {
    const result = await drain(providerFor(vendor.baseUrl), TEXT_LONG);
    assert.equal(result.error, undefined, `unexpected error: ${result.error?.message}`);
    assert.notEqual(
      Buffer.from(result.audio.subarray(0, 4)).toString("ascii"),
      "RIFF",
      "the container header reached the pipeline as if it were audio",
    );
    assertSameAudio(result.audio, vendor.clipFor(TEXT_LONG), "A10 clip");
  } finally {
    await vendor.close();
  }
});

await test("A11 — comments, keep-alives, blank records and unknown events are ignored, not played", async () => {
  const vendor = await startFakeVendor({ noiseRecords: true });
  try {
    const result = await drain(providerFor(vendor.baseUrl), TEXT_LONG);
    assert.equal(result.error, undefined, `unexpected error: ${result.error?.message}`);
    assertSameAudio(result.audio, vendor.clipFor(TEXT_LONG), "A11 clip");
  } finally {
    await vendor.close();
  }
});

await test("A12 — CRLF record separators parse the same as LF (the SSE spec permits both)", async () => {
  const vendor = await startFakeVendor({ useCrLf: true });
  try {
    const result = await drain(providerFor(vendor.baseUrl), TEXT_LONG);
    assert.equal(result.error, undefined, `unexpected error: ${result.error?.message}`);
    assertSameAudio(result.audio, vendor.clipFor(TEXT_LONG), "A12 clip");
  } finally {
    await vendor.close();
  }
});

// ═════════════════════════════════════════════════════════════════
// SECTION B — THE REAL PROVIDER INSIDE THE REAL PIPELINE
// ═════════════════════════════════════════════════════════════════

interface Harness {
  readonly record: InstanceType<typeof SessionRecord>;
  readonly requests: Array<readonly ConversationTurn[]>;
  readonly synthesized: string[];
  /** Wall clock at which each conversational LLM request was received. */
  readonly llmRequestedAt: number[];
  audioBytes(): number;
  say(text: string, opts?: { isFinal?: boolean; isSpeechFinal?: boolean }): void;
  sayBackground(text: string): void;
  waitFor(what: string, predicate: () => boolean, timeoutMs?: number): Promise<void>;
  waitForReplies(n: number, timeoutMs?: number): Promise<void>;
  history(): readonly ConversationTurn[];
  stop(): Promise<void>;
}

function startHarness(input: {
  readonly baseUrl: string;
  readonly openingLine: string;
  readonly replies: readonly string[];
  /**
   * Delay before the first token of a scripted reply. A barge-in that
   * must land while the model is still THINKING (nothing spoken yet)
   * needs a window to land in.
   */
  readonly replyDelayMs?: number;
}): Harness {
  const requests: Array<readonly ConversationTurn[]> = [];
  const llmRequestedAt: number[] = [];
  const synthesized: string[] = [];
  const segments: TranscriptSegment[] = [];
  const waiters: Array<() => void> = [];
  let closed = false;
  let clockMs = 0;
  let replyIndex = 0;
  let audioBytes = 0;

  const descriptor = (
    category: (typeof ProviderCategory)[keyof typeof ProviderCategory],
    id: string,
  ) => ({
    category,
    id,
    displayName: id,
    supportedLanguages: [SupportedLanguage.ENGLISH, SupportedLanguage.HINGLISH],
    version: "fake",
  });
  const healthy = (identifier: { category: unknown; id: string }) => ({
    identifier,
    isHealthy: true,
    checkedAt: new Date(),
  });

  const stt = {
    descriptor: descriptor(ProviderCategory.SPEECH_TO_TEXT, "fake-stt"),
    transcribe: async () => [],
    checkHealth: async () => healthy(descriptor(ProviderCategory.SPEECH_TO_TEXT, "fake-stt")),
    transcribeStream: async function* (): AsyncIterable<TranscriptSegment> {
      while (!closed) {
        const next = segments.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
  };

  const llm = {
    descriptor: descriptor(ProviderCategory.LANGUAGE_MODEL, "fake-llm"),
    generateCompletion: async (request: CompletionRequest) => {
      requests.push(request.history);
      return { turn: { role: "assistant" as const, content: "", timestamp: new Date() }, latencyMs: 0 };
    },
    checkHealth: async () => healthy(descriptor(ProviderCategory.LANGUAGE_MODEL, "fake-llm")),
    generateCompletionStream: async function* (request: CompletionRequest, signal?: AbortSignal) {
      // `primeLlmPrefixCache` sends the system turn ALONE while the
      // greeting plays and abandons the stream at its first event. Not
      // a conversational request, so it consumes no scripted reply.
      if (request.history.length === 1 && request.history[0]?.role === "system") {
        yield { type: "token" as const, delta: "", index: 0 };
        return;
      }
      requests.push(request.history);
      const reply = input.replies[replyIndex] ?? "Okay.";
      replyIndex += 1;
      llmRequestedAt.push(Date.now());
      await sleep(input.replyDelayMs ?? 10);
      if (signal?.aborted) return;
      for (const delta of reply.split(/(?<=\s)/u)) {
        if (signal?.aborted) return;
        yield { type: "token" as const, delta, index: 0 };
      }
      yield {
        type: "final" as const,
        turn: { role: "assistant" as const, content: reply, timestamp: new Date() },
        latencyMs: 1,
      };
    },
  };

  /**
   * THE REAL PROVIDER. Not a fake modelling a shape — the shipped
   * `SmallestAiTextToSpeechProvider`, pointed at the local vendor, with
   * `synthesize` wrapped only to record what was asked for.
   */
  const real = providerFor(input.baseUrl);
  const tts = {
    descriptor: descriptor(ProviderCategory.TEXT_TO_SPEECH, "smallest-ai"),
    checkHealth: async () => healthy(descriptor(ProviderCategory.TEXT_TO_SPEECH, "smallest-ai")),
    synthesize: async (t: SynthesisTaskRequest) => {
      synthesized.push(t.request.text);
      return real.synthesize(t);
    },
    synthesizeStream: (t: SynthesisTaskRequest, signal?: AbortSignal) => {
      synthesized.push(t.request.text);
      return real.synthesizeStream!(t, signal);
    },
  };

  const telephony = {
    descriptor: descriptor(ProviderCategory.TELEPHONY, "fake-telephony"),
    startCall: async () => ({ providerCallId: "fake", startedAt: new Date() }),
    endCall: async () => undefined,
    checkHealth: async () => healthy(descriptor(ProviderCategory.TELEPHONY, "fake-telephony")),
  };

  const stack = {
    telephony: { category: ProviderCategory.TELEPHONY, id: "fake-telephony" },
    speechToText: { category: ProviderCategory.SPEECH_TO_TEXT, id: "fake-stt" },
    languageModel: { category: ProviderCategory.LANGUAGE_MODEL, id: "fake-llm" },
    textToSpeech: { category: ProviderCategory.TEXT_TO_SPEECH, id: "smallest-ai" },
  };

  const record = new SessionRecord(
    "smallest-stream-test" as SessionId,
    {
      language: SupportedLanguage.ENGLISH,
      direction: CallDirection.OUTBOUND,
      providerStack: stack,
      destinationNumber: "+910000000000",
      campaign: {
        campaignId: "test",
        campaignType: "registration",
        scriptId: "test",
        scriptVersion: "v1",
        scriptHash: "test",
        agent: { gender: "male", name: "Rohan" },
        customer: { name: "Sakshi" },
        openingLine: input.openingLine,
        systemPromptAppendix: "TEST APPENDIX",
      },
    },
    stack,
  );

  record.loopAbortController = new AbortController();
  record.state = SessionState.CALLING;
  record.outboundAudioListeners.add((audio: AudioPayload) => {
    audioBytes += audio.data.byteLength;
    return undefined;
  });

  const host = {
    transition: (
      r: InstanceType<typeof SessionRecord>,
      to: (typeof SessionState)[keyof typeof SessionState],
    ) => {
      r.state = to;
    },
    markError: () => undefined,
  };

  const pipeline = new ConversationPipeline(record, { telephony, stt, llm, tts } as never, host as never);
  const loop = pipeline.run();

  const push = (text: string, isFinal: boolean, isSpeechFinal: boolean, confidence: number): void => {
    const startedAtMs = clockMs;
    clockMs += Math.max(200, (text.length / CHARS_PER_SECOND) * 1000);
    segments.push({
      text,
      isFinal,
      isSpeechFinal,
      confidence,
      language: SupportedLanguage.ENGLISH,
      startedAtMs,
      endedAtMs: clockMs,
    });
    waiters.shift()?.();
  };

  return {
    record,
    requests,
    synthesized,
    llmRequestedAt,
    audioBytes: () => audioBytes,
    say(text, opts) {
      const isFinal = opts?.isFinal ?? true;
      push(text, isFinal, opts?.isSpeechFinal ?? isFinal, 0.95);
    },
    sayBackground(text) {
      push(text, true, true, 0.2);
    },
    async waitFor(what, predicate, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await sleep(20);
      }
      throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`);
    },
    async waitForReplies(n, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const replies = record.memory.history().filter((t) => t.role === "assistant").length;
        if (replies >= n && record.state === SessionState.LISTENING) return;
        await sleep(20);
      }
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${n} replies (have ${
          record.memory.history().filter((t) => t.role === "assistant").length
        }, state=${record.state})`,
      );
    },
    history() {
      return record.memory.history().filter((t) => t.role !== "system");
    },
    async stop() {
      closed = true;
      for (const waiter of waiters.splice(0)) waiter();
      record.loopAbortController?.abort();
      await Promise.race([loop, sleep(500)]).catch(() => undefined);
    },
  };
}

function assistantTexts(history: readonly ConversationTurn[]): string[] {
  return history.filter((t) => t.role === "assistant").map((t) => t.content);
}

const norm = (s: string) => s.replace(/\s+/gu, " ").trim();

const OPENING = "Hi Sakshi, this is Rohan from Team FlexiFunnels.";
const BLOCK =
  "Actually, I am calling you with a very interesting invitation. " +
  "We have created Flexi Genie, which helps you build and automate your online business just by chatting with AI. " +
  "It builds funnels, pages, products, checkout, courses and emails from plain instructions.";

section("SECTION B — the real provider inside the real pipeline");

await test("B1 — a short reply is spoken once, in full, and committed once", async () => {
  const vendor = await startFakeVendor();
  const h = startHarness({
    baseUrl: vendor.baseUrl,
    openingLine: OPENING,
    replies: ["Yes, the registration is completely free."],
  });
  try {
    await h.waitFor("greeting", () => h.record.state === SessionState.LISTENING, 20000);
    h.say("What is this about?");
    await h.waitForReplies(2, 30000);
    const spoken = assistantTexts(h.history());
    assert.equal(spoken.length, 2, `expected opening + one reply, got ${spoken.length}`);
    assert.equal(norm(spoken[0]!), norm(OPENING));
    assert.equal(norm(spoken[1]!), "Yes, the registration is completely free.");
    assert.ok(h.audioBytes() > 0, "no audio reached the transport");
  } finally {
    await h.stop();
    await vendor.close();
  }
});

await test("B2 — a long multi-sentence reply streams every chunk, in order, reconstructing it exactly", async () => {
  const vendor = await startFakeVendor();
  const h = startHarness({ baseUrl: vendor.baseUrl, openingLine: OPENING, replies: [BLOCK] });
  try {
    await h.waitFor("greeting", () => h.record.state === SessionState.LISTENING, 20000);
    h.say("Tell me more.");
    await h.waitForReplies(2, 30000);
    const spoken = assistantTexts(h.history());
    assert.equal(norm(spoken[1]!), norm(BLOCK), "the reply was not reconstructed exactly");
    // The chunker cut it, so more than one synthesis request was made,
    // and their concatenation must be the block with nothing lost or
    // doubled.
    const afterOpening = h.synthesized.slice(1);
    assert.ok(afterOpening.length >= 2, `expected the block to be chunked, got ${afterOpening.length} request(s)`);
    assert.equal(norm(afterOpening.join(" ")), norm(BLOCK), "the chunks do not reconstruct the block");
  } finally {
    await h.stop();
    await vendor.close();
  }
});

await test("B3 — barge-in during TTS, before any audio: the superseded reply is never committed", async () => {
  const vendor = await startFakeVendor();
  const h = startHarness({
    baseUrl: vendor.baseUrl,
    openingLine: OPENING,
    replies: [BLOCK, "The answer to the newer question."],
    replyDelayMs: 400,
  });
  try {
    await h.waitFor("greeting", () => h.record.state === SessionState.LISTENING, 20000);
    h.say("Tell me more.");
    await h.waitFor("the model was asked", () => h.llmRequestedAt.length >= 1, 20000);
    // While it is still thinking — nothing spoken yet — the caller asks
    // something newer. The supersession path must be unaffected by the
    // provider now streaming.
    h.say("Actually, what is the price?");
    await h.waitForReplies(2, 30000);

    const spoken = assistantTexts(h.history());
    assert.ok(
      !spoken.some((t) => t.startsWith("Actually, I am calling you")),
      "a reply the caller never heard must not be committed as spoken",
    );
  } finally {
    await h.stop();
    await vendor.close();
  }
});

await test("B4 — barge-in during playback: only the heard prefix is committed", async () => {
  const vendor = await startFakeVendor();
  const h = startHarness({
    baseUrl: vendor.baseUrl,
    openingLine: OPENING,
    replies: [BLOCK, "Yes, it is free."],
  });
  try {
    await h.waitFor("greeting", () => h.record.state === SessionState.LISTENING, 20000);
    const greetingBytes = h.audioBytes();
    h.say("Tell me more.");
    await h.waitFor("the block is playing", () => h.audioBytes() > greetingBytes + 8000, 20000);
    await sleep(300);
    h.say("Wait, is it free?");
    await h.waitForReplies(3, 30000);

    const spoken = assistantTexts(h.history());
    const interrupted = spoken.find((t) => t.startsWith("Actually, I am calling you"));
    assert.ok(interrupted !== undefined, "the part the caller HEARD stays in the history");
    assert.ok(
      interrupted.length < BLOCK.length,
      `only the heard prefix is committed, not the whole block (committed ${interrupted.length} of ${BLOCK.length} chars)`,
    );
    assert.ok(
      !interrupted.includes("from plain instructions"),
      "audio the caller never heard must not be committed as spoken",
    );
    assert.ok(norm(BLOCK).startsWith(norm(interrupted)), "what was committed is not a prefix of the block");
  } finally {
    await h.stop();
    await vendor.close();
  }
});

await test("B5 — an uncorroborated background voice creates no turn and does not stop the block", async () => {
  const vendor = await startFakeVendor();
  const h = startHarness({
    baseUrl: vendor.baseUrl,
    openingLine: OPENING,
    replies: [BLOCK, "SHOULD-NOT-HAPPEN"],
  });
  try {
    await h.waitFor("greeting", () => h.record.state === SessionState.LISTENING, 20000);
    const greetingBytes = h.audioBytes();
    h.say("Tell me more.");
    await h.waitFor("the block is playing", () => h.audioBytes() > greetingBytes + 8000, 20000);
    h.sayBackground("hello");
    await h.waitForReplies(2, 30000);

    const spoken = assistantTexts(h.history());
    assert.equal(spoken.length, 2, "no extra turn was created by the background voice");
    assert.equal(norm(spoken[1]!), norm(BLOCK), "the block finished");
    assert.ok(
      !h.synthesized.some((t) => t.includes("SHOULD-NOT-HAPPEN")),
      "the background voice produced no reply",
    );
  } finally {
    await h.stop();
    await vendor.close();
  }
});

await test("B6 — a bare Hello over the block is acknowledged once, with ZERO language-model requests", async () => {
  const vendor = await startFakeVendor();
  const h = startHarness({
    baseUrl: vendor.baseUrl,
    openingLine: OPENING,
    replies: [BLOCK, "SHOULD-NOT-BE-GENERATED"],
  });
  try {
    await h.waitFor("greeting", () => h.record.state === SessionState.LISTENING, 20000);
    const greetingBytes = h.audioBytes();
    h.say("Tell me more.");
    await h.waitFor("the block is playing", () => h.audioBytes() > greetingBytes + 8000, 20000);
    await sleep(300);
    const requestsBefore = h.requests.length;
    h.say("Hello?");
    await h.waitFor(
      "the acknowledgement was spoken",
      () => h.synthesized.some((t) => t.includes("I can hear you")),
      20000,
    );

    assert.equal(
      h.synthesized.filter((t) => t.includes("I can hear you")).length,
      1,
      "acknowledged exactly once",
    );
    assert.equal(
      h.requests.length,
      requestsBefore,
      "an attention check must spend no generation — Fix #2's core property",
    );
    assert.ok(
      !h.synthesized.some((t) => t.includes("SHOULD-NOT-BE-GENERATED")),
      "no reply was generated for the hello",
    );
  } finally {
    await h.stop();
    await vendor.close();
  }
});

await test("B7 — after the Hello, a confirmation RESUMES the unheard remainder with no generation", async () => {
  const vendor = await startFakeVendor();
  const h = startHarness({
    baseUrl: vendor.baseUrl,
    openingLine: OPENING,
    replies: [BLOCK, "SHOULD-NOT-BE-GENERATED"],
  });
  try {
    await h.waitFor("greeting", () => h.record.state === SessionState.LISTENING, 20000);
    const greetingBytes = h.audioBytes();
    h.say("Tell me more.");
    await h.waitFor("the block is playing", () => h.audioBytes() > greetingBytes + 8000, 20000);
    await sleep(300);
    h.say("Hello?");
    await h.waitFor(
      "acknowledgement",
      () => h.synthesized.some((t) => t.includes("I can hear you")),
      20000,
    );
    const requestsBefore = h.requests.length;
    h.say("Yes, loud and clear.");
    await h.waitFor(
      "the remainder was resumed",
      () => h.synthesized.some((t) => t.includes("Flexi Genie") || t.includes("plain instructions")),
      20000,
    );

    assert.equal(
      h.requests.length,
      requestsBefore,
      "resuming a held remainder must spend no generation either",
    );
    // Nothing already heard is synthesized a second time: the block's
    // opening sentence goes to the vendor exactly once for the call.
    assert.equal(
      h.synthesized.filter((t) => t.includes("very interesting invitation")).length,
      1,
      "nothing already heard is synthesized a second time",
    );
  } finally {
    await h.stop();
    await vendor.close();
  }
});

await test("B8 — an agent closing is the last committed turn, and reads as a closing for the hang-up", async () => {
  const vendor = await startFakeVendor();
  const h = startHarness({
    baseUrl: vendor.baseUrl,
    openingLine: OPENING,
    replies: ["Take care, Sakshi."],
  });
  try {
    await h.waitFor("greeting", () => h.record.state === SessionState.LISTENING, 20000);
    h.say("No thanks, not interested.");
    await h.waitForReplies(2, 30000);
    const history = h.history();
    const spoken = assistantTexts(history);
    assert.equal(norm(spoken[spoken.length - 1]!), "Take care, Sakshi.");
    assert.equal(history[history.length - 1]?.role, "assistant", "the closing must be the last turn");
    assert.equal(h.record.state, SessionState.LISTENING, "the session must be back in LISTENING");
    // The real predicate the campaign watchdog uses.
    assert.equal(
      agentClosedIn(history as ConversationTurn[]),
      true,
      "the closing must satisfy agentClosedIn, or the call is never hung up",
    );
  } finally {
    await h.stop();
    await vendor.close();
  }
});

// ═════════════════════════════════════════════════════════════════
section("SECTION C — cost and generated-duration accounting");
// ═════════════════════════════════════════════════════════════════

await test("C1 — Smallest AI TTS cost is non-zero and character-billed on the streaming path", async () => {
  const id = TEXT_TO_SPEECH_PROVIDER_IDS.SMALLEST_AI;
  // The exact call the pipeline's streaming branch makes.
  const withDuration = estimateTtsCost(id, TEXT_LONG.length, 6.2);
  const withoutDuration = estimateTtsCost(id, TEXT_LONG.length);
  assert.ok(withDuration > 0, "moving to streaming must not zero this lane's TTS cost");
  assert.equal(
    withDuration,
    withoutDuration,
    "Smallest AI bills per character, so the duration argument must not change the cost",
  );
  // And it must NOT be the duration-billed path, which is what would
  // have silently returned 0 (the Cartesia problem in §0).
  assert.ok(
    Math.abs(estimateTtsCost(id, 2000) - 2 * estimateTtsCost(id, 1000)) < 1e-12,
    "character billing should be linear",
  );
});

await test("C2 — generated audio duration equals the audio actually delivered", async () => {
  const vendor = await startFakeVendor();
  try {
    const result = await drain(providerFor(vendor.baseUrl), TEXT_LONG);
    // What the pipeline sums per chunk via `estimateAudioSeconds`:
    // bytes / 2 samples / rate.
    const seconds = result.chunks.reduce(
      (sum, c) => sum + c.audio.data.byteLength / 2 / c.audio.sampleRateHz,
      0,
    );
    const expected = vendor.clipFor(TEXT_LONG).byteLength / BYTES_PER_SECOND;
    assert.ok(
      Math.abs(seconds - expected) < 1e-9,
      `generated duration ${seconds.toFixed(4)}s should equal ${expected.toFixed(4)}s`,
    );
    assert.ok(seconds > 1, "a several-second clip should not report under a second");
  } finally {
    await vendor.close();
  }
});

await test("C3 — an utterance cut short bills for what it generated, not for the clip it would have been", async () => {
  const vendor = await startFakeVendor({ eventBytes: 1024 });
  try {
    const controller = new AbortController();
    const cut = await drain(providerFor(vendor.baseUrl), TEXT_LONG, {
      signal: controller.signal,
      onChunk: (_c, index) => {
        if (index === 2) controller.abort();
      },
    });
    const cutSeconds = cut.chunks.reduce(
      (sum, c) => sum + c.audio.data.byteLength / 2 / c.audio.sampleRateHz,
      0,
    );
    const wholeSeconds = vendor.clipFor(TEXT_LONG).byteLength / BYTES_PER_SECOND;
    assert.ok(cutSeconds > 0, "the part that was generated must still be billed");
    assert.ok(
      cutSeconds < wholeSeconds,
      `interrupted duration ${cutSeconds.toFixed(3)}s should be under the whole clip's ${wholeSeconds.toFixed(3)}s`,
    );
  } finally {
    await vendor.close();
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(`failed: ${failures.join(", ")}`);
  process.exit(1);
}
