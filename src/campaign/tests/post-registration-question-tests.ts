/**
 * post-registration-question-tests.ts — `npm run test:post-registration-question`
 *
 * ONE REPORTED DEFECT, FROM A REAL CALL: THE PERSON REGISTERS, ASKS A
 * QUESTION, GETS A CORRECT ANSWER — AND THE CALL IS DROPPED ON THE
 * AGENT'S OWN LAST WORD.
 *
 *   agent    "Would you like me to reserve your free seat?"
 *   caller   "Yes, I am registering, but I have a question."
 *   agent    "Okay, I'll register you — go ahead."          held (fix 1)
 *   caller   "What time does the session start?"
 *   agent    "It starts at 7:30 pm today."                  <- HUNG UP
 *
 * This is the announced-question defect one exchange later, and the
 * first fix is why. `announcedQuestionPending` held the line while the
 * announcement was the last thing the person had said, and released it
 * the moment they spoke again — correctly, because they HAD spoken
 * again. What replaced the announcement was their actual question; the
 * FINAL_YES from the gate was still sitting there waiting; and so the
 * agent's answer became the hangup.
 *
 * THE RULE THIS SUITE ENFORCES. A registration confirmation is not, by
 * itself, enough to hang up once the person has a question open. The
 * agent finishing an answer is not the person saying they are done —
 * only the person can say that, and they say it by taking a turn and
 * asking nothing ("no, that's all", "that's clear, thanks", "bas, itna
 * hi") or by saying nothing at all, which the silence clock already
 * ends.
 *
 * THE FIX IS IN THE HANGUP AND NOWHERE ELSE, exactly as the first one
 * was. `classifyOutcome`, `dispositionFor` and `isFinalYes` are
 * untouched: the person committed, the call still settles
 * `registered_confirmed` / `confirmed_at_gate` / FINAL_YES, and the
 * registrations-sheet row is still owed and still written. All that
 * moved is WHEN the line is dropped.
 *
 * WHAT THIS SUITE IS FOR:
 *
 *   A  the reported sequence: a question asked after the gate holds the
 *      line through the agent's answer, in English, Hinglish and
 *      Devanagari, across several follow-ups — and is released by the
 *      person's own closure and by nothing else
 *   B  nothing else moved: a plain yes still ends promptly, the
 *      announced-question fix is still green, the FINAL_NO paths are
 *      untouched, and the guard can only WITHHOLD a hangup
 *   C  the live watchdog, through the real `runCall`: the reported
 *      exchange, then the person closing it
 *
 * Sections A-B place no call and touch no database. Section C drives
 * the real watchdog through a fake manager on a scripted clock — no
 * telephony, STT, LLM, TTS or Google request is made.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { config as loadEnvFile } from "dotenv";

loadEnvFile({ path: ".env.local", quiet: true });
loadEnvFile({ quiet: true });

const { getDispatchConfig } = await import("../config/dispatch.config");
const { runCall, definitiveAnswerIn, agentClosedIn } = await import("../dispatch/call-runner");
const { classifyOutcome } = await import("../outcome/classifier");
const { dispositionFor } = await import("../outcome/disposition");
const { isFinalYes } = await import("../integrations/final-yes-sheet");
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

const GREETING = "Hi Priya, this is Ishita from Team FlexiFunnels.";
/** The gate, in the wording the reported call used. */
const GATE = "So Priya, would you like me to reserve your free seat?";
/** The agent's reply to the announcement on the reported call. */
const ACK = "Okay, I'll register you, and you can ask your questions.";
const CONFIRMED = "Done, your seat is reserved. You will get the joining link on WhatsApp.";
/** A real answer: long enough that it is nobody's idea of a sign-off. */
const ANSWER = "It starts at 7:30 pm today, and the joining link comes to you on WhatsApp an hour before that.";

/** The reported call: the gate, the confirmation, the agent's reply. */
const registered = (line = "Yes, I am registering, but I have a question."): ConversationTurn[] => [
  agent(GREETING),
  agent(GATE),
  caller(line),
  agent(ACK),
];

const live = (turns: readonly ConversationTurn[]) => definitiveAnswerIn(turns, "registration");

