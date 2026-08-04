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

/**
 * Simple linear-interpolation resampler. Not audiophile-grade, but
 * sufficient for telephony-quality 8kHz voice, and dependency-free —
 * pulling in a native resampling library is unnecessary weight for
 * a single mu-law voice channel.
 */
export function resamplePcm16(input: Int16Array, fromRateHz: number, toRateHz: number): Int16Array {
  if (fromRateHz === toRateHz || input.length === 0) return input;

  const ratio = fromRateHz / toRateHz;
  const outLength = Math.max(1, Math.round(input.length / ratio));
  const out = new Int16Array(outLength);

  for (let i = 0; i < outLength; i += 1) {
    const srcPos = i * ratio;
    const srcIndex = Math.floor(srcPos);
    const frac = srcPos - srcIndex;
    const a = input[srcIndex] ?? input[input.length - 1] ?? 0;
    const b = input[srcIndex + 1] ?? a;
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

/** Convert inbound 8kHz mu-law bytes from Plivo to PCM_16 bytes at a target rate (rarely needed; Deepgram accepts MULAW directly). */
export function mulaw8kToPcm16(mulawBytes: Uint8Array): Uint8Array {
  return pcm16ToBytes(mulawToPcm16(mulawBytes));
}