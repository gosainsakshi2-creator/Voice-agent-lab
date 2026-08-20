/**
 * speaking-watchdog-tests.ts — `npm run test:speaking-watchdog`
 *
 * WHY A LIVE CALL WAS CUT OFF WHILE THE AGENT WAS TALKING.
 *
 * `phase10` proved the watchdog reads a *talking caller* as alive. This
 * is the other half, and it was still broken: a talking AGENT.
 *
 * The campaign watchdog's two activity clocks both measure the CALLER —
 * `lastActivityAt` from session state transitions, and the pipeline's
 * own `lastConversationActivityAt` from Deepgram segments. While the
 * agent speaks, the caller is *supposed* to say nothing, so NEITHER
 * clock advances. The last thing to move either of them is the
 * `THINKING -> SPEAKING` transition at the top of the reply:
 *
 *   caller: "Yes,"
 *     -> LISTENING -> THINKING       (stamps lastActivityAt)
 *     -> THINKING  -> SPEAKING       (stamps lastActivityAt, the last time)
 *     -> the agent speaks; the caller listens, in silence
 *     -> both clocks frozen for the whole reply
 *     -> maxSilenceSeconds after the reply STARTED: MAX_SILENCE
 *     -> end() with the session still in SPEAKING, endCall(), a person
 *        hung up on mid-sentence.
 *
 * Any reply longer than the window was unsurvivable. The fix counts
 * silence only in LISTENING — the one state where hearing nothing means
 * nothing is there — and the window then re-arms by itself, because the
 * pipeline holds SPEAKING until playback has drained and the transition
 * back to LISTENING stamps `lastActivityAt`.
 *
 * Section A is that defect. Section B is the guarantee the fix must not
 * have traded away: genuine silence still ends the call, at the same
 * deadline. Sections C and D are the two endings that must be
 * untouched, including the reason they were already safe — a final
 * answer is only readable once the agent's reply has been committed,
 * which happens after that reply's audio has drained.
 *
 * NOTHING HERE PLACES A CALL. No telephony, STT, LLM, TTS or Google
 * request is made: every call is driven through a fake manager that
 * emits the real session transitions on a scripted clock.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { config as loadEnvFile } from "dotenv";

loadEnvFile({ path: ".env.local", quiet: true });
loadEnvFile({ quiet: true });

const { getDispatchConfig } = await import("../config/dispatch.config");
const { runCall } = await import("../dispatch/call-runner");
const { SessionObserver } = await import("../dispatch/session-observer");
const { findScript, hashScript } = await import("../script/script-registry");
const { claimContacts } = await import("../db/repositories/call-attempt.repo");
const { getCampaign } = await import("../db/repositories/campaign.repo");
const { query, closeDbPool } = await import("../db/client");

import { SessionState } from "../../types/enums";
import type { ConversationTurn } from "../../types/provider.types";

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

const turn = (role: "assistant" | "user", text: string): ConversationTurn => ({
  role,
  content: text,
  timestamp: new Date(),
});
const agent = (text: string) => turn("assistant", text);
const caller = (text: string) => turn("user", text);

// The approved script's own wording. The gate question is a commit
// anchor — the classifier reads a yes as a registration only when it
// follows this line — so these are copied from `phase9`, not invented.
const GREETING = "Hi Priya, this is Ishita from Team FlexiFunnels.";
const GATE = "So Priya, should I reserve your free seat for the live event?";
const CONFIRMED = "Done, your seat is reserved. You will get the joining link on WhatsApp.";
const CLOSING = "No problem at all, thanks for your time. Have a good day.";

// The window every test below runs against. Scaled down from the
// shipped 20s so the suite is fast; the clock under test is the shipped
// one, unmodified, and every deadline here is expressed in terms of it.
const WINDOW_SECONDS = 2;
const WINDOW_MS = WINDOW_SECONDS * 1000;
/** One 500ms watchdog tick, plus room for scheduling on a loaded box. */
const TICK_SLACK_MS = 1_800;

// ═════════════════════════════════════════════════════════════════
// A session that ANSWERS AND NEVER HANGS UP ON ITS OWN, driven through
// the same state transitions the real pipeline emits. `end()` records
// the state it was called in — that is the production bug's signature,
// verbatim: "end() called, current state=SPEAKING".

interface ScriptedSession {
  /** LISTENING -> THINKING -> SPEAKING, as `runThinkingAndSpeaking` does. */
  beginReply(): void;
  /**
   * The reply's audio has drained. Commits the agent's turn and only
   * THEN returns to LISTENING — the real order, and the reason a final
   * answer can never be read mid-reply: `definitiveAnswerIn` requires
   * the last turn to be the agent's.
   */
  finishReply(text: string): void;
}

