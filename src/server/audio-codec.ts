/**
 * audio-codec.ts
 *
 * Transport-level audio transcoding for the Plivo Media Stream
 * bridge. This is NOT provider logic — it exists because Plivo's
 * media stream protocol is fixed to 8kHz mono mu-law, while TTS
 * providers in the existing Provider Layer emit PCM_16 at whatever
 * sample rate they were configured for (16k/22.05k/24k/44.1k/48k).
 * Something has to sit between "AudioPayload out of the
 * VoiceSessionManager" and "bytes Plivo will actually play", and the
 * transport bridge is the correct, non-architectural place for it —
 * no provider or orchestration file is touched to make this work.
 */

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

/** Encode a single 16-bit PCM sample to 8-bit G.711 mu-law. */
function linearToMulawSample(sampleIn: number): number {
  let sample = sampleIn;
  const sign = sample < 0 ? 0x80 : 0;
  if (sign) sample = -sample;
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;

  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) {
    exponent -= 1;
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  const mulawByte = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return mulawByte;
}

const MULAW_DECODE_TABLE = buildMulawDecodeTable();
function buildMulawDecodeTable(): Int16Array {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i += 1) {
    const mulawByte = ~i & 0xff;
    const sign = mulawByte & 0x80;
    const exponent = (mulawByte >> 4) & 0x07;
    const mantissa = mulawByte & 0x0f;
    let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
    sample -= MULAW_BIAS;
    table[i] = sign ? -sample : sample;
  }
  return table;
}

/** Decode a buffer of G.711 mu-law bytes to 16-bit signed PCM (little-endian). */
export function mulawToPcm16(mulaw: Uint8Array): Int16Array {
  const out = new Int16Array(mulaw.length);
  for (let i = 0; i < mulaw.length; i += 1) {
    out[i] = MULAW_DECODE_TABLE[mulaw[i]!]!;
  }
  return out;
}

/** Encode 16-bit signed PCM samples to G.711 mu-law bytes. */
export function pcm16ToMulaw(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) {
    out[i] = linearToMulawSample(pcm[i]!);
  }
  return out;
}

/** Interpret a little-endian PCM_16 byte buffer as an Int16Array view. */
export function bytesToPcm16(bytes: Uint8Array): Int16Array {
  const aligned = new Uint8Array(bytes.byteLength);
  aligned.set(bytes);
  const view = new DataView(aligned.buffer);
  const out = new Int16Array(bytes.byteLength / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = view.getInt16(i * 2, true);
  }
  return out;
}

export function pcm16ToBytes(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < pcm.length; i += 1) {
    view.setInt16(i * 2, pcm[i]!, true);
  }
  return out;
}

/**
 * Same as `pcm16ToBytes` but writes big-endian (network byte order).
 * Required by Plivo's `audio/x-l16` format (RFC 3551 §4.5.11).
 * Kept separate so `pcm16ToBytes` (little-endian) continues to work
 * for WAV/PCM file processing elsewhere.
 */
