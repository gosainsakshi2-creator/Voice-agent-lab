/**
 * announced-question-hangup-tests.ts — `npm run test:announced-question`
 *
 * ONE REPORTED DEFECT, FROM A REAL CALL: THE PERSON SAYS A QUESTION IS
 * COMING AND THE LINE IS DROPPED BEFORE THEY CAN ASK IT.
 *
 *   agent    "Would you like me to reserve your free seat?"
 *   caller   "Yes, I am registering, but I have a question."
 *   agent    "Okay, I'll register you, and you can ask your questions."
 *   ->       reason=confirmed_at_gate, HANGUP=FINAL_YES, call ended
 *
 * Every step of that except the last is correct, and the fix does not
 * touch any of them. The person DID commit: `classifyOutcome` returns
 * `registered_confirmed` / `confirmed_at_gate`, `dispositionFor`
 * returns FINAL_YES, `isFinalYes` opens the registrations sheet, and
 * all three still do. What the watchdog could not see is that the
 * person was still holding the floor — they named a question, the agent
 * invited it, and the hangup landed in the gap.
 *
 * A SECOND DEFECT WAS REPORTED AGAINST THE SAME LIFECYCLE, one exchange
 * later: the person asked the question, the agent answered it
 * correctly, and the call was dropped on the agent's own last word. A6,
 * B2 and D3 below used to assert exactly that ending; they now assert
 * against it. `post-registration-question-tests.ts` is that defect's own
 * suite and `callerQuestionPending` in `call-runner.ts` is the reading
 * the two of them share.
 *
 * THE FIX IS IN THE HANGUP AND NOWHERE ELSE. `definitiveAnswerIn`
 * already refuses to end a call while the AGENT's last turn asks
 * something; it now also refuses while the PERSON's last turn announces
 * a question they have not yet put, or asks one. The verdict is
 * untouched, so the call still settles FINAL_YES when it does end — on
 * the person closing the conversation, on the agent's closing, or on
 * the silence window, exactly as every undecided call already ends.
 *
 * WHAT THIS SUITE IS FOR:
 *
 *   A  an announced question holds the line — English, Hinglish and
 *      Devanagari — and keeps holding it through the question being
 *      asked and answered, releasing only when the PERSON takes a turn
 *      and asks nothing
 *   B  the controls: a plain "Yes, please." / "Haan, kar dijiye." /
 *      "Okay." still ends the call as FINAL_YES, and a question ASKED
 *      in the same breath holds the line on the same terms
 *   C  the fix is SUBTRACTIVE: it can only withhold a FINAL_YES, never
 *      produce one, and it does not touch the FINAL_NO path
 *   D  the live watchdog, through the real `runCall`: the reported
 *      exchange does not end the call, and the person gets to ask
 *
 * Sections A-C place no call and touch no database. Section D drives
 * the real watchdog through a fake manager on a scripted clock — no
 * telephony, STT, LLM, TTS or Google request is made.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { config as loadEnvFile } from "dotenv";

loadEnvFile({ path: ".env.local", quiet: true });
loadEnvFile({ quiet: true });

const { getDispatchConfig } = await import("../config/dispatch.config");
const { runCall, definitiveAnswerIn } = await import("../dispatch/call-runner");
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
/** The agent's reply on the reported call — it asks nothing, verbatim. */
const ACK = "Okay, I'll register you, and you can ask your questions.";
const CONFIRMED = "Done, your seat is reserved. You will get the joining link on WhatsApp.";

/** The reported call, up to and including the agent's reply. */
const afterGate = (line: string): readonly ConversationTurn[] => [
  agent(GREETING),
  agent(GATE),
  caller(line),
  agent(ACK),
];

/** What the live watchdog reads. */
const liveReading = (line: string) => definitiveAnswerIn(afterGate(line), "registration");

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
// SECTION A — an announced question holds the line.
// ═════════════════════════════════════════════════════════════════

