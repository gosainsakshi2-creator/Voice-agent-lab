/**
 * audio-utils.ts
 *
 * Helpers for reasoning about `AudioPayload` bytes without assuming
 * a specific vendor transport. `AudioPayload` is deliberately opaque
 * per its doc comment, so these are estimates for cost/latency
 * bookkeeping and playback-duration simulation, not exact decodes.
 */

import type { AudioPayload } from "../../types/provider.types";

/** Bytes-per-sample assumption per encoding, mono, used only for duration estimates. */
function bytesPerSample(encoding: AudioPayload["encoding"]): number {
  switch (encoding) {
    case "PCM_16":
      return 2;
    case "MULAW":
      return 1;
    case "OPUS":
      // Opus is variably compressed; 2 bytes/sample-equivalent is a
      // reasonable rough estimate for duration purposes only.
      return 2;
  }
}

export function estimateAudioSeconds(payload: AudioPayload): number {
  const perSample = bytesPerSample(payload.encoding);
  const samples = payload.data.byteLength / perSample;
  return payload.sampleRateHz > 0 ? samples / payload.sampleRateHz : 0;
}

/**
 * Wraps an `AsyncIterable<AudioPayload>` so `onChunk` fires as a
 * side effect for every chunk that passes through — used to
 * attribute bytes consumed by a streaming STT call back to the
 * user turn currently being assembled, without needing the STT
 * provider itself to report byte counts.
 */
export async function* withByteCounter(
  source: AsyncIterable<AudioPayload>,
  onChunk: (chunk: AudioPayload) => void,
): AsyncIterable<AudioPayload> {
  for await (const chunk of source) {
    onChunk(chunk);
    yield chunk;
  }
}