export function pcm16ToBigEndianBytes(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < pcm.length; i += 1) {
    view.setInt16(i * 2, pcm[i]!, false); // false = big-endian
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────
 * ANTI-ALIASING LOW-PASS FILTER
 *
 * ROOT CAUSE OF THE "crackly / robotic / metallic" AI VOICE:
 *
 * The previous `resamplePcm16` did linear interpolation only. When
 * the ratio is an exact integer (the 16000 -> 8000 telephony case,
 * ratio = 2), `frac` is ALWAYS 0, so the interpolation term
 * `(b - a) * frac` vanishes and the function degenerates into pure
 * decimation — it simply keeps every 2nd sample and discards the
 * rest.
 *
 * Discarding samples without first removing frequencies above the
 * new Nyquist limit (4 kHz for an 8 kHz output) makes every
 * component between 4 kHz and 8 kHz FOLD BACK into the audible
 * band as a mirror image. Speech sibilants (/s/ /sh/ /f/ /t/ /ch/)
 * and the bright HF detail ElevenLabs voices are full of live
 * exactly in that 4-8 kHz range, so they reappear as loud,
 * inharmonic mid-range buzzing mixed on top of the speech.
 *
 * A 6 kHz sibilant becomes a 2 kHz tone. A 7 kHz one becomes 1 kHz.
 * The result is continuous crackle, a metallic/robotic timbre, and
 * a raised noise floor — on EVERY utterance, from the very first
 * greeting, identically on Plivo and Vobiz, because both call
 * `pcm16ToMulaw8k` -> `resamplePcm16`.
 *
 * The fix is the standard one: band-limit BEFORE decimating.
 * ──────────────────────────────────────────────────────────────── */

/** Cache of computed FIR kernels, keyed by "fromRate:toRate". */
const antiAliasTapCache = new Map<string, Float32Array>();

/**
 * Builds a Hamming-windowed sinc low-pass FIR kernel with its cutoff
 * placed just below the output Nyquist frequency. 63 taps gives
 * roughly 50 dB of stopband rejection — far more than enough to put
 * the aliased energy well under the mu-law quantisation floor, at a
 * negligible CPU cost for a single 8 kHz voice channel.
 */
function getAntiAliasTaps(fromRateHz: number, toRateHz: number): Float32Array {
  const key = `${fromRateHz}:${toRateHz}`;
  const cached = antiAliasTapCache.get(key);
  if (cached) return cached;

  const numTaps = 63;
  // Cutoff at 0.45 x output rate (3600 Hz for 8 kHz out), expressed
  // in cycles-per-sample of the INPUT rate. The 0.45 (rather than
  // 0.5) leaves a transition band so the filter is fully rolled off
  // by the time it reaches Nyquist.
  const fc = (0.45 * toRateHz) / fromRateHz;
  const taps = new Float32Array(numTaps);
  const mid = (numTaps - 1) / 2;
  let sum = 0;

  for (let i = 0; i < numTaps; i += 1) {
    const n = i - mid;
    const sinc = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (numTaps - 1));
    const value = sinc * window;
    taps[i] = value;
    sum += value;
  }
  // Normalise to unity DC gain so overall loudness is unchanged.
  for (let i = 0; i < numTaps; i += 1) taps[i] = taps[i]! / sum;

  antiAliasTapCache.set(key, taps);
  return taps;
}

/**
 * Applies the FIR kernel to a PCM_16 buffer.
 *
 * Edges use clamp-to-edge (sample replication) rather than
 * zero-padding. Zero-padding would create a ramp-in/ramp-out
 * transient at the start and end of every streamed chunk, which is
 * audible as faint ticking; replication keeps the chunk seams
 * continuous.
 */
function lowPassPcm16(input: Int16Array, taps: Float32Array): Int16Array {
  const length = input.length;
  const numTaps = taps.length;
  const mid = (numTaps - 1) >> 1;
  const out = new Int16Array(length);

  for (let i = 0; i < length; i += 1) {
    let acc = 0;
    for (let k = 0; k < numTaps; k += 1) {
      const idx = i + k - mid;
      const sample = idx < 0 ? input[0]! : idx >= length ? input[length - 1]! : input[idx]!;
      acc += sample * taps[k]!;
    }
    // Clamp: windowed-sinc filters can overshoot (Gibbs phenomenon),
    // and an out-of-range write into an Int16Array wraps around,
    // which would produce a loud click.
    out[i] = acc > 32767 ? 32767 : acc < -32768 ? -32768 : Math.round(acc);
  }
  return out;
}

/**
 * Band-limited resampler.
 *
 * When DOWNsampling (the 16 kHz TTS -> 8 kHz telephony case) the
 * input is first low-pass filtered to the output Nyquist limit, then
 * resampled. Skipping that filter is what caused the distorted AI
 * voice; see the comment block above.
 *
 * When UPsampling, no anti-alias filter is required — linear
 * interpolation alone is sufficient for a telephony voice channel.
 */
export function resamplePcm16(input: Int16Array, fromRateHz: number, toRateHz: number): Int16Array {
  if (fromRateHz === toRateHz || input.length === 0) return input;

  // ── THE FIX: band-limit before decimating ──
  const source =
    toRateHz < fromRateHz ? lowPassPcm16(input, getAntiAliasTaps(fromRateHz, toRateHz)) : input;

  const ratio = fromRateHz / toRateHz;
  const outLength = Math.max(1, Math.round(source.length / ratio));
  const out = new Int16Array(outLength);

  for (let i = 0; i < outLength; i += 1) {
    const srcPos = i * ratio;
    const srcIndex = Math.floor(srcPos);
    const frac = srcPos - srcIndex;
    const a = source[srcIndex] ?? source[source.length - 1] ?? 0;
    const b = source[srcIndex + 1] ?? a;
    out[i] = Math.round(a + (b - a) * frac);
  }
  return out;
}

