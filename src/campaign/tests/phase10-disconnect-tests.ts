/**
 * phase10-disconnect-tests.ts — `npm run test:phase10`
 *
 * WHY LIVE CALLS WERE DROPPING AT RANDOM.
 *
 * Not the silence watchdog's arithmetic — `phase9` already proves that.
 * The watchdog was reading a signal that had died.
 *
 * `client.listen.v1.connect()` returns a RECONNECTING socket. On any
 * close that is not code 1000 it dials again by itself, re-attaches the
 * same message handler, and flushes the audio it buffered while it was
 * down. The provider's `close` and `error` handlers, however, closed the
 * transcript queue on the FIRST such event — the exact event the
 * transport exists to absorb. So one transient blip ended transcription
 * for the rest of the call:
 *
 *   Deepgram socket closes (1006 / 1011)
 *     -> queue.close()
 *     -> the pipeline's listener loop falls out, silently
 *     -> `lastConversationActivityAt` stops advancing
 *     -> the turn detector never fires again, so the pipeline parks in
 *        LISTENING and emits no further state transitions
 *     -> both halves of the watchdog's activity signal are frozen
 *     -> ~20s later: MAX_SILENCE, endCall(), a caller cut off mid-word.
 *
 * Sections A and B are that defect and its fix, at the two levels it
 * has to hold at: the STT stream itself, and the watchdog reading it.
 * Section C is the second guarantee — the transport's own energy VAD now
 * stamps the same activity field, so no future STT stall can be read as
 * silence either. Section D is the carrier concurrency ceiling.
 *
 * NOTHING HERE PLACES A CALL AND NOTHING HERE CONTACTS DEEPGRAM,
 * OPENAI, A TTS VENDOR OR GOOGLE. The Deepgram socket is a fake, and
 * every call is driven through a fake manager.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { config as loadEnvFile } from "dotenv";

loadEnvFile({ path: ".env.local", quiet: true });
loadEnvFile({ quiet: true });

const { DeepgramSpeechToTextProvider } = await import("../../providers/speech-to-text/deepgram.provider");
const { AsyncQueue } = await import("../../core/session/async-queue");
const { DefaultVoiceSessionManager } = await import("../../core/session/voice-session-manager.impl");
const { getDispatchConfig } = await import("../config/dispatch.config");
const { LaneGate, Semaphore, TokenBucket } = await import("../dispatch/concurrency");
const { runCall } = await import("../dispatch/call-runner");
const { SessionObserver } = await import("../dispatch/session-observer");
const { findScript, hashScript } = await import("../script/script-registry");
const { claimContacts } = await import("../db/repositories/call-attempt.repo");
const { getCampaign } = await import("../db/repositories/campaign.repo");
const { query, closeDbPool } = await import("../db/client");

import type { AudioPayload, TranscriptSegment } from "../../types/provider.types";
import { CallDirection, ProviderCategory, SupportedLanguage } from "../../types/enums";
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
      `         ${(error instanceof Error ? error.message : String(error)).split("\n").slice(0, 4).join("\n         ")}`,
    );
  }
}

const section = (t: string) => console.log(`\n${t}`);
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ═════════════════════════════════════════════════════════════════
// A fake of exactly the surface `transcribeStream` uses, with the
// reconnecting semantics of the real one: `close` fires with a code,
// and a non-1000 code means the transport is coming back.

interface FakeSocketState {
  readonly sentMedia: number;
  readonly keepAlives: number;
  readonly closeCalls: number;
}

function fakeDeepgramConnection() {
  const handlers: Record<string, ((arg?: unknown) => void) | undefined> = {};
  let sentMedia = 0;
  let keepAlives = 0;
  let closeCalls = 0;

  const connection = {
    connect: () => connection,
    waitForOpen: async () => undefined,
    on: (event: string, cb: (arg?: unknown) => void) => {
      handlers[event] = cb;
    },
    socket: {
      send: (data: unknown) => {
        if (typeof data === "string") {
          if (data.includes("KeepAlive")) keepAlives += 1;
          return;
        }
        sentMedia += 1;
      },
      close: () => {
        closeCalls += 1;
      },
    },
  };

  return {
    connection,
    /** Deliver a Deepgram `Results` message, as the SDK shapes it. */
    emitResults(text: string, isFinal: boolean, speechFinal: boolean): void {
      handlers["message"]?.({
        type: "Results",
        is_final: isFinal,
        speech_final: speechFinal,
        channel: {
          alternatives: [
            { transcript: text, confidence: 0.97, words: [{ start: 0, end: 0.5 }] },
          ],
        },
      });
    },
    emitClose(code: number): void {
      handlers["close"]?.({ code });
    },
    emitError(message: string): void {
      handlers["error"]?.(new Error(message));
    },
    state: (): FakeSocketState => ({ sentMedia, keepAlives, closeCalls }),
  };
}

