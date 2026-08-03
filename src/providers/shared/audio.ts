/**
 * audio.ts (providers/shared)
 *
 * Some TTS vendors (Sarvam, Smallest AI) return audio wrapped in a
 * RIFF/WAV container rather than a bare PCM stream. Per
 * `AudioPayload`'s doc comment, transcoding to the platform's closed
 * `AudioEncoding` set is the adapter's responsibility — this helper
 * centralizes that WAV -> raw-PCM extraction so it isn't duplicated
 * across every vendor adapter that happens to emit WAV.
 */

export interface DecodedWav {
  readonly pcm: Uint8Array;
  readonly sampleRateHz: number;
  readonly bitsPerSample: number;
  readonly channels: number;
}

/**
 * Parse a RIFF/WAVE buffer, locating the `fmt ` and `data` chunks by
 * walking the chunk table rather than assuming a fixed 44-byte
 * header, since some vendors emit extra metadata chunks.
 */
export function decodeWav(buffer: Uint8Array): DecodedWav {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  const riff = readAscii(view, 0, 4);
  const wave = readAscii(view, 8, 4);
  if (riff !== "RIFF" || wave !== "WAVE") {
    throw new Error("Expected a RIFF/WAVE buffer but the header magic did not match.");
  }

  let offset = 12;
  let sampleRateHz: number | undefined;
  let bitsPerSample: number | undefined;
  let channels: number | undefined;
  let dataStart: number | undefined;
  let dataLength: number | undefined;

  while (offset + 8 <= view.byteLength) {
    const chunkId = readAscii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkBodyStart = offset + 8;

    if (chunkId === "fmt ") {
      channels = view.getUint16(chunkBodyStart + 2, true);
      sampleRateHz = view.getUint32(chunkBodyStart + 4, true);
      bitsPerSample = view.getUint16(chunkBodyStart + 14, true);
    } else if (chunkId === "data") {
      dataStart = chunkBodyStart;
      dataLength = chunkSize;
    }

    // Chunks are word-aligned; skip padding byte when size is odd.
    offset = chunkBodyStart + chunkSize + (chunkSize % 2);
  }

  if (sampleRateHz === undefined || bitsPerSample === undefined || channels === undefined) {
    throw new Error("WAV buffer is missing a valid \"fmt \" chunk.");
  }
  if (dataStart === undefined || dataLength === undefined) {
    throw new Error("WAV buffer is missing a \"data\" chunk.");
  }

  return {
    pcm: buffer.subarray(dataStart, dataStart + dataLength),
    sampleRateHz,
    bitsPerSample,
    channels,
  };
}

function readAscii(view: DataView, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += String.fromCharCode(view.getUint8(offset + i));
  }
  return out;
}
