/**
 * speech-gap-probe.ts — TEMPORARY DIAGNOSTIC (not part of any suite)
 *
 * Measures the complete text -> speech path for ONE provider and
 * reports, per chunk, exactly where wall-clock silence would appear on
 * a live call:
 *
 *   chunk text / chunk creation time
 *   TTS request start + end
 *   first audio availability (TTFA)
 *   generated audio duration
 *   queue wait (transport backpressure)
 *   playback start
 *   GAP = previous audio ending -> next audio starting
 *
 * It drives the REAL SentenceChunker, the REAL provider adapters and a
 * faithful replica of the Plivo bridge's outbound pump (same frame
 * size, pre-roll, high/low water marks), so a gap reported here is a
 * gap the caller hears.
 *
 * Usage:  npx tsx src/campaign/tests/speech-gap-probe.ts <provider>
 */

import { config as loadEnvFile } from "dotenv";

loadEnvFile({ path: ".env.local", quiet: true });
loadEnvFile({ quiet: true });

const { SentenceChunker } = await import("../../core/session/sentence-chunker");
const { createOutboundMulawEncoder, createOutboundMulawFramer } = await import(
  "../../server/audio-codec"
);
const { SupportedLanguage } = await import("../../types/enums");
const { CartesiaTextToSpeechProvider } = await import(
  "../../providers/text-to-speech/cartesia.provider"
);
const { SarvamTextToSpeechProvider } = await import(
  "../../providers/text-to-speech/sarvam.provider"
);
const { SmallestAiTextToSpeechProvider } = await import(
  "../../providers/text-to-speech/smallest-ai.provider"
);

interface ProbeAudio {
  data: Uint8Array;
  encoding: string;
  sampleRateHz: number;
}

// ---- Bridge constants, mirrored from plivo-media-bridge.ts ----------
const FRAME_BYTES = 160;
const FRAME_MS = 20;
const PREROLL_FRAMES = 5;
const PREROLL_MAX_WAIT_MS = 120;
const HIGH_WATER = 140;
const LOW_WATER = 110;

/** The reply text the model produces for the opening block of the call. */
const DEFAULT_TEXT =
  "Hi Rahul, this is Ishita from Team FlexiFunnels. Actually, I am calling you with a very interesting invitation. " +
  "We have created Flexi Genie, which helps you build and automate your online business just by chatting with AI.";

const REPLY = process.env.PROBE_TEXT ?? DEFAULT_TEXT;

function providerFor(id: string) {
  switch (id) {
    case "cartesia":
      return new CartesiaTextToSpeechProvider();
    case "sarvam":
      return new SarvamTextToSpeechProvider();
    case "smallest-ai":
      return new SmallestAiTextToSpeechProvider();
    default:
      throw new Error(`unknown provider "${id}"`);
  }
}

/** Split a reply into LLM-shaped token deltas (word-aligned). */
function toDeltas(text: string): string[] {
  return text.split(/(?<=\s)/u);
}

/**
 * Virtual transport clock. Models the bridge pump: frames leave at
 * exactly 20ms each, playback starts one pre-roll after the first
 * frame is queued, and the producer parks while the queue is above the
 * high-water mark.
 */
class VirtualTransport {
  private readonly encoder = createOutboundMulawEncoder();
  private readonly framer = createOutboundMulawFramer(FRAME_BYTES);
  /** Wall clock (ms) at which the last queued frame will have played out. */
  playbackEndsAt = 0;
  playbackStartedAt = 0;
  queuedFrames = 0;

  enqueue(audio: ProbeAudio, now: number): { startsAt: number; backpressureMs: number } {
    const mulaw = this.encoder.encode(audio.data, audio.sampleRateHz);
    const frames = this.framer.push(mulaw);

    const stillQueuedMs = Math.max(0, this.playbackEndsAt - now);
    this.queuedFrames = Math.round(stillQueuedMs / FRAME_MS);

    let startsAt: number;
    if (this.playbackEndsAt <= now) {
      // Pump had run dry (or never started): it re-prerolls.
      const preroll = Math.min(PREROLL_FRAMES * FRAME_MS, PREROLL_MAX_WAIT_MS);
      startsAt = now + preroll;
      if (this.playbackStartedAt === 0) this.playbackStartedAt = startsAt;
    } else {
      startsAt = this.playbackEndsAt;
    }
    this.playbackEndsAt = startsAt + frames.length * FRAME_MS;
    this.queuedFrames += frames.length;

    const backpressureMs =
      this.queuedFrames > HIGH_WATER ? (this.queuedFrames - LOW_WATER) * FRAME_MS : 0;
    return { startsAt, backpressureMs };
  }
}