function providerWithFakeSocket(fake: ReturnType<typeof fakeDeepgramConnection>) {
  const provider = new DeepgramSpeechToTextProvider({ apiKey: "test-key", model: "nova-3" });
  // The provider builds its own client, so this is the only seam. The
  // code under test — `transcribeStream` — is the real one, unmodified.
  (provider as unknown as { client: unknown }).client = {
    listen: { v1: { connect: async () => fake.connection } },
  };
  return provider;
}

const frame = (): AudioPayload => ({
  data: new Uint8Array(160),
  encoding: "MULAW",
  sampleRateHz: 8000,
});

/**
 * Drives `transcribeStream` against a live audio queue and collects
 * segments as they arrive, so a test can assert what the stream did
 * BEFORE deciding to end it.
 */
function driveStream(provider: InstanceType<typeof DeepgramSpeechToTextProvider>) {
  const audio = new AsyncQueue<AudioPayload>();
  const segments: TranscriptSegment[] = [];
  let ended = false;

  const consumed = (async () => {
    for await (const segment of provider.transcribeStream({
      sessionId: "phase10" as SessionId,
      audio,
      language: SupportedLanguage.ENGLISH,
    })) {
      segments.push(segment);
    }
    ended = true;
  })();

  return {
    audio,
    segments,
    isEnded: () => ended,
    consumed,
  };
}

// ═════════════════════════════════════════════════════════════════
section("A. THE TRANSCRIPT STREAM SURVIVES WHAT THE SOCKET SURVIVES");

await test("A1. a recoverable socket close does NOT end the transcript stream", async () => {
  const fake = fakeDeepgramConnection();
  const run = driveStream(providerWithFakeSocket(fake));

  run.audio.push(frame());
  await wait(30);
  fake.emitResults("Yes", true, true);
  await wait(30);
  assert.equal(run.segments.length, 1, "the first transcript must arrive");

  // THE REGRESSION. 1006 (abnormal) and 1011 (Deepgram's own NET-0001)
  // are the codes the reconnecting socket retries. Ending the stream
  // here is what killed the rest of the call.
  fake.emitClose(1006);
  await wait(50);
  assert.equal(run.isEnded(), false, "a retried close must not end the transcript stream");

  // The transport reconnected and Deepgram is talking again. The
  // pipeline must still be listening.
  fake.emitResults("please reserve it", true, true);
  await wait(30);
  assert.equal(run.segments.length, 2, "transcription must continue after the reconnect");
  assert.equal(run.segments[1]?.text, "please reserve it");

  run.audio.close();
  await run.consumed;
  assert.equal(run.isEnded(), true, "the stream still ends when the audio source does");
});

await test("A2. a socket error does NOT end the transcript stream either", async () => {
  const fake = fakeDeepgramConnection();
  const run = driveStream(providerWithFakeSocket(fake));

  run.audio.push(frame());
  await wait(30);
  // `ws` emits `error` immediately before an abnormal close, so this
  // path has to be as forgiving as the close path.
  fake.emitError("read ECONNRESET");
  fake.emitClose(1006);
  await wait(50);
  assert.equal(run.isEnded(), false, "a recoverable error must not end the transcript stream");

  fake.emitResults("Haan ji", true, true);
  await wait(30);
  assert.equal(run.segments.length, 1, "transcription must continue after the error");

  run.audio.close();
  await run.consumed;
});

await test("A3. a clean server close (1000) DOES end the transcript stream", async () => {
  const fake = fakeDeepgramConnection();
  const run = driveStream(providerWithFakeSocket(fake));

  run.audio.push(frame());
  await wait(30);
  // 1000 is the one code the reconnecting socket will not retry, so it
  // genuinely is the end of transcription — resilience must not become
  // a stream that never terminates.
  fake.emitClose(1000);
  await wait(50);
  assert.equal(run.isEnded(), true, "a clean close must end the transcript stream");

  run.audio.close();
  await run.consumed;
});