/** What the call SETTLES as, through the three unchanged production readings. */
function settle(turns: readonly ConversationTurn[]) {
  const classification = classifyOutcome({
    campaignType: "registration",
    status: "COMPLETED",
    failureClass: "COMPLETED",
    answered: true,
    transcript: turns.map((t) => ({ role: t.role as "user" | "assistant", text: t.content, at: null })),
  });
  const { disposition } = dispositionFor({
    outcomeType: classification.outcomeType,
    failureClass: "COMPLETED",
  });
  return { classification, disposition, sheetRow: isFinalYes(classification, disposition) };
}

// ═════════════════════════════════════════════════════════════════
// SECTION A — the reported sequence.
// ═════════════════════════════════════════════════════════════════

section("A. A QUESTION ASKED AFTER THE GATE SURVIVES THE AGENT'S ANSWER");

/** The reported call, in full, up to and including the agent's answer. */
const REPORTED = [...registered(), caller("What time does the session start?"), agent(ANSWER)];

await test("A1. the reported sequence does not end the call", () => {
  assert.equal(
    live(REPORTED),
    undefined,
    "the agent answering the question must not be the hangup",
  );
});

await test("A2. ...while the REGISTRATION it contains is untouched", () => {
  // The same safety case as the first fix: the person committed, and
  // the sheet row is owed whatever the watchdog does about the line.
  const { classification, disposition, sheetRow } = settle(REPORTED);
  assert.equal(classification.primaryReason, "confirmed_at_gate");
  assert.equal(classification.outcomeType, "registered_confirmed");
  assert.equal(classification.succeeded, true);
  assert.equal(disposition, "FINAL_YES");
  assert.equal(sheetRow, true, "the registrations-sheet row must still be written");
});

await test("A3. English questions after the gate", () => {
  for (const question of [
    "What time does the session start?",
    "How long is the session?",
    "Will I get a recording?",
    "Where do I join from?",
    "Is there anything I need to prepare?",
    "And who is taking the session?",
  ]) {
    assert.equal(
      live([...registered("Yes, please reserve it."), caller(question), agent(ANSWER)]),
      undefined,
      `must not hang up after answering: "${question}"`,
    );
  }
});

await test("A4. Hinglish and Devanagari questions after the gate", () => {
  for (const question of [
    "Session kitne baje shuru hoga?",
    "Ye kitne der ka hai?",
    "Recording milegi kya?",
    "Link kahan aayega?",
    "सेशन कितने बजे शुरू होगा?",
    "क्या इसकी रिकॉर्डिंग मिलेगी?",
  ]) {
    assert.equal(
      live([
        ...registered("Haan, register kar dijiye."),
        caller(question),
        agent("Aaj shaam 7:30 baje, aur link WhatsApp par ek ghante pehle aa jayega."),
      ]),
      undefined,
      `must not hang up after answering: "${question}"`,
    );
  }
});

await test("A5. several follow-ups in a row — the line is held through all of them", () => {
  let conversation = registered();
  for (const [question, answer] of [
    ["What time does the session start?", ANSWER],
    ["And how long does it run?", "About ninety minutes, including the questions at the end."],
    ["Do I need a laptop for it?", "A phone is fine, Priya. You only need to watch."],
  ] as const) {
    conversation = [...conversation, caller(question), agent(answer)];
    assert.equal(
      live(conversation),
      undefined,
      `must still be open after answering: "${question}"`,
    );
  }
});

await test("A6. the person closing it DOES allow the hangup", () => {
  for (const closure of [
    "No, that's all.",
    "No, thank you.",
    "That's clear, thank you.",
    "Got it, thanks.",
    "Okay, that's all.",
    "Nothing else, thanks.",
    "Bas, itna hi. Dhanyavaad.",
    "Nahi, aur kuch nahi.",
    "Samajh gaya, dhanyavaad.",
    "बस, इतना ही। धन्यवाद।",
  ]) {
    assert.equal(
      live([...REPORTED, caller(closure), agent("Perfect. See you today, Priya.")]),
      "FINAL_YES",
      `a genuine closure must still end the call: "${closure}"`,
    );
  }
});

