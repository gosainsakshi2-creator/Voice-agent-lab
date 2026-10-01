/**
 * export-call-audio.ts — `npx tsx src/campaign/tools/export-call-audio.ts [attemptId|latest]`
 *
 * Writes a test call's caller-side audio (`RECORD_CALL_AUDIO=true`, stored
 * in `call_metrics.raw.recording`) to `recordings/<attemptId>.wav` (16-bit
 * PCM, 8kHz mono — any player opens it), and the spans in which the agent
 * was speaking to `recordings/<attemptId>.json`. READ-ONLY on the database.
 *
 * The recordings folder is git-ignored: this is caller audio.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { config } from "dotenv";

config({ path: ".env.local" });

const { getDbPool } = await import("../db/client");
const { mulawToPcm16 } = await import("../../server/audio-codec");

const wanted = process.argv[2] ?? "latest";
const pool = getDbPool();
try {
  const rows = await pool.query(
    wanted === "latest"
      ? `select call_attempt_id, raw->'recording' as recording from call_metrics
           where raw ? 'recording' order by call_attempt_id desc limit 50`
      : `select call_attempt_id, raw->'recording' as recording from call_metrics where call_attempt_id = $1`,
    wanted === "latest" ? [] : [wanted],
  );
  let row = rows.rows[0];
  if (wanted === "latest" && rows.rows.length > 1) {
    // call_attempt_id is a uuid, so order by the attempt's own time instead.
    const ids = rows.rows.map((r) => r.call_attempt_id);
    const latest = await pool.query(`select id from call_attempts where id = any($1) order by created_at desc limit 1`, [ids]);
    row = rows.rows.find((r) => r.call_attempt_id === latest.rows[0]?.id) ?? row;
  }
  if (row === undefined || row.recording == null) {
    console.log(`No recording for ${wanted}. Was RECORD_CALL_AUDIO=true on the server for that call?`);
  } else {
    const rec = row.recording as { base64: string; sampleRateHz: number; durationMs: number; speakingSpans: Array<[number, number]> };
    const mulaw = new Uint8Array(Buffer.from(rec.base64, "base64"));
    const pcm = mulawToPcm16(mulaw);
    const header = Buffer.alloc(44);
    const dataBytes = pcm.length * 2;
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + dataBytes, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(rec.sampleRateHz, 24);
    header.writeUInt32LE(rec.sampleRateHz * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(dataBytes, 40);
    await mkdir("recordings", { recursive: true });
    const base = join("recordings", String(row.call_attempt_id));
    await writeFile(`${base}.wav`, Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, dataBytes)]));
    await writeFile(`${base}.json`, JSON.stringify({ durationMs: rec.durationMs, agentSpeakingSpansMs: rec.speakingSpans }, null, 2));
    console.log(`Wrote ${base}.wav (${(rec.durationMs / 1000).toFixed(1)}s) and ${base}.json (${rec.speakingSpans.length} agent-speaking spans)`);
  }
} finally {
  await pool.end();
}