await test("A4. ending the audio source closes the socket exactly once", async () => {
  const fake = fakeDeepgramConnection();
  const run = driveStream(providerWithFakeSocket(fake));

  run.audio.push(frame());
  run.audio.push(frame());
  await wait(30);
  run.audio.close();
  await run.consumed;

  assert.equal(run.isEnded(), true);
  assert.equal(fake.state().sentMedia, 2, "every audio frame must reach the socket");
  assert.equal(fake.state().closeCalls, 1, "the socket is closed once, by the teardown that owns it");
});

await test("A5. an idle socket is kept alive rather than left to time out", async () => {
  const fake = fakeDeepgramConnection();
  const run = driveStream(providerWithFakeSocket(fake));

  // Audio flowing: nothing owed.
  run.audio.push(frame());
  await wait(200);
  assert.equal(fake.state().keepAlives, 0, "a socket receiving audio needs no KeepAlive");

  // Deepgram drops a stream that has had no audio for ~10s, which is
  // exactly the close the old handlers turned into a dropped call.
  // A carrier that suppresses silence can produce it, so the stream
  // does not let the socket get there.
  await wait(7_500);
  assert.ok(
    fake.state().keepAlives >= 1,
    `an idle socket must be kept alive (sent ${fake.state().keepAlives})`,
  );

  run.audio.close();
  await run.consumed;
});

// ═════════════════════════════════════════════════════════════════
section("B. THE WATCHDOG READS A LIVE CALL AS LIVE");

/**
 * A session that answers and never hangs up on its own — the same
 * shape `phase9` uses, plus the `lastActivityAt` accessor the watchdog
 * reads. `heard()` is the pipeline hearing the caller; the fake fires
 * NO state transitions after answering, which is the real condition:
 * a caller mid-utterance keeps the session in LISTENING, so transitions
 * alone report an active conversation as silence.
 */
function watchdogManager() {
  let listener: ((sessionId: string, transition: unknown) => void) | undefined;
  // Unique per run: the attempt table indexes session_id, so a
  // reused id makes the second call in this section a duplicate.
  const sessionId = `phase10-${randomUUID()}`;
  const state = { endCalls: 0, heardAt: 0 };
  return {
    state,
    heard(): void {
      state.heardAt = Date.now();
    },
    createSession: async () => ({ id: sessionId }),
    warmUpProviders: async () => undefined,
    start: async () => {
      listener?.(sessionId, { from: "CALLING", to: "LISTENING", at: new Date() });
    },
    end: async () => {
      state.endCalls += 1;
      listener?.(sessionId, { from: "LISTENING", to: "IDLE", at: new Date() });
      return undefined;
    },
    getBenchmarkMetrics: async () => ({
      sessionId,
      providerStack: {},
      timestamp: new Date(),
      callDuration: { seconds: 30, createdAt: new Date() },
      turnLatencies: [],
    }),
    // No definitive answer is ever readable, so the FINAL_ANSWER
    // verdict cannot fire and only the silence clock is under test.
    getTranscript: () => [],
    lastActivityAt: () => state.heardAt,
    onStateChange: (fn: (sessionId: string, transition: unknown) => void) => {
      listener = fn;
      return () => (listener = undefined);
    },
  };
}

const dispatchConfig = getDispatchConfig();