function scriptedManager(input: {
  /** What `getTranscript` reports before the agent's reply is committed. */
  readonly transcriptSoFar: readonly ConversationTurn[];
  /** Drives the call's timeline. Started from `start()`, never awaited. */
  readonly drive: (session: ScriptedSession) => Promise<void>;
}) {
  let listener: ((sessionId: string, transition: unknown) => void) | undefined;
  const sessionId = `spk-${randomUUID()}`;
  const transcript: ConversationTurn[] = [...input.transcriptSoFar];

  let state: SessionState = SessionState.CALLING;
  let closed = false;

  const telemetry = {
    endCalls: 0,
    /** The session state `end()` was called in. The bug reported SPEAKING. */
    endedInState: undefined as SessionState | undefined,
    endedAt: 0,
    /** When the agent's reply began, and when it finished draining. */
    replyStartedAt: 0,
    replyFinishedAt: 0,
    /** When the session (re-)entered LISTENING after that reply. */
    listeningAgainAt: 0,
  };

  function transition(to: SessionState): void {
    if (closed) return;
    const from = state;
    state = to;
    listener?.(sessionId, { from, to, at: new Date() });
  }

  const session: ScriptedSession = {
    beginReply(): void {
      if (closed) return;
      telemetry.replyStartedAt = Date.now();
      transition(SessionState.THINKING);
      transition(SessionState.SPEAKING);
    },
    finishReply(text: string): void {
      if (closed) return;
      telemetry.replyFinishedAt = Date.now();
      transcript.push(agent(text));
      transition(SessionState.LISTENING);
      telemetry.listeningAgainAt = Date.now();
    },
  };

  return {
    telemetry,
    createSession: async () => ({ id: sessionId }),
    warmUpProviders: async () => undefined,
    start: async () => {
      transition(SessionState.LISTENING); // CALLING -> LISTENING: answered
      void input.drive(session).catch(() => undefined);
    },
    end: async () => {
      if (closed) return undefined;
      telemetry.endCalls += 1;
      telemetry.endedInState = state;
      telemetry.endedAt = Date.now();
      transition(SessionState.IDLE);
      closed = true;
      return undefined;
    },
    getBenchmarkMetrics: async () => ({
      sessionId,
      providerStack: {},
      timestamp: new Date(),
      callDuration: { seconds: 42, createdAt: new Date() },
      estimatedCost: {
        amount: 0.02,
        currency: "USD",
        isEstimate: true,
        breakdown: { telephony: 0.005, speechToText: 0.005, languageModel: 0.005, textToSpeech: 0.005 },
      },
      turnLatencies: [],
    }),
    getTranscript: () => [...transcript],
    // The caller is silent throughout every test here — which is the
    // whole point. Nothing ever stamps the pipeline's heard-audio clock,
    // so the only thing that can hold one of these calls open is the fix.
    lastActivityAt: () => 0,
    onStateChange: (fn: (sessionId: string, transition: unknown) => void) => {
      listener = fn;
      return () => (listener = undefined);
    },
  };
}

const dispatchConfig = getDispatchConfig();
const registrationScript = findScript("registration", "v1");
assert.ok(registrationScript, "the approved registration script must be registered");

if (!process.env["DATABASE_URL"]) {
  console.log("\n[SKIP] every section — DATABASE_URL is not set");
  console.log("\nALL PASSED — 0 passed, 0 failed");
  process.exit(0);
}

// The runner calls the sheet mirror with the deployment's own
// configuration. Cleared for the whole suite and restored afterwards so
// the real spreadsheet is unreachable and the sync reports itself
// unconfigured.
const savedSpreadsheetId = process.env["CAMPAIGN_SHEET_SPREADSHEET_ID"];
delete process.env["CAMPAIGN_SHEET_SPREADSHEET_ID"];

const campaignId = randomUUID();
let seedIndex = 0;