/** Convert any supported PCM_16 sample rate down to 8kHz mu-law bytes ready for Plivo playback. */
export function pcm16ToMulaw8k(pcmBytes: Uint8Array, sourceSampleRateHz: number): Uint8Array {
  const pcm = bytesToPcm16(pcmBytes);
  const resampled = resamplePcm16(pcm, sourceSampleRateHz, 8000);
  return pcm16ToMulaw(resampled);
}

/* ────────────────────────────────────────────────────────────────
 * OUTBOUND SEAM SMOOTHER
 *
 * `pcm16ToMulaw8k` is CALLED FRESH for every `AudioPayload` chunk
 * that reaches a bridge's `enqueueOutbound`. For streaming TTS
 * (ElevenLabs) that is roughly every ~100ms; for batch TTS (Cartesia,
 * Sarvam, Smallest AI) it is once per LLM-generated sentence. Either
 * way, `resamplePcm16`'s anti-alias filter treats every call as an
 * independent buffer and pads its edges by replicating that buffer's
 * own boundary sample — it has no way to know what came immediately
 * before or after in the real, continuous utterance.
 *
 * That per-call edge assumption is usually close enough to be
 * inaudible, but not always: whenever the true signal was still
 * moving at the moment a chunk boundary happens to fall, replication
 * produces a small but real discontinuity right at that seam — heard
 * as an intermittent tick/tear, not a constant hiss, which is why it
 * reads as "slightly crackly / torn" rather than gross corruption:
 * only the handful of samples immediately around each seam are
 * affected, not the chunk's contents as a whole.
 *
 * A fully stateful fix (carrying real FIR history and a continuous
 * resample phase across calls) is the "correct" answer but is a
 * meaningfully larger, easier-to-get-subtly-wrong change than
 * warranted here. A short linear crossfade across each seam is the
 * standard, minimal, provably-safe de-click technique: it can't
 * introduce a value outside the range of the two real signals being
 * blended, and it removes exactly the kind of instantaneous jump
 * that the ear reads as a click — regardless of the exact filter
 * mechanics that produced it. Kept as an OPT-IN wrapper so any
 * existing one-shot caller of `pcm16ToMulaw8k` (e.g. tests, or a
 * future batch-only path) is completely unaffected.
 * ──────────────────────────────────────────────────────────────── */

/** Number of 8kHz output samples blended across each chunk boundary (1ms). */
const SEAM_CROSSFADE_SAMPLES = 8;

export interface OutboundMulawEncoder {
  /** Encode one outbound `AudioPayload`'s PCM bytes, smoothing the seam against the previous call. */
  encode(pcmBytes: Uint8Array, sourceSampleRateHz: number): Uint8Array;
}

/**
 * Creates a small stateful wrapper around `pcm16ToMulaw8k` that
 * crossfades each new chunk's leading edge against the previous
 * chunk's trailing edge, in the 8kHz PCM domain, before mu-law
 * encoding. One instance should live for the lifetime of a single
 * outbound call (created once per bridge attachment) — never shared
 * across sessions, since the crossfade only makes sense within one
 * continuous audio stream.
 */
export function createOutboundMulawEncoder(): OutboundMulawEncoder {
  let previousTail: Int16Array | undefined;

  return {
    encode(pcmBytes: Uint8Array, sourceSampleRateHz: number): Uint8Array {
      const pcm = bytesToPcm16(pcmBytes);
      const resampled = resamplePcm16(pcm, sourceSampleRateHz, 8000);

      if (previousTail && previousTail.length > 0 && resampled.length > 0) {
        const n = Math.min(SEAM_CROSSFADE_SAMPLES, previousTail.length, resampled.length);
        for (let i = 0; i < n; i += 1) {
          // weight ramps 0->1 across the overlap so sample 0 is mostly
          // the previous chunk's true tail and sample n-1 is mostly
          // this chunk's own (correct) content.
          const weight = (i + 1) / (n + 1);
          const prev = previousTail[previousTail.length - n + i]!;
          const curr = resampled[i]!;
          resampled[i] = Math.round(prev * (1 - weight) + curr * weight);
        }
      }

      previousTail =
        resampled.length >= SEAM_CROSSFADE_SAMPLES
          ? resampled.slice(resampled.length - SEAM_CROSSFADE_SAMPLES)
          : resampled.slice();

      return pcm16ToMulaw(resampled);
    },
  };
}

/** Convert inbound 8kHz mu-law bytes from Plivo to PCM_16 bytes at a target rate (rarely needed; Deepgram accepts MULAW directly). */
export function mulaw8kToPcm16(mulawBytes: Uint8Array): Uint8Array {
  return pcm16ToBytes(mulawToPcm16(mulawBytes));
}