await test("A7. ...and it ends as the registration it always was", () => {
  const closed = [...REPORTED, caller("No, thank you."), agent("Perfect. See you today, Priya.")];
  const { classification, disposition, sheetRow } = settle(closed);
  assert.equal(classification.primaryReason, "confirmed_at_gate");
  assert.equal(classification.outcomeType, "registered_confirmed");
  assert.equal(disposition, "FINAL_YES");
  assert.equal(sheetRow, true, "a follow-up question must not cost the person their seat");
});

await test("A8. the AGENT can never close the conversation on the person's behalf", () => {
  // The rule stated as the thing it forbids. No number of agent turns
  // after the question — an answer, a re-statement, a courtesy, all of
  // them at once — releases the hold, because none of them is the
  // person saying they have nothing else to ask.
  let conversation: ConversationTurn[] = [...registered(), caller("What time does the session start?")];
  for (const said of [
    ANSWER,
    "And you will get a reminder on WhatsApp closer to the time.",
    "Happy to help with anything else, Priya.",
    "It really is worth joining a few minutes early.",
  ]) {
    conversation = [...conversation, agent(said)];
    assert.equal(
      live(conversation),
      undefined,
      `an agent turn must never count as the person's closure: "${said}"`,
    );
  }
  // And the person's own turn does it in one.
  assert.equal(
    live([...conversation, caller("No, that's all, thank you."), agent("Lovely. See you there.")]),
    "FINAL_YES",
  );
});

// ═════════════════════════════════════════════════════════════════
// SECTION B — nothing else moved.
// ═════════════════════════════════════════════════════════════════

section("B. EVERY OTHER ENDING IS UNCHANGED");

await test("B1. a yes at the gate with NO question still ends the call", () => {
  for (const line of [
    "Yes, please.",
    "Yes, please reserve it.",
    "Haan, kar dijiye.",
    "Okay.",
    "Sure, go ahead.",
    "Bilkul, register kar dijiye.",
    "हाँ, कर दीजिए।",
    "Theek hai.",
  ]) {
    assert.equal(
      live([agent(GREETING), agent(GATE), caller(line), agent(CONFIRMED)]),
      "FINAL_YES",
      `must still hang up on: "${line}"`,
    );
  }
});

await test("B2. a question BEFORE the gate does not hold a later plain yes", () => {
  // The hold is read off the LAST thing the person said, so a question
  // they asked mid-pitch and had answered cannot keep the line open
  // after they have since confirmed. This is the common call shape and
  // it must end exactly as promptly as it did before.
  assert.equal(
    live([
      agent(GREETING),
      caller("Is it free?"),
      agent("Yes, it is completely free, Priya."),
      agent(GATE),
      caller("Yes, please."),
      agent(CONFIRMED),
    ]),
    "FINAL_YES",
  );
});

await test("B3. the announced-question fix is still green", () => {
  // The first defect, re-asserted here so this fix cannot be built on
  // top of a regression in the one it extends. An announcement carries
  // no question mark and no question-marker word, so it needs its own
  // reading and still has one.
  for (const line of [
    "Yes, I am registering, but I have a question.",
    "Yes register me, I have a doubt.",
    "Haan ji, ek sawaal hai.",
    "हाँ, मुझे एक सवाल पूछना है।",
  ]) {
    assert.equal(live(registered(line)), undefined, `must not hang up on: "${line}"`);
  }
});

await test("B4. the agent's own pending question still holds the line", () => {
  assert.equal(
    live([agent(GREETING), agent(GATE), caller("Yes, please."), agent("Sorry — shall I reserve it for you?")]),
    undefined,
  );
});

await test("B5. the FINAL_NO paths are untouched", () => {
  for (const [line, expected] of [
    ["No, I'm not interested.", "FINAL_NO"],
    ["No, I don't want to join.", "FINAL_NO"],
    ["Wrong number.", "FINAL_NO"],
    ["Mujhe nahi chahiye.", "FINAL_NO"],
    ["Call me later please.", undefined],
    ["I will see how the day goes.", undefined],
  ] as const) {
    assert.equal(
      live([agent(GREETING), agent(GATE), caller(line), agent("Understood. Take care, Priya.")]),
      expected,
      `unchanged reading for: "${line}"`,
    );
  }
});