section("A. A QUESTION ANNOUNCED BUT NOT YET ASKED HOLDS THE LINE");

await test("A1. the reported line does not end the call", () => {
  assert.equal(
    liveReading("Yes, I am registering, but I have a question."),
    undefined,
    "the exact production turn must no longer produce a FINAL_YES hangup",
  );
});

await test("A2. ...while the REGISTRATION it contains is untouched", () => {
  // The whole safety case for fixing this in the hangup rather than in
  // the classifier: the person committed, and the sheet row is owed
  // whatever the watchdog does about the line.
  const { classification, disposition, sheetRow } = settle(
    afterGate("Yes, I am registering, but I have a question."),
  );
  assert.equal(classification.primaryReason, "confirmed_at_gate");
  assert.equal(classification.outcomeType, "registered_confirmed");
  assert.equal(classification.succeeded, true);
  assert.equal(disposition, "FINAL_YES");
  assert.equal(sheetRow, true, "the registrations-sheet row must still be written");
});

await test("A3. English variants", () => {
  for (const line of [
    "Yes, I am registering, but I have a question.",
    "Yes register me, I have a doubt.",
    "Yes, please reserve it. I have one question.",
    "Sure, go ahead. I have a small doubt.",
    "Yes, register me, but I wanted to ask something.",
    "Okay, book it. Can I ask something?",
    "Yes, do it — I have a quick question.",
  ]) {
    assert.equal(liveReading(line), undefined, `must not hang up on: "${line}"`);
  }
});

await test("A4. Hinglish variants", () => {
  for (const line of [
    "Haan ji, ek sawaal hai.",
    "Haan, mujhe ek question poochna hai.",
    "Haan, register kar dijiye, ek baat poochni hai.",
    "Bilkul, kar dijiye. Ek doubt hai.",
    "Theek hai, reserve kar dijiye, ek sawal puchna tha.",
  ]) {
    assert.equal(liveReading(line), undefined, `must not hang up on: "${line}"`);
  }
});

await test("A5. Devanagari variants", () => {
  for (const line of [
    "हाँ, मुझे एक सवाल पूछना है।",
    "हाँ जी, एक सवाल है।",
    "हाँ, कर दीजिए, एक बात पूछनी है।",
    "बिल्कुल, रजिस्टर कर दीजिए। एक प्रश्न है।",
  ]) {
    assert.equal(liveReading(line), undefined, `must not hang up on: "${line}"`);
  }
});

await test("A6. the hold SURVIVES the question being asked and answered", () => {
  // This assertion was inverted by the SECOND reported defect, and the
  // inversion is the point. It used to read "released once the question
  // is asked" — the announcement was gone, the question had replaced
  // it, the FINAL_YES from the gate was still waiting, and so the
  // agent's answer became the hangup. That is the same person being cut
  // off one exchange later than before. An ASKED question now holds the
  // line on the same terms an announced one does; see
  // `callerQuestionPending` and `post-registration-question-tests.ts`.
  const announced = afterGate("Yes, I am registering, but I have a question.");
  assert.equal(definitiveAnswerIn(announced, "registration"), undefined, "held while announced");

  const asked = [
    ...announced,
    caller("What time does the session start?"),
    agent("It starts at 7:30 pm today, and the link comes on WhatsApp."),
  ];
  assert.equal(
    definitiveAnswerIn(asked, "registration"),
    undefined,
    "the agent's answer is not the person saying they are done",
  );

  // Released by the person, and only by the person.
  assert.equal(
    definitiveAnswerIn([...asked, caller("No, that's all. Thank you."), agent("Perfect, see you there.")], "registration"),
    "FINAL_YES",
    "a caller turn that asks nothing closes the conversation as it always did",
  );
});