if (!process.env["DATABASE_URL"]) {
  console.log("  [SKIP] section B — DATABASE_URL is not set");
} else {
  // The runner writes real attempt rows, so the section owns a real
  // campaign — the same arrangement `phase9` section C uses, for the
  // same reason: the watchdog under test must be the shipped one, with
  // nothing around it stubbed. The sheet is unreachable throughout.
  const savedSpreadsheetId = process.env["CAMPAIGN_SHEET_SPREADSHEET_ID"];
  delete process.env["CAMPAIGN_SHEET_SPREADSHEET_ID"];

  const campaignId = randomUUID();
  const registrationScript = findScript("registration", "v1");
  assert.ok(registrationScript, "the approved registration script must be registered");
  let seedIndex = 0;

  /**
   * @param keepHearingForMs How long the caller keeps producing audio
   *   the pipeline hears. 0 is a line that goes quiet the moment it is
   *   answered — genuine silence.
   */
  async function runWatchdog(maxSilenceSeconds: number, keepHearingForMs: number) {
    seedIndex += 1;
    const inserted = await query<{ id: string }>(
      `INSERT INTO contacts (campaign_id, name, normalized_phone, original_phone, assigned_provider, csv_row_number)
       VALUES ($1, 'Priya', $2, $2, 'cartesia', $3) RETURNING id`,
      [campaignId, `+9198119${String(30000 + seedIndex)}`, seedIndex],
    );
    const contactId = inserted.rows[0]!.id;

    const claimed = await claimContacts(campaignId, "cartesia" as never, 50, "phase10");
    const contact = claimed.find((row) => row.id === contactId);
    for (const other of claimed) {
      if (other.id !== contactId) {
        await query("UPDATE contacts SET status='PENDING', claimed_by=NULL WHERE id=$1", [other.id]);
      }
    }
    assert.ok(contact, "the contact must be claimable");

    const campaign = await getCampaign(campaignId);
    assert.ok(campaign);

    const manager = watchdogManager();
    const heartbeat = setInterval(() => manager.heard(), 250);
    if (keepHearingForMs === 0) clearInterval(heartbeat);
    else setTimeout(() => clearInterval(heartbeat), keepHearingForMs);

    const startedAt = Date.now();
    const outcome = await runCall(
      contact,
      {
        manager: manager as never,
        observer: new SessionObserver(manager as never),
        config: {
          ...dispatchConfig,
          dialingEnabled: true,
          ringTimeoutSeconds: 5,
          maxCallSeconds: 60,
          maxSilenceSeconds,
        },
        campaign,
        script: registrationScript!,
      },
      Date.now(),
    );
    clearInterval(heartbeat);
    return { outcome, elapsedMs: Date.now() - startedAt, endCalls: manager.state.endCalls };
  }

  async function hangupReasonOf(attemptId: string): Promise<string | null> {
    const row = await query<{ hangup_reason: string | null }>(
      "SELECT hangup_reason FROM call_attempts WHERE id = $1",
      [attemptId],
    );
    return row.rows[0]?.hangup_reason ?? null;
  }

  try {
    await query(
      `INSERT INTO campaigns (id, name, campaign_type, status, script_id, script_version, script_hash,
                              provider_allocation, telephony_provider, language, idempotency_key, dispatch_config)
       VALUES ($1, '__phase10__', 'registration', 'READY', 'registration', 'v1', $2,
               '{"cartesia":100}'::jsonb, 'vobiz', 'en', $3, '{"agent":{"gender":"female"}}'::jsonb)`,
      [campaignId, hashScript(registrationScript!), `phase10-${campaignId}`],
    );

    await test("B1. an active conversation is not disconnected, however long it runs", async () => {
      // The window is 2s and the caller is heard for 6s — three full
      // windows. Scaled down from the shipped 20s only so the suite is
      // fast; the clock under test is the shipped one.
      const { outcome, elapsedMs } = await runWatchdog(2, 6_000);
      assert.equal(outcome.failureClass, "COMPLETED");
      assert.ok(
        elapsedMs >= 6_000,
        `the call must survive the whole conversation, ended after ${elapsedMs}ms`,
      );
    });

    await test("B2. heard audio alone keeps the call alive — no state transition needed", async () => {
      // The fake emits exactly one transition (answered) and nothing
      // after it, so whatever held this call past its window came from
      // `lastActivityAt`, i.e. from interim STT.
      const { elapsedMs } = await runWatchdog(2, 5_000);
      assert.ok(elapsedMs >= 5_000, `interim audio must hold the line, ended after ${elapsedMs}ms`);
    });

    await test("B3. genuine silence still ends the call, at the same deadline", async () => {
      const { outcome, elapsedMs, endCalls } = await runWatchdog(2, 0);
      assert.equal(endCalls, 1, "silence must still hang up, through the manager's public end()");
      assert.equal(outcome.failureClass, "COMPLETED");
      assert.equal(await hangupReasonOf(outcome.attemptId!), "watchdog:max_silence");
      assert.ok(
        elapsedMs >= 2_000 && elapsedMs < 6_000,
        `silence must end the call at its deadline, took ${elapsedMs}ms`,
      );
    });
  } finally {
    await query("DELETE FROM campaigns WHERE id = $1", [campaignId]).catch(() => undefined);
    if (savedSpreadsheetId === undefined) delete process.env["CAMPAIGN_SHEET_SPREADSHEET_ID"];
    else process.env["CAMPAIGN_SHEET_SPREADSHEET_ID"] = savedSpreadsheetId;
  }
}