await test("B6. a question does not hold open a call that was REFUSED", () => {
  // The guard lives inside the `isFinalYes` branch only, and this is
  // the assertion that pins it there. Somebody who refuses and asks
  // something in the same breath still reads FINAL_NO, exactly as
  // before: their own last words carry the refusal, and a question
  // alongside it does not buy the call another turn. Holding a refused
  // call open would be the opposite mistake — keeping somebody on a
  // line they have already said no to.
  assert.equal(
    live([agent(GREETING), agent(GATE), caller("No, I'm not interested. Why are you calling?"), agent(ANSWER)]),
    "FINAL_NO",
  );
});

await test("B7. the guard can only WITHHOLD a FINAL_YES, never produce one", () => {
  // Subtractive by construction: every FINAL_YES the live reading still
  // returns is one the three unchanged production readings had already
  // settled that way, so the hangup can never invent a registration.
  const corpus: readonly ConversationTurn[][] = [
    REPORTED,
    [...REPORTED, caller("No, thank you."), agent("See you today, Priya.")],
    [...registered("Yes, please."), caller("Is it recorded?"), agent(ANSWER)],
    [agent(GREETING), agent(GATE), caller("Yes, please."), agent(CONFIRMED)],
    [agent(GREETING), agent(GATE), caller("No, I'm not interested."), agent("Take care.")],
    [agent(GREETING), agent(GATE), caller("Call me later please."), agent("Of course.")],
    [agent(GREETING), agent(GATE), caller("Hmm."), agent("No problem at all.")],
  ];
  for (const turns of corpus) {
    const verdict = live(turns);
    const { classification, disposition, sheetRow } = settle(turns);
    if (verdict === "FINAL_YES") {
      assert.equal(classification.primaryReason, "confirmed_at_gate");
      assert.equal(disposition, "FINAL_YES");
      assert.equal(sheetRow, true);
    }
    if (disposition !== "FINAL_YES") {
      assert.notEqual(verdict, "FINAL_YES", "a non-registration can never hang up as one");
    }
  }
});

await test("B8. an ANSWER is not a sign-off, and a sign-off still is", () => {
  // `agentClosedIn` is deliberately not touched by this fix, and the
  // word cap is why it does not need to be: a real answer runs well
  // past it, so answering a question cannot reach the closing path
  // either. A genuine goodbye still does.
  assert.equal(agentClosedIn([...registered(), caller("What time does it start?"), agent(ANSWER)]), false);
  assert.equal(
    agentClosedIn([
      ...registered(),
      caller("What time does it start?"),
      agent(ANSWER),
      caller("No, that's all."),
      agent("Perfect. Take care, Priya."),
    ]),
    true,
  );
});

// ═════════════════════════════════════════════════════════════════
// SECTION C — the live watchdog, through the real `runCall`.
// ═════════════════════════════════════════════════════════════════

interface ScriptedSession {
  beginReply(): void;
  finishReply(text: string): void;
  say(text: string): void;
}