async function main(): Promise<void> {
  const providerId = process.argv[2] ?? "cartesia";
  const tts = providerFor(providerId);
  const language = SupportedLanguage.ENGLISH;
  const hasStream = typeof (tts as { synthesizeStream?: unknown }).synthesizeStream === "function";

  console.log(`\n== SPEECH-GAP PROBE — ${providerId} (streaming=${hasStream}) ==`);
  console.log(`text (${REPLY.length} chars): ${REPLY}\n`);

  // ---- Stage A: chunking ------------------------------------------
  const chunker = new SentenceChunker();
  const chunks: Array<{ text: string; readyAtMs: number }> = [];
  const DELTA_MS = 35; // typical streaming cadence, one delta per word
  let virtualLlmMs = 0;
  for (const delta of toDeltas(REPLY)) {
    virtualLlmMs += DELTA_MS;
    for (const ready of chunker.push(delta)) {
      chunks.push({ text: ready, readyAtMs: virtualLlmMs });
    }
  }
  const tail = chunker.flush();
  if (tail) chunks.push({ text: tail, readyAtMs: virtualLlmMs });

  console.log(`-- A. CHUNKING — ${chunks.length} TTS request(s) --`);
  for (const [i, c] of chunks.entries()) {
    console.log(
      `  #${i} (${String(c.text.length).padStart(3)} chars, ready@${c.readyAtMs}ms) "${c.text}"`,
    );
  }

  // ---- Stage B..E: synthesis, queueing, playback -------------------
  console.log(`\n-- B-E. SYNTHESIS / QUEUE / PLAYBACK --`);
  const transport = new VirtualTransport();
  const t0 = Date.now();
  let previousAudioEndsAt = 0;
  let totalGapMs = 0;

  for (const [i, chunk] of chunks.entries()) {
    const requestStart = Date.now();
    let ttfaMs: number | undefined;
    let pcmBytes = 0;
    let sampleRate = 0;
    let firstPlayStart: number | undefined;
    let backpressureTotalMs = 0;

    /**
     * Enqueue exactly where `ConversationPipeline.playAudioChunk` does:
     * per audio chunk as it arrives, awaiting the transport's
     * backpressure inline — NOT once at the end of the request.
     */
    const deliver = async (audio: ProbeAudio): Promise<void> => {
      const { startsAt, backpressureMs } = transport.enqueue(audio, Date.now());
      firstPlayStart ??= startsAt;
      if (backpressureMs > 0) {
        backpressureTotalMs += backpressureMs;
        await new Promise((r) => setTimeout(r, backpressureMs));
      }
    };

    if (hasStream) {
      const stream = (
        tts as {
          synthesizeStream: (
            t: unknown,
            s?: AbortSignal,
          ) => AsyncIterable<{ audio: ProbeAudio }>;
        }
      ).synthesizeStream({ sessionId: "probe", request: { text: chunk.text, language } });
      for await (const part of stream) {
        if (part.audio.data.byteLength === 0) continue;
        ttfaMs ??= Date.now() - requestStart;
        pcmBytes += part.audio.data.byteLength;
        sampleRate = part.audio.sampleRateHz;
        await deliver(part.audio);
      }
    } else {
      const audio = await (
        tts as { synthesize: (t: unknown) => Promise<ProbeAudio> }
      ).synthesize({ sessionId: "probe", request: { text: chunk.text, language } });
      ttfaMs = Date.now() - requestStart;
      pcmBytes = audio.data.byteLength;
      sampleRate = audio.sampleRateHz;
      await deliver(audio);
    }

    const requestEnd = Date.now();
    const durationMs = sampleRate > 0 ? (pcmBytes / 2 / sampleRate) * 1000 : 0;
    const startsAt = firstPlayStart ?? requestEnd;

    const gapMs = i === 0 ? 0 : Math.max(0, startsAt - previousAudioEndsAt);
    totalGapMs += gapMs;
    previousAudioEndsAt = transport.playbackEndsAt;

    console.log(
      `  #${i} req@+${requestStart - t0}ms end@+${requestEnd - t0}ms ` +
        `ttfa=${ttfaMs ?? "n/a"}ms synth=${requestEnd - requestStart}ms ` +
        `audio=${Math.round(durationMs)}ms queueWait=${backpressureTotalMs}ms ` +
        `playStart@+${startsAt - t0}ms GAP=${Math.round(gapMs)}ms`,
    );
  }

  console.log(
    `\n  TOTAL DEAD AIR INSIDE THE REPLY: ${Math.round(totalGapMs)}ms across ` +
      `${Math.max(0, chunks.length - 1)} boundaries\n`,
  );
}

await main();
process.exit(0);