// ═════════════════════════════════════════════════════════════════
section("C. CALLER SPEECH IS ACTIVITY, WHATEVER STT IS DOING");

const stubRegistry = {
  resolve: () => ({ descriptor: { category: ProviderCategory.TELEPHONY, id: "stub" } }),
} as never;

await test("C1. the transport's own speech detection stamps conversation activity", async () => {
  const manager = new DefaultVoiceSessionManager(stubRegistry);
  const created = await manager.createSession({
    language: SupportedLanguage.ENGLISH,
    direction: CallDirection.OUTBOUND,
    providerStack: {
      telephony: { category: ProviderCategory.TELEPHONY, id: "vobiz" },
      speechToText: { category: ProviderCategory.SPEECH_TO_TEXT, id: "deepgram" },
      languageModel: { category: ProviderCategory.LANGUAGE_MODEL, id: "gpt-5.1" },
      textToSpeech: { category: ProviderCategory.TEXT_TO_SPEECH, id: "cartesia" },
    },
  });

  // Nothing heard yet is genuine silence, and reports as such.
  assert.equal(manager.lastActivityAt(created.id), 0);

  const before = Date.now();
  manager.noteCallerSpeech(created.id);
  const stamped = manager.lastActivityAt(created.id);
  assert.ok(stamped >= before, "caller speech must advance the activity clock");
});

await test("C2. stamping a session that has gone never throws", () => {
  const manager = new DefaultVoiceSessionManager(stubRegistry);
  // Called from a socket callback that can outlive the session by a
  // frame or two, so it has to be inert rather than fatal.
  manager.noteCallerSpeech("sess_gone" as SessionId);
});

// ═════════════════════════════════════════════════════════════════
section("D. THE CARRIER'S CONCURRENCY CEILING IS THE ONE IN FORCE");

await test("D1. the shipped configuration holds live calls to 3", () => {
  const config = getDispatchConfig();
  assert.ok(
    config.globalMaxConcurrent <= 3,
    `CAMPAIGN_GLOBAL_MAX_CONCURRENCY is ${config.globalMaxConcurrent}; the Vobiz account allows 3 live calls`,
  );
});

await test("D2. three lanes cannot collectively exceed the global ceiling", async () => {
  const config = getDispatchConfig();
  const globalSemaphore = new Semaphore(config.globalMaxConcurrent);
  const globalBucket = new TokenBucket(1_000);
  const gates = (["cartesia", "sarvam", "smallest-ai"] as const).map(
    (provider) =>
      new LaneGate(
        new Semaphore(config.lanes[provider].maxConcurrent),
        new TokenBucket(1_000),
        globalSemaphore,
        globalBucket,
      ),
  );

  // Every lane asks for four calls at once — twelve in total, from the
  // three lanes running concurrently, which is how the dispatcher runs.
  let live = 0;
  let peak = 0;
  const held: Array<() => void> = [];
  const attempts = gates.flatMap((gate) =>
    Array.from({ length: 4 }, () =>
      gate.acquire().then(() => {
        live += 1;
        peak = Math.max(peak, live);
        held.push(() => {
          live -= 1;
          gate.release();
        });
      }),
    ),
  );

  await wait(300);
  assert.equal(peak, 3, `at most 3 calls may be live at once, saw ${peak}`);
  for (const release of held) release();
  await wait(50);
  for (const release of held) void release;
  // Let the queued acquisitions drain so the test leaves nothing pending.
  await Promise.race([Promise.all(attempts), wait(500)]);
});

// ─────────────────────────────────────────────────────────────────
console.log(`\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`);
console.log("No call was placed. Deepgram, OpenAI, the TTS vendors and Google were not contacted.");
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
process.exit(0);