await test("A7. ...and by anything else the person says next", () => {
  // The release is "the announcement is no longer the last thing they
  // said", not "they asked a question" — so a person who announces one
  // and then drops it does not hold the line open indefinitely.
  //
  // Deliberately NOT a retraction ("Actually no, that's all."): that
  // one is already handled by the confirmation binding and would leave
  // the call FINAL_NO for reasons that have nothing to do with this
  // fix. What is asserted here is the release, on a turn that changes
  // no verdict.
  for (const line of ["Perfect, thank you.", "Okay, thank you.", "Nothing else, thanks."]) {
    const moved = [...afterGate("Yes, I am registering, but I have a question."), caller(line), agent("Great.")];
    assert.equal(definitiveAnswerIn(moved, "registration"), "FINAL_YES", `released by: "${line}"`);
  }
});

// ═════════════════════════════════════════════════════════════════
// SECTION B — the controls.
// ═════════════════════════════════════════════════════════════════

section("B. GENUINE COMPLETED CONFIRMATIONS STILL END THE CALL");

await test("B1. a plain yes at the gate still reads FINAL_YES", () => {
  for (const line of [
    "Yes, please.",
    "Haan, kar dijiye.",
    "Okay.",
    "Yes, please reserve it.",
    "Sure, go ahead.",
    "Bilkul, register kar dijiye.",
    "हाँ, कर दीजिए।",
    "Haanji.",
    "Theek hai.",
  ]) {
    assert.equal(liveReading(line), "FINAL_YES", `must still hang up on: "${line}"`);
  }
});

await test("B2. a question ASKED in the same breath holds the line too", () => {
  // Also inverted by the second defect, and for the same reason. These
  // name a question AND put it, so the agent's next turn is the answer
  // — which is exactly the moment the person is owed a turn, not the
  // moment the call is over. The two readings divide the shapes between
  // them: `announcesAnUnaskedQuestion` declines these because the
  // remainder asks something, and `isQuestionTurn` takes them.
  for (const line of [
    "Yes, register me — how do I join?",
    "Yes register me, I have a question. What time is it?",
    "Haan register kar dijiye, ek baat batao, kitne baje hai?",
    "Okay, book it. What is the link?",
  ]) {
    assert.equal(liveReading(line), undefined, `must not hang up on: "${line}"`);
  }
});

await test("B3. the agent's own pending question still holds the line", () => {
  // The guard that already existed, re-asserted so the new one cannot
  // be mistaken for it or accidentally replace it.
  assert.equal(
    definitiveAnswerIn(
      [agent(GREETING), agent(GATE), caller("Yes, please."), agent("Sorry — shall I reserve it for you?")],
      "registration",
    ),
    undefined,
  );
});

await test("B4. a bare mention of a question after the gate is not an announcement", () => {
  // Nothing here NAMES a question of the person's own, so nothing here
  // may hold the line. This is what keeps the rule from being
  // "the word 'question' means never hang up" — and "without a doubt"
  // in particular is how people say YES.
  for (const line of [
    "Yes, that answers my question. Please register me.",
    "Okay, my question is answered. Please reserve it.",
    "Yes, without a doubt.",
    "Yes, no doubt, please reserve it.",
  ]) {
    assert.equal(liveReading(line), "FINAL_YES", `must still hang up on: "${line}"`);
  }
});

// ═════════════════════════════════════════════════════════════════
// SECTION C — the fix is subtractive.
// ═════════════════════════════════════════════════════════════════

section("C. THE FIX CAN ONLY WITHHOLD A HANGUP, NEVER CREATE ONE");

/** Every caller line this suite knows about, positive and negative. */
const CORPUS = [
  "Yes, I am registering, but I have a question.",
  "Yes register me, I have a doubt.",
  "Haan ji, ek sawaal hai.",
  "Haan, mujhe ek question poochna hai.",
  "हाँ, मुझे एक सवाल पूछना है।",
  "हाँ जी, एक सवाल है।",
  "Yes, register me, but I wanted to ask something.",
  "Okay, book it. Can I ask something?",
  "Yes, please.",
  "Haan, kar dijiye.",
  "Okay.",
  "Sure, go ahead.",
  "हाँ, कर दीजिए।",
  "Yes, register me — how do I join?",
  "No, I'm not interested.",
  "No, I don't want to join.",
  "Wrong number.",
  "Call me later please.",
  "I will see how the day goes.",
  "Hmm.",
] as const;