async function runScripted(input: {
  readonly transcriptSoFar: readonly ConversationTurn[];
  readonly drive: (session: ScriptedSession) => Promise<void>;
}) {
  seedIndex += 1;
  const inserted = await query<{ id: string }>(
    `INSERT INTO contacts (campaign_id, name, normalized_phone, original_phone, assigned_provider, csv_row_number)
     VALUES ($1, 'Priya', $2, $2, 'cartesia', $3) RETURNING id`,
    [campaignId, `+9198119${String(40000 + seedIndex)}`, seedIndex],
  );
  const contactId = inserted.rows[0]!.id;

  const claimed = await claimContacts(campaignId, "cartesia" as never, 50, "speaking-watchdog");
  const contact = claimed.find((row) => row.id === contactId);
  for (const other of claimed) {
    if (other.id !== contactId) {
      await query("UPDATE contacts SET status='PENDING', claimed_by=NULL WHERE id=$1", [other.id]);
    }
  }
  assert.ok(contact, "the contact must be claimable");

  const campaign = await getCampaign(campaignId);
  assert.ok(campaign);

  const manager = scriptedManager(input);
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
        maxSilenceSeconds: WINDOW_SECONDS,
      },
      campaign,
      script: registrationScript!,
    },
    Date.now(),
  );
  return { outcome, elapsedMs: Date.now() - startedAt, telemetry: manager.telemetry };
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
     VALUES ($1, '__speaking_watchdog__', 'registration', 'READY', 'registration', 'v1', $2,
             '{"cartesia":100}'::jsonb, 'vobiz', 'en', $3, '{"agent":{"gender":"female"}}'::jsonb)`,
    [campaignId, hashScript(registrationScript!), `spk-${campaignId}`],
  );

  // ═══════════════════════════════════════════════════════════════
  section("A. A SPEAKING AGENT IS NEVER CUT OFF BY THE SILENCE WATCHDOG");

  // One run, several separate guarantees read off it. The reply lasts
  // three full silence windows, and the caller says nothing for the
  // whole call — under the old clock this call died mid-reply.
  const REPLY_MS = WINDOW_MS * 3;

  const speaking = await runScripted({
    transcriptSoFar: [agent(GREETING), agent("Am I speaking with Priya?"), caller("Yes,")],
    drive: async (s) => {
      await wait(300);
      s.beginReply();
      await wait(REPLY_MS);
      s.finishReply("Great. I will keep this to twenty seconds.");
      // ...and then the line goes genuinely quiet, which is section B.
    },
  });

  await test(
    "A1. the reply is not cut off — a call survives an agent turn longer than the whole silence window",
    () => {
      assert.ok(
        speaking.telemetry.replyFinishedAt > 0,
        "the scripted reply must have been allowed to finish at all",
      );
      const spokenForMs = speaking.telemetry.replyFinishedAt - speaking.telemetry.replyStartedAt;
      assert.ok(
        spokenForMs >= REPLY_MS,
        `the agent must speak its whole reply (${REPLY_MS}ms), got ${spokenForMs}ms`,
      );
      assert.ok(
        speaking.elapsedMs >= REPLY_MS,
        `the call must outlive the reply, ended after ${speaking.elapsedMs}ms`,
      );
    },
  );

  await test("A2. end() is never called while the session is THINKING or SPEAKING", () => {
    // The production log line this whole change exists to delete:
    //   [session-mgr] end() called, current state=SPEAKING
    assert.notEqual(
      speaking.telemetry.endedInState,
      SessionState.SPEAKING,
      "the call was ended while the agent was still speaking — the original defect",
    );
    assert.notEqual(
      speaking.telemetry.endedInState,
      SessionState.THINKING,
      "the call was ended while the agent was still thinking",
    );
    assert.equal(
      speaking.telemetry.endedInState,
      SessionState.LISTENING,
      "the only state a silence hangup may happen in is LISTENING",
    );
  });

  // ═══════════════════════════════════════════════════════════════
  section("B. GENUINE SILENCE STILL ENDS THE CALL, AT THE SAME DEADLINE");

  await test("B1. the window re-arms when the agent finishes — measured from the return to LISTENING", async () => {
    const sinceListeningMs = speaking.telemetry.endedAt - speaking.telemetry.listeningAgainAt;
    assert.ok(
      sinceListeningMs >= WINDOW_MS - 200,
      `the deadline must run from the return to LISTENING, fired ${sinceListeningMs}ms after it`,
    );
    assert.ok(
      sinceListeningMs <= WINDOW_MS + TICK_SLACK_MS,
      `...and no later than one tick past it, fired ${sinceListeningMs}ms after it`,
    );
    assert.equal(speaking.telemetry.endCalls, 1, "through the manager's public end(), once");
    assert.equal(speaking.outcome.failureClass, "COMPLETED");
    assert.equal(await hangupReasonOf(speaking.outcome.attemptId!), "watchdog:max_silence");
  });

  await test("B2. a line that goes quiet with no reply in flight still ends at the deadline", async () => {
    // The watchdog is state-gated, not disabled: this call sits in
    // LISTENING from the moment it is answered and is hung up on time.
    const silent = await runScripted({
      transcriptSoFar: [agent(GREETING)],
      drive: async () => undefined,
    });
    assert.equal(silent.telemetry.endCalls, 1, "silence must still hang up");
    assert.equal(silent.telemetry.endedInState, SessionState.LISTENING);
    assert.equal(silent.outcome.failureClass, "COMPLETED");
    assert.equal(await hangupReasonOf(silent.outcome.attemptId!), "watchdog:max_silence");
    assert.ok(
      silent.elapsedMs >= WINDOW_MS && silent.elapsedMs <= WINDOW_MS + TICK_SLACK_MS + 2_000,
      `silence must end the call at its deadline, took ${silent.elapsedMs}ms`,
    );
  });

  // ═══════════════════════════════════════════════════════════════
  section("C. FINAL_YES IS UNCHANGED, AND STILL WAITS FOR THE AGENT'S CONFIRMATION");

  await test("C1. a yes at the gate ends the call only after the confirmation has been spoken", async () => {
    const yes = await runScripted({
      // The gate has been asked and answered. The agent's confirmation
      // is NOT in the transcript yet — the pipeline commits it after
      // the audio drains, which is what `finishReply` reproduces.
      transcriptSoFar: [agent(GREETING), agent(GATE), caller("Yes, please reserve it.")],
      drive: async (s) => {
        await wait(300);
        s.beginReply();
        // The confirmation is deliberately longer than the silence
        // window, so a hangup that fired early would be visible here as
        // an end() in SPEAKING rather than as a late one.
        await wait(WINDOW_MS * 2);
        s.finishReply(CONFIRMED);
      },
    });

    assert.notEqual(
      yes.telemetry.endedInState,
      SessionState.SPEAKING,
      "the person must hear their confirmation in full",
    );
    const spokenForMs = yes.telemetry.replyFinishedAt - yes.telemetry.replyStartedAt;
    assert.ok(spokenForMs >= WINDOW_MS * 2, `the confirmation must finish, spoke for ${spokenForMs}ms`);
    assert.equal(yes.telemetry.endCalls, 1);
    assert.equal(yes.outcome.failureClass, "COMPLETED");
    assert.equal(
      await hangupReasonOf(yes.outcome.attemptId!),
      "agent_hangup:final_yes",
      "a FINAL_YES must still be the reason the call ended, not a silence timeout",
    );
    // ...and promptly once it is readable, rather than waiting out a
    // silence window it no longer shares a deadline with.
    const afterConfirmationMs = yes.telemetry.endedAt - yes.telemetry.replyFinishedAt;
    assert.ok(
      afterConfirmationMs < WINDOW_MS,
      `the hangup must follow the confirmation, not the silence window (${afterConfirmationMs}ms)`,
    );
  });

  // ═══════════════════════════════════════════════════════════════
  section("D. FINAL_NO IS UNCHANGED");

  await test("D1. an unmistakable refusal still ends the call, after the agent's closing line", async () => {
    const no = await runScripted({
      transcriptSoFar: [agent(GREETING), agent(GATE), caller("No, I'm not interested.")],
      drive: async (s) => {
        await wait(300);
        s.beginReply();
        await wait(WINDOW_MS * 2);
        s.finishReply(CLOSING);
      },
    });

    assert.notEqual(
      no.telemetry.endedInState,
      SessionState.SPEAKING,
      "the closing line must not be cut off either",
    );
    assert.equal(no.telemetry.endCalls, 1);
    assert.equal(no.outcome.failureClass, "COMPLETED");
    assert.equal(
      await hangupReasonOf(no.outcome.attemptId!),
      "agent_hangup:final_no",
      "a FINAL_NO must still be the reason the call ended",
    );
    const afterClosingMs = no.telemetry.endedAt - no.telemetry.replyFinishedAt;
    assert.ok(
      afterClosingMs < WINDOW_MS,
      `the hangup must follow the closing line, not the silence window (${afterClosingMs}ms)`,
    );
  });
} finally {
  await query("DELETE FROM campaigns WHERE id = $1", [campaignId]).catch(() => undefined);
  if (savedSpreadsheetId === undefined) delete process.env["CAMPAIGN_SHEET_SPREADSHEET_ID"];
  else process.env["CAMPAIGN_SHEET_SPREADSHEET_ID"] = savedSpreadsheetId;
  await closeDbPool();
}

// ─────────────────────────────────────────────────────────────────
console.log(`\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`);
console.log("No call was placed. Telephony, Deepgram, the LLM, the TTS vendors and Google were not contacted.");
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
process.exit(0);