function scriptedManager(input: {
  readonly transcriptSoFar: readonly ConversationTurn[];
  readonly drive: (session: ScriptedSession) => Promise<void>;
}) {
  let listener: ((sessionId: string, transition: unknown) => void) | undefined;
  const sessionId = `post-registration-${randomUUID()}`;
  const transcript: ConversationTurn[] = [...input.transcriptSoFar];

  let state: SessionState = SessionState.CALLING;
  let closed = false;

  const telemetry = {
    endCalls: 0,
    endedInState: undefined as SessionState | undefined,
    endedAt: 0,
    /**
     * When the agent's FIRST reply was committed — set once, so a later
     * reply cannot move the mark a hold is measured from.
     */
    firstReplyCommittedAt: 0,
    /** When the agent's ANSWER to the caller's question was committed. */
    answerCommittedAt: 0,
    /** Whether the line was still up when the caller took their next turn. */
    upAfterAnswer: false,
    /** Every caller turn the fake let through, in order. */
    callerTurns: [] as string[],
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
      transition(SessionState.THINKING);
      transition(SessionState.SPEAKING);
    },
    finishReply(text: string): void {
      if (closed) return;
      transcript.push(agent(text));
      if (telemetry.firstReplyCommittedAt === 0) telemetry.firstReplyCommittedAt = Date.now();
      if (text === ANSWER) telemetry.answerCommittedAt = Date.now();
      transition(SessionState.LISTENING);
    },
    /** The PERSON speaks. Only possible while the line is still up. */
    say(text: string): void {
      if (closed) return;
      telemetry.callerTurns.push(text);
      if (telemetry.answerCommittedAt !== 0) telemetry.upAfterAnswer = true;
      transcript.push(caller(text));
    },
  };

  return {
    telemetry,
    isClosed: () => closed,
    createSession: async () => ({ id: sessionId }),
    warmUpProviders: async () => undefined,
    start: async () => {
      transition(SessionState.LISTENING);
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

function report(): never {
  console.log(
    `\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`,
  );
  for (const name of failures) console.log(`  - ${name}`);
  console.log(
    "No call was placed. Telephony, Deepgram, the LLM, the TTS vendors and Google were not contacted.",
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

if (!process.env["DATABASE_URL"]) {
  console.log("\n[SKIP] section C — DATABASE_URL is not set");
  report();
}

const savedSpreadsheetId = process.env["CAMPAIGN_SHEET_SPREADSHEET_ID"];
delete process.env["CAMPAIGN_SHEET_SPREADSHEET_ID"];

const campaignId = randomUUID();
let seedIndex = 0;

/** Scaled down from the shipped window; the clock under test is the shipped one. */
const WINDOW_SECONDS = 4;
const WINDOW_MS = WINDOW_SECONDS * 1000;
/** Comfortably more than the 500ms watchdog tick, and well under the window. */
const TICKS_MS = 2_000;

async function runScripted(input: {
  readonly transcriptSoFar: readonly ConversationTurn[];
  readonly drive: (session: ScriptedSession) => Promise<void>;
}) {
  seedIndex += 1;
  const inserted = await query<{ id: string }>(
    `INSERT INTO contacts (campaign_id, name, normalized_phone, original_phone, assigned_provider, csv_row_number)
     VALUES ($1, 'Priya', $2, $2, 'cartesia', $3) RETURNING id`,
    [campaignId, `+9198116${String(70000 + seedIndex)}`, seedIndex],
  );
  const contactId = inserted.rows[0]!.id;

  const claimed = await claimContacts(campaignId, "cartesia" as never, 50, "post-registration-question");
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
  return { outcome, telemetry: manager.telemetry, isClosed: manager.isClosed };
}

async function hangupReasonOf(attemptId: string): Promise<string | null> {
  const row = await query<{ hangup_reason: string | null }>(
    "SELECT hangup_reason FROM call_attempts WHERE id = $1",
    [attemptId],
  );
  return row.rows[0]?.hangup_reason ?? null;
}

async function outcomeOf(attemptId: string): Promise<{ reason: string | null; type: string | null }> {
  const row = await query<{ primary_reason: string | null; outcome_type: string | null }>(
    "SELECT primary_reason, outcome_type FROM call_outcomes WHERE call_attempt_id = $1",
    [attemptId],
  );
  return { reason: row.rows[0]?.primary_reason ?? null, type: row.rows[0]?.outcome_type ?? null };
}

try {
  await query(
    `INSERT INTO campaigns (id, name, campaign_type, status, script_id, script_version, script_hash,
                            provider_allocation, telephony_provider, language, idempotency_key, dispatch_config)
     VALUES ($1, '__post_registration_question__', 'registration', 'READY', 'registration', 'v1', $2,
             '{"cartesia":100}'::jsonb, 'vobiz', 'en', $3, '{"agent":{"gender":"female"}}'::jsonb)`,
    [campaignId, hashScript(registrationScript!), `post-registration-${campaignId}`],
  );

  // ═══════════════════════════════════════════════════════════════
  section("C. THE LIVE WATCHDOG — THE REPORTED CALL, END TO END");

  // The reported exchange, driven through the real `runCall`, then the
  // turn the person never got: they asked, the agent answered, and
  // before this fix the line was gone within one 500ms tick of that
  // answer — so the `say("No, thank you.")` below could not have
  // happened at all.
  const held = await runScripted({
    transcriptSoFar: [agent(GREETING), agent(GATE), caller("Yes, I am registering, but I have a question.")],
    drive: async (s) => {
      await wait(300);
      s.beginReply();
      await wait(400);
      s.finishReply(ACK);
      await wait(TICKS_MS);
      s.say("What time does the session start?");
      s.beginReply();
      await wait(400);
      s.finishReply(ANSWER);
      // The gap the person was being cut off in — several watchdog
      // ticks after the answer, still well inside the silence window.
      await wait(TICKS_MS);
      s.say("No, thank you.");
      s.beginReply();
      await wait(400);
      s.finishReply("Perfect. See you today, Priya. Take care.");
    },
  });

  await test("C1. the line is still up after the agent has answered", async () => {
    assert.equal(
      held.telemetry.upAfterAnswer,
      true,
      "the person must still be on the call after their question was answered",
    );
    assert.deepEqual(
      held.telemetry.callerTurns,
      ["What time does the session start?", "No, thank you."],
      "both caller turns must have happened on a live line",
    );
  });

  await test("C2. ...and the answer itself was not the hangup", () => {
    const heldForMs = held.telemetry.endedAt - held.telemetry.answerCommittedAt;
    assert.ok(
      heldForMs > TICKS_MS,
      `the line must survive the gap after the answer, not one watchdog tick (${heldForMs}ms)`,
    );
  });

  await test("C3. the person closing it ends the call as agent_hangup:final_yes", async () => {
    assert.equal(held.outcome.failureClass, "COMPLETED");
    assert.equal(
      await hangupReasonOf(held.outcome.attemptId!),
      "agent_hangup:final_yes",
      "the hangup is DELAYED by the fix, never removed",
    );
    assert.notEqual(held.telemetry.endedInState, SessionState.SPEAKING);
  });

  await test("C4. ...and the registration is recorded exactly as before", async () => {
    const stored = await outcomeOf(held.outcome.attemptId!);
    assert.equal(stored.reason, "confirmed_at_gate");
    assert.equal(stored.type, "registered_confirmed");
  });

  await test("C5. a question nobody follows up on still ends on the silence window", async () => {
    // The other ending this shape can reach: the person asks, is
    // answered, and then says nothing. The line is held for them and
    // the existing silence clock closes it — the registration intact.
    const quiet = await runScripted({
      transcriptSoFar: [agent(GREETING), agent(GATE), caller("Yes, please reserve it.")],
      drive: async (s) => {
        await wait(300);
        s.beginReply();
        await wait(400);
        s.finishReply(CONFIRMED);
        s.say("And what time does it start?");
        s.beginReply();
        await wait(400);
        s.finishReply(ANSWER);
      },
    });
    assert.equal(
      await hangupReasonOf(quiet.outcome.attemptId!),
      "watchdog:max_silence",
      "the held line must still be closed by the existing silence clock",
    );
    const stored = await outcomeOf(quiet.outcome.attemptId!);
    assert.equal(stored.reason, "confirmed_at_gate", "holding the line must not cost the registration");
    assert.equal(stored.type, "registered_confirmed");
  });

  await test("C6. a plain yes with no question still ends promptly as final_yes", async () => {
    const plain = await runScripted({
      transcriptSoFar: [agent(GREETING), agent(GATE), caller("Yes, please.")],
      drive: async (s) => {
        await wait(300);
        s.beginReply();
        await wait(400);
        s.finishReply(CONFIRMED);
      },
    });
    assert.equal(
      await hangupReasonOf(plain.outcome.attemptId!),
      "agent_hangup:final_yes",
      "a completed confirmation must be unaffected by the fix",
    );
    const afterReplyMs = plain.telemetry.endedAt - plain.telemetry.firstReplyCommittedAt;
    assert.ok(
      afterReplyMs < WINDOW_MS,
      `...and promptly, not a silence window later (${afterReplyMs}ms)`,
    );
    assert.notEqual(plain.telemetry.endedInState, SessionState.SPEAKING);
  });
} finally {
  await query("DELETE FROM campaigns WHERE id = $1", [campaignId]).catch(() => undefined);
  if (savedSpreadsheetId === undefined) delete process.env["CAMPAIGN_SHEET_SPREADSHEET_ID"];
  else process.env["CAMPAIGN_SHEET_SPREADSHEET_ID"] = savedSpreadsheetId;
  await closeDbPool();
}

report();