await test("C1. every FINAL_YES it still returns is one the unchanged readings agree on", () => {
  // The hangup cannot invent a registration: a FINAL_YES from the
  // watchdog is always a call `classifyOutcome`, `dispositionFor` and
  // `isFinalYes` had already settled that way. This is what makes the
  // guard subtractive by construction rather than by inspection.
  for (const line of CORPUS) {
    if (liveReading(line) !== "FINAL_YES") continue;
    const { classification, disposition, sheetRow } = settle(afterGate(line));
    assert.equal(classification.primaryReason, "confirmed_at_gate", `for: "${line}"`);
    assert.equal(disposition, "FINAL_YES", `for: "${line}"`);
    assert.equal(sheetRow, true, `for: "${line}"`);
  }
});

await test("C2. nothing the classifier calls anything else ever hangs up as FINAL_YES", () => {
  for (const line of CORPUS) {
    const { disposition } = settle(afterGate(line));
    if (disposition === "FINAL_YES") continue;
    assert.notEqual(liveReading(line), "FINAL_YES", `must not read FINAL_YES: "${line}"`);
  }
});

await test("C3. the FINAL_NO path is untouched", () => {
  // Deliberately out of scope. The guard is inside the FINAL_YES branch
  // only, so a refusal reads exactly as it did before the fix.
  for (const [line, expected] of [
    ["No, I'm not interested.", "FINAL_NO"],
    ["No, I don't want to join.", "FINAL_NO"],
    ["Wrong number.", "FINAL_NO"],
    ["Call me later please.", undefined],
    ["I will see how the day goes.", undefined],
  ] as const) {
    assert.equal(liveReading(line), expected, `unchanged reading for: "${line}"`);
  }
});

