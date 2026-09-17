/**
 * wav.ts — wraps the PCM a provider returned in a RIFF/WAVE header.
 *
 * PHASE 4, EVIDENCE STEP. Pure: bytes in, bytes out.
 *
 * ── WHY THIS EXISTS AT ALL ────────────────────────────────────────
 *
 * Every adapter in this stack normalizes its vendor's output to
 * `AudioPayload { data, encoding: "PCM_16", sampleRateHz }` — raw,
 * headerless, little-endian samples. That is exactly what the media
 * bridge wants and exactly what no audio player will open. Evidence
 * nobody can listen to is not evidence, so the 44 bytes that make a
 * `.wav` are written here.
 *
 * The audio itself is NOT resampled, re-encoded, filtered, trimmed or
 * normalized in any way — the samples in the file are byte-for-byte
 * the samples the vendor produced, at the sample rate the adapter
 * asked the vendor for. This file adds a header and nothing else, and
 * it must stay that way: the moment the harness processes audio, the
 * evidence stops describing the provider.
 *
 * No dependency is added for this. A RIFF header is a fixed 44-byte
 * layout; pulling an encoder in to write it would be a new package in
 * the dependency tree for twelve lines of arithmetic.
 *
 * Only PCM_16 is handled. `MULAW` and `OPUS` are in the platform's
 * `AudioEncoding` union but no TTS adapter emits them, so an encoding
 * this file does not understand is refused rather than mislabelled —
 * a `.wav` whose header lies about its contents is worse than no file.
 */

import type { AudioEncoding } from "../../types/provider.types";

/** Bytes of a WAVE header. Fixed by the format. */
export const WAV_HEADER_BYTES = 44;

export class UnsupportedAudioEncodingError extends Error {
  constructor(readonly encoding: string) {
    super(
      `TTS evidence harness cannot write "${encoding}" to a .wav file. ` +
        `Only PCM_16 is supported, which is what every configured TTS adapter returns. ` +
        `Inspect the adapter rather than guessing an encoding here.`,
    );
    this.name = "UnsupportedAudioEncodingError";
  }
}

/**
 * Mono 16-bit PCM plus a RIFF/WAVE header.
 *
 * `pcm` is passed through untouched. An odd byte count would leave a
 * half sample at the end, so it is refused rather than silently
 * truncated — every adapter in this stack already guarantees even
 * alignment, so an odd length means something upstream went wrong and
 * the evidence should say so.
 */
export function pcm16ToWav(
  pcm: Uint8Array,
  sampleRateHz: number,
  encoding: AudioEncoding,
): Uint8Array {
  if (encoding !== "PCM_16") throw new UnsupportedAudioEncodingError(encoding);
  if (pcm.byteLength % 2 !== 0) {
    throw new Error(
      `PCM_16 payload has an odd byte length (${pcm.byteLength}); a whole sample is missing.`,
    );
  }
  if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0) {
    throw new Error(`Invalid sample rate for WAV header: ${sampleRateHz}`);
  }

  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRateHz * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  const out = new Uint8Array(WAV_HEADER_BYTES + pcm.byteLength);
  const view = new DataView(out.buffer);

  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) out[offset + i] = text.charCodeAt(i);
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true); // chunk size = header remainder + data
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // format 1 = uncompressed PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  ascii(36, "data");
  view.setUint32(40, pcm.byteLength, true);

  out.set(pcm, WAV_HEADER_BYTES);
  return out;
}