// ═════════════════════════════════════════════════════════════════
// SECTION D — the live watchdog, through the real `runCall`.
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
  const sessionId = `announced-${randomUUID()}`;
  const transcript: ConversationTurn[] = [...input.transcriptSoFar];

  let state: SessionState = SessionState.CALLING;
  let closed = false;

  const telemetry = {
    endCalls: 0,
    endedInState: undefined as SessionState | undefined,
    endedAt: 0,
    /**
     * When the agent's FIRST reply was committed — set once, so a
     * later reply cannot move the mark the hold is measured from.
     */
    firstReplyCommittedAt: 0,
    /** Whether the call was still up when the person asked their question. */
    upWhenAsked: false,
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
      transition(SessionState.LISTENING);
    },
    /** The PERSON speaks. Only possible while the line is still up. */
    say(text: string): void {
      if (closed) return;
      telemetry.upWhenAsked = true;
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
  console.log("\n[SKIP] section D — DATABASE_URL is not set");
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
    [campaignId, `+9198115${String(70000 + seedIndex)}`, seedIndex],
  );
  const contactId = inserted.rows[0]!.id;

  const claimed = await claimContacts(campaignId, "cartesia" as never, 50, "announced-question");
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
     VALUES ($1, '__announced_question__', 'registration', 'READY', 'registration', 'v1', $2,
             '{"cartesia":100}'::jsonb, 'vobiz', 'en', $3, '{"agent":{"gender":"female"}}'::jsonb)`,
    [campaignId, hashScript(registrationScript!), `announced-${campaignId}`],
  );

  // ═══════════════════════════════════════════════════════════════
  section("D. THE LIVE WATCHDOG — THE REPORTED CALL, END TO END");

  // The reported exchange, driven through the real `runCall`: the
  // person announces a question, the agent's reply is committed, and
  // then — as on the real call — they take a moment before asking it.
  // Before the fix the call was gone within one 500ms tick of the
  // agent's reply; `say()` below could not have happened at all.
  const held = await runScripted({
    transcriptSoFar: [agent(GREETING), agent(GATE), caller("Yes, I am registering, but I have a question.")],
    drive: async (s) => {
      await wait(300);
      s.beginReply();
      await wait(500);
      s.finishReply(ACK);
      // Several watchdog ticks of thinking time — the gap the person
      // was being cut off in.
      await wait(TICKS_MS);
      s.say("What time does the session start?");
      s.beginReply();
      await wait(500);
      s.finishReply("It starts at 7:30 pm today, and the link comes on WhatsApp.");
    },
  });

  await test("D1. the person gets to ask their question — the line is still up", async () => {
    assert.equal(
      held.telemetry.upWhenAsked,
      true,
      "the call must still be up when the announced question is finally asked",
    );
  });

  await test("D2. ...and the call was NOT ended in the gap after the agent's reply", () => {
    const heldForMs = held.telemetry.endedAt - held.telemetry.firstReplyCommittedAt;
    assert.ok(
      heldForMs > TICKS_MS,
      `the line must survive the gap, not one watchdog tick (${heldForMs}ms)`,
    );
  });

  await test("D3. and NOT once the agent has answered it either", async () => {
    // Inverted by the second reported defect, like A6 and B2 above. The
    // person asks, the agent answers, and `drive` then stops without
    // the person saying anything more — so the conversation is left
    // open for them and ends on the existing silence clock, not on the
    // agent's own last word. `post-registration-question-tests.ts`
    // drives the other half: the person closes it, and the call ends as
    // agent_hangup:final_yes there.
    assert.equal(held.outcome.failureClass, "COMPLETED");
    assert.equal(
      await hangupReasonOf(held.outcome.attemptId!),
      "watchdog:max_silence",
      "the answer must not be the hangup — the next turn was theirs",
    );
  });

  await test("D4. ...and the registration is recorded exactly as before", async () => {
    const stored = await outcomeOf(held.outcome.attemptId!);
    assert.equal(stored.reason, "confirmed_at_gate");
    assert.equal(stored.type, "registered_confirmed");
  });

  // ═══════════════════════════════════════════════════════════════
  // The control, through the same live path.
  await test("D5. a plain yes at the gate still ends promptly as final_yes", async () => {
    const plain = await runScripted({
      transcriptSoFar: [agent(GREETING), agent(GATE), caller("Yes, please.")],
      drive: async (s) => {
        await wait(300);
        s.beginReply();
        await wait(500);
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

  // The other ending an announced question can reach: the person never
  // asks. The line is held, and the call then ends the way every
  // undecided call already ends — on the silence window — with the
  // registration still recorded.
  await test("D6. an announced question that is never asked ends on the silence window", async () => {
    const quiet = await runScripted({
      transcriptSoFar: [agent(GREETING), agent(GATE), caller("Yes register me, I have a doubt.")],
      drive: async (s) => {
        await wait(300);
        s.beginReply();
        await wait(500);
        s.finishReply(ACK);
      },
    });
    assert.equal(
      await hangupReasonOf(quiet.outcome.attemptId!),
      "watchdog:max_silence",
      "the held line must still be closed by the existing silence clock",
    );
    const stored = await outcomeOf(quiet.outcome.attemptId!);
    assert.equal(stored.reason, "confirmed_at_gate", "the registration is not lost by holding the line");
    assert.equal(stored.type, "registered_confirmed");
  });
} finally {
  await query("DELETE FROM campaigns WHERE id = $1", [campaignId]).catch(() => undefined);
  if (savedSpreadsheetId === undefined) delete process.env["CAMPAIGN_SHEET_SPREADSHEET_ID"];
  else process.env["CAMPAIGN_SHEET_SPREADSHEET_ID"] = savedSpreadsheetId;
  await closeDbPool();
}

report();
