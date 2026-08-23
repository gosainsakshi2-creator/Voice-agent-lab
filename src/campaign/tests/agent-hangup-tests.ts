/**
 * agent-hangup-tests.ts — `npm run test:agent-hangup`
 *
 * ONE REPORTED DEFECT: THE AGENT SAYS "THANKS FOR YOUR TIME, TAKE
 * CARE." AND THE VOBIZ CALL STAYS UP.
 *
 * The campaign watchdog had exactly one agent-initiated ending, and it
 * reads what the PERSON said: `definitiveAnswerIn` runs the real
 * classifier over the live transcript and fires on a FINAL_YES at the
 * gate or on an UNMISTAKABLE FINAL_NO. Every other way a conversation
 * ends — the classifier's `unclear`, `affirmative_not_at_gate`,
 * `callback_requested`, `interested_not_confirmed` — produced no
 * verdict, so nothing ended the call. The agent had already said
 * goodbye and the line was then held open until the silence window
 * expired; a person who offered one more pleasantry re-armed it.
 *
 * The fix adds a SECOND reading at the same watchdog decision point,
 * checked after the first: has the AGENT closed the conversation? It is
 * a hangup condition only. What the call MEANT is still decided by
 * `classifyOutcome` and `dispositionFor` inside `finalize`, from the
 * finished transcript, exactly as for every other completed call.
 *
 * WHAT THIS SUITE IS FOR. Every guarantee the change had to keep:
 *
 *   A  the closing ends the call — after its audio has finished, never
 *      during it, and promptly rather than a silence window later
 *   B  a mid-conversation "take care" does NOT hang up
 *   C  FINAL_YES and FINAL_NO still take their own path and name their
 *      own hangup reason
 *   D  a remote (manual) hangup is untouched
 *   E  a machine is untouched: an agent-only transcript never closes a
 *      call, so voicemail still ends the way it already did
 *
 * Section F is `agentClosedIn` on its own — the phrase table and the
 * four guards, with no database and no call.
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
const { runCall, agentClosedIn } = await import("../dispatch/call-runner");
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

// ═════════════════════════════════════════════════════════════════
// SECTION F — `agentClosedIn`, on its own. No database, no call.
// Runs first so the phrase table is checked even where the campaign
// database is unreachable.
// ═════════════════════════════════════════════════════════════════

section("F. WHAT COUNTS AS THE AGENT CLOSING THE CONVERSATION");

/** A normal exchange, so only the last agent turn is ever the question. */
const EXCHANGE: readonly ConversationTurn[] = [
  agent("Hi Priya, this is Ishita from Team FlexiFunnels."),
  caller("Yes, tell me."),
  agent("We are doing a live demo of the Funnel Builder Agent today at 7:30 pm."),
  caller("I will see how the day goes."),
];

const closesOn = (text: string): boolean => agentClosedIn([...EXCHANGE, agent(text)]);

await test("F1. a sign-off the agent ends its turn on closes the call", () => {
  for (const closing of [
    "Thanks for your time, take care.",
    "No problem at all, thanks for your time.",
    "Understood. Have a great day!",
    "Alright, goodbye.",
    "See you today!",
    "Sure. Bye.",
    "Theek hai, apna dhyan rakhiye.",
    "Aapke samay ke liye dhanyavaad.",
    "ठीक है, अपना ध्यान रखिए",
  ]) {
    assert.ok(closesOn(closing), `must read as a closing: "${closing}"`);
  }
});

await test("F2. a closing phrase used MID-CONVERSATION does not close the call", () => {
  for (const notClosing of [
    // The same words, inside a turn that carries on afterwards. This is
    // the exact false positive the change must never produce.
    "Just take care to join a few minutes early, the link will be on WhatsApp today.",
    "Take care of the registration and I will send you the details in ten minutes.",
    "Have a great day at work, and I will call you back this evening as agreed.",
    "See you today is what I would say, but let me first explain what the session covers.",
    // A block from the approved script.
    "You can build your website, funnel, product, course, payment collection, lead generation and even automate your business, just by chatting with AI.",
    "I'll get your registration done and send the details to you on WhatsApp and email within 10 mins.",
  ]) {
    assert.equal(closesOn(notClosing), false, `must NOT read as a closing: "${notClosing}"`);
  }
});

await test("F3. a turn that still asks something is a handover point, never an ending", () => {
  for (const question of [
    "Would you be interested to attend? Take care.",
    "Take care — shall I reserve your free seat?",
    "Have a great day. Should I send the link?",
  ]) {
    assert.equal(closesOn(question), false, `a question is not an ending: "${question}"`);
  }
});

await test("F4. an ordinary courtesy is not a sign-off", () => {
  for (const courtesy of [
    "Thank you.",
    "Okay.",
    "Sure, no problem.",
    "Perfect!",
    "Shukriya.",
    "Namaste Priya.",
  ]) {
    assert.equal(closesOn(courtesy), false, `must NOT read as a closing: "${courtesy}"`);
  }
});

await test("F5. the last turn must be the AGENT's — a talking caller is never cut off", () => {
  assert.equal(
    agentClosedIn([...EXCHANGE, agent("Thanks for your time, take care."), caller("Wait, actually")]),
    false,
    "the live partial utterance a caller is speaking must block the hangup",
  );
});

await test("F6. an agent-only transcript never closes a call", () => {
  assert.equal(
    agentClosedIn([agent("Hi Priya, this is Ishita."), agent("Thanks for your time, take care.")]),
    false,
    "a call the person never spoke in is a machine or a dead line, not a conversation that ended",
  );
  assert.equal(agentClosedIn([]), false, "an empty transcript closes nothing");
});


// ═════════════════════════════════════════════════════════════════
// SECTION G — THE REPORTED PRODUCTION REGRESSION.
//
// Every case in F1 above happens to stop on a table phrase with
// NOTHING after it, so the suite passed while the shape the agent
// actually produces on a live call did not close anything.
//
// This script is name-driven — `{{customer_name}}`, `requiresName:
// true`, and the whole prompt stack addresses the person by name — and
// the closing is the most natural place in a call to use it. The
// reported ending was "Take care, Sakshi.", which normalises to
// " take care sakshi " and therefore did not END on " take care ". No
// closing was seen, no `AGENT_CLOSED` verdict was produced, and the
// line was held open to the silence window; by then the person had
// already put the phone down, so Vobiz answered `endCall` with a 404.
// ═════════════════════════════════════════════════════════════════

section("G. A CLOSING WITH A TRAILING VOCATIVE (THE REPORTED DEFECT)");

await test("G1. the reported production closings close the call", () => {
  for (const closing of [
    // Verbatim from the production log.
    "Take care, Sakshi.",
    // The same defect, every other shape it appears in.
    "Take care, Priya!",
    "Sure. Have a good day, Sakshi.",
    "Have a nice day, Sakshi!",
    "Thank you, have a great day ahead.",
    "No problem at all. Thanks for your time, Sakshi.",
    "Alright, goodbye Priya.",
    "Theek hai, apna dhyan rakhiye ji.",
    "Apna dhyan rakhiye, Sakshi ji.",
  ]) {
    assert.ok(closesOn(closing), `must read as a closing: "${closing}"`);
  }
});

await test("G2. ...and the exact ending that stopped the call is still short of the cap", () => {
  // The relaxation is the TAIL rule alone. The word cap, the
  // last-turn-is-the-agent guard, the person-spoke guard and the
  // no-question guard are all unchanged, and the reported turn passes
  // every one of them — so the tail was the only thing blocking it.
  assert.ok(closesOn("Take care, Sakshi."));
  assert.equal(agentClosedIn([...EXCHANGE, agent("Take care, Sakshi?")]), false, "still a question");
  assert.equal(
    agentClosedIn([...EXCHANGE, agent("Take care, Sakshi."), caller("wait")]),
    false,
    "a talking caller still blocks it",
  );
  assert.equal(
    agentClosedIn([agent("Hi Priya, this is Ishita."), agent("Take care, Sakshi.")]),
    false,
    "an agent-only transcript still closes nothing",
  );
});

await test("G3. a CONTINUATION after the phrase is still not a closing", () => {
  // The false positive the tail rule must not re-open: a short tail
  // that carries the sentence on rather than trailing off it. Every
  // one of these is <= 2 words after the phrase, so only the
  // continuation-word half of the rule can reject them.
  for (const notClosing of [
    "Have a great day at work.",
    "Take care of yourself.",
    "Take care and rest.",
    "Thanks for your time on this.",
    "See you soon with Priya.",
    "Have a good day if possible.",
    "Bye is premature.",
    "Take care ke baad.",
  ]) {
    assert.equal(closesOn(notClosing), false, `must NOT read as a closing: "${notClosing}"`);
  }
});

await test("G4. a tail longer than a vocative is not a closing", () => {
  for (const notClosing of [
    // Three words after the phrase, none of them a continuation word.
    "Take care Sakshi ji madam.",
    "Have a great day Sakshi madam ji.",
    // The mid-conversation cases from F2, re-asserted through the new
    // reading so a future widening of the tail cap trips here.
    "Just take care to join a few minutes early, the link will be on WhatsApp today.",
    "Take care of the registration and I will send you the details in ten minutes.",
  ]) {
    assert.equal(closesOn(notClosing), false, `must NOT read as a closing: "${notClosing}"`);
  }
});

await test("G5. a turn using a closing phrase mid-sentence AND at its end still closes", () => {
  // Measured on the LAST occurrence, so the mid-sentence use does not
  // mask a genuine ending.
  assert.ok(closesOn("Take care to join early. Take care, Sakshi."));
});

// ═════════════════════════════════════════════════════════════════
// SECTIONS A-E — the live watchdog, through the real `runCall`.
// ═════════════════════════════════════════════════════════════════

const GREETING = "Hi Priya, this is Ishita from Team FlexiFunnels.";
const GATE = "So Priya, should I reserve your free seat for the live event?";
const CONFIRMED = "Done, your seat is reserved. You will get the joining link on WhatsApp.";
/** The reported production ending: the agent finishes, nothing ends the call. */
const CLOSING = "Thanks for your time, take care.";
/** The same phrase, in the middle of a reply that carries on. */
const MID_CONVERSATION =
  "Just take care to join a few minutes early, and the link will be on WhatsApp today.";

// The window every test below runs against. Scaled down from the
// shipped 20s so the suite is fast; the clock under test is the shipped
// one, unmodified, and every deadline here is expressed in terms of it.
const WINDOW_SECONDS = 3;
const WINDOW_MS = WINDOW_SECONDS * 1000;
/** One 500ms watchdog tick, plus room for scheduling on a loaded box. */
const TICK_SLACK_MS = 1_800;

interface ScriptedSession {
  /** LISTENING -> THINKING -> SPEAKING, as `runThinkingAndSpeaking` does. */
  beginReply(): void;
  /**
   * The reply's audio has DRAINED. Commits the agent's turn and only
   * then returns to LISTENING — the real order, and the reason a
   * closing can never be read while it is still playing:
   * `agentClosedIn` requires the last turn to be the agent's.
   */
  finishReply(text: string): void;
  /** The far end hung up: the session ends itself, as a remote hangup does. */
  remoteHangup(): void;
}

function scriptedManager(input: {
  readonly transcriptSoFar: readonly ConversationTurn[];
  readonly drive: (session: ScriptedSession) => Promise<void>;
}) {
  let listener: ((sessionId: string, transition: unknown) => void) | undefined;
  const sessionId = `close-${randomUUID()}`;
  const transcript: ConversationTurn[] = [...input.transcriptSoFar];

  let state: SessionState = SessionState.CALLING;
  let closed = false;

  const telemetry = {
    endCalls: 0,
    endedInState: undefined as SessionState | undefined,
    endedAt: 0,
    replyStartedAt: 0,
    replyFinishedAt: 0,
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
    remoteHangup(): void {
      if (closed) return;
      transition(SessionState.IDLE);
      closed = true;
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
        breakdown: {
          telephony: 0.005,
          speechToText: 0.005,
          languageModel: 0.005,
          textToSpeech: 0.005,
        },
      },
      turnLatencies: [],
    }),
    getTranscript: () => [...transcript],
    // The caller is silent for the whole of every test here, so nothing
    // ever stamps the pipeline's heard-audio clock: the only things that
    // can end one of these calls are the watchdog's own readings.
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
  console.log("\n[SKIP] sections A-E — DATABASE_URL is not set");
  report();
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
    [campaignId, `+9198117${String(60000 + seedIndex)}`, seedIndex],
  );
  const contactId = inserted.rows[0]!.id;

  const claimed = await claimContacts(campaignId, "cartesia" as never, 50, "agent-hangup");
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
     VALUES ($1, '__agent_hangup__', 'registration', 'READY', 'registration', 'v1', $2,
             '{"cartesia":100}'::jsonb, 'vobiz', 'en', $3, '{"agent":{"gender":"female"}}'::jsonb)`,
    [campaignId, hashScript(registrationScript!), `close-${campaignId}`],
  );

  // ═══════════════════════════════════════════════════════════════
  section("A. THE AGENT'S CLOSING ENDS THE CALL — AFTER IT HAS FINISHED PLAYING");

  // The reported production ending. The person was positive but never
  // committed at the gate, so the classifier's verdict is
  // `interested_not_confirmed` / `affirmative_not_at_gate` — one label
  // short of anything `definitiveAnswerIn` can fire on. The closing is
  // deliberately longer than the whole silence window, so a hangup that
  // fired early would show up as an `end()` in SPEAKING.
  const closed = await runScripted({
    transcriptSoFar: [
      agent(GREETING),
      caller("Yes, tell me."),
      agent("We are doing a live demo of the Funnel Builder Agent today at 7:30 pm."),
      caller("Okay, I will see how the day goes."),
    ],
    drive: async (s) => {
      await wait(300);
      s.beginReply();
      await wait(WINDOW_MS * 2);
      s.finishReply(CLOSING);
    },
  });

  await test("A1. the call is ended, and named as the agent's own hangup", async () => {
    assert.equal(closed.telemetry.endCalls, 1, "through the manager's public end(), once");
    assert.equal(closed.outcome.failureClass, "COMPLETED");
    assert.equal(
      await hangupReasonOf(closed.outcome.attemptId!),
      "agent_hangup:closing",
      "the closing must be the reason the call ended, not a silence timeout",
    );
  });

  await test("A2. the closing audio finishes first — end() is never called in SPEAKING", () => {
    assert.notEqual(
      closed.telemetry.endedInState,
      SessionState.SPEAKING,
      "the person must hear the closing in full",
    );
    assert.notEqual(closed.telemetry.endedInState, SessionState.THINKING);
    assert.equal(closed.telemetry.endedInState, SessionState.LISTENING);
    const spokenForMs = closed.telemetry.replyFinishedAt - closed.telemetry.replyStartedAt;
    assert.ok(
      spokenForMs >= WINDOW_MS * 2,
      `the closing must be spoken through, spoke for ${spokenForMs}ms`,
    );
    assert.ok(
      closed.telemetry.endedAt >= closed.telemetry.replyFinishedAt,
      "the hangup must come after the closing was committed, never before",
    );
  });

  await test("A3. and promptly — not one silence window later", async () => {
    const afterClosingMs = closed.telemetry.endedAt - closed.telemetry.replyFinishedAt;
    assert.ok(
      afterClosingMs < WINDOW_MS,
      `the line must not be held open after goodbye (${afterClosingMs}ms, window is ${WINDOW_MS}ms)`,
    );
    assert.ok(
      afterClosingMs <= TICK_SLACK_MS,
      `...and within one watchdog tick (${afterClosingMs}ms)`,
    );
  });


  // The reported production ending, verbatim, driven end to end. A1-A3
  // above use "Thanks for your time, take care." — the one shape that
  // already worked. This is the one that did not: same path, same
  // verdict, same hangup reason, and the closing still spoken through
  // to its end before anything hangs up.
  const vocative = await runScripted({
    transcriptSoFar: [
      agent(GREETING),
      caller("Yes, tell me."),
      agent("We are doing a live demo of the Funnel Builder Agent today at 7:30 pm."),
      caller("No, I don't want to join."),
    ],
    drive: async (s) => {
      await wait(300);
      s.beginReply();
      await wait(WINDOW_MS * 2);
      s.finishReply("Take care, Sakshi.");
    },
  });

  await test("A4. \"Take care, Sakshi.\" — the reported ending — ends the call", async () => {
    assert.equal(vocative.telemetry.endCalls, 1, "through the manager's public end(), once");
    assert.equal(vocative.outcome.failureClass, "COMPLETED");
    assert.equal(
      await hangupReasonOf(vocative.outcome.attemptId!),
      "agent_hangup:closing",
      "a trailing vocative must not stop the closing from being read",
    );
  });

  await test("A5. ...and its audio finishes in full first", () => {
    assert.notEqual(
      vocative.telemetry.endedInState,
      SessionState.SPEAKING,
      "the person must hear the closing in full",
    );
    assert.equal(vocative.telemetry.endedInState, SessionState.LISTENING);
    const spokenForMs = vocative.telemetry.replyFinishedAt - vocative.telemetry.replyStartedAt;
    assert.ok(
      spokenForMs >= WINDOW_MS * 2,
      `the closing must be spoken through, spoke for ${spokenForMs}ms`,
    );
    assert.ok(
      vocative.telemetry.endedAt >= vocative.telemetry.replyFinishedAt,
      "the hangup must come after the closing was committed, never before",
    );
    const afterClosingMs = vocative.telemetry.endedAt - vocative.telemetry.replyFinishedAt;
    assert.ok(
      afterClosingMs < WINDOW_MS && afterClosingMs <= TICK_SLACK_MS,
      `...and within one watchdog tick, not a silence window later (${afterClosingMs}ms)`,
    );
  });

  // ═══════════════════════════════════════════════════════════════
  section("B. A MID-CONVERSATION CLOSING PHRASE DOES NOT HANG UP");

  await test("B1. \"take care\" inside a reply that carries on leaves the call up", async () => {
    const midCall = await runScripted({
      transcriptSoFar: [agent(GREETING), caller("Yes, tell me."), caller("What time is it?")],
      drive: async (s) => {
        await wait(300);
        s.beginReply();
        await wait(500);
        s.finishReply(MID_CONVERSATION);
        // ...and then the line genuinely goes quiet, which is the only
        // thing that may end this call.
      },
    });

    assert.equal(
      await hangupReasonOf(midCall.outcome.attemptId!),
      "watchdog:max_silence",
      "a mid-conversation courtesy must not be read as the end of the call",
    );
    const afterReplyMs = midCall.telemetry.endedAt - midCall.telemetry.listeningAgainAt;
    assert.ok(
      afterReplyMs >= WINDOW_MS - 200,
      `the call must stay up for the full silence window (${afterReplyMs}ms)`,
    );
  });

  await test("B2. a closing phrase followed by a question leaves the call up", async () => {
    const asking = await runScripted({
      transcriptSoFar: [agent(GREETING), caller("Yes, tell me.")],
      drive: async (s) => {
        await wait(300);
        s.beginReply();
        await wait(500);
        s.finishReply("Take care — would you be interested to attend?");
      },
    });
    assert.equal(
      await hangupReasonOf(asking.outcome.attemptId!),
      "watchdog:max_silence",
      "a turn that still asks something is a handover point, not an ending",
    );
  });

  // ═══════════════════════════════════════════════════════════════
  section("C. FINAL_YES AND FINAL_NO ARE UNCHANGED, AND STILL WIN");

  await test("C1. a yes at the gate still ends as agent_hangup:final_yes", async () => {
    const yes = await runScripted({
      transcriptSoFar: [agent(GREETING), agent(GATE), caller("Yes, please reserve it.")],
      drive: async (s) => {
        await wait(300);
        s.beginReply();
        await wait(600);
        s.finishReply(CONFIRMED);
      },
    });
    assert.equal(
      await hangupReasonOf(yes.outcome.attemptId!),
      "agent_hangup:final_yes",
      "the FINAL_YES path is checked first and must still name the hangup",
    );
    assert.notEqual(yes.telemetry.endedInState, SessionState.SPEAKING);
  });

  await test("C2. a refusal closed with a sign-off still ends as agent_hangup:final_no", async () => {
    // The closing here ALSO satisfies `agentClosedIn`. The FINAL_NO
    // reading is taken first, so the reason must still be final_no —
    // this is the ordering assertion.
    const no = await runScripted({
      transcriptSoFar: [agent(GREETING), agent(GATE), caller("No, I'm not interested.")],
      drive: async (s) => {
        await wait(300);
        s.beginReply();
        await wait(600);
        s.finishReply("No problem at all, thanks for your time.");
      },
    });
    assert.equal(
      await hangupReasonOf(no.outcome.attemptId!),
      "agent_hangup:final_no",
      "a FINAL_NO must not be relabelled by the closing check that runs after it",
    );
  });

  // ═══════════════════════════════════════════════════════════════
  section("D. A REMOTE (MANUAL) HANGUP IS UNTOUCHED");

  await test("D1. the far end hanging up still ends the call as remote_hangup", async () => {
    const remote = await runScripted({
      transcriptSoFar: [agent(GREETING), caller("Yes, tell me.")],
      drive: async (s) => {
        await wait(300);
        s.beginReply();
        await wait(400);
        s.finishReply(CLOSING);
        // The person puts the phone down at the same moment. The
        // session ends itself; the watchdog must not be what closed it.
        s.remoteHangup();
      },
    });
    assert.equal(
      remote.telemetry.endCalls,
      0,
      "a session that ended itself must not be ended again by the watchdog",
    );
    assert.equal(
      await hangupReasonOf(remote.outcome.attemptId!),
      "remote_hangup",
      "a call the far end dropped is still a remote hangup",
    );
  });

  // ═══════════════════════════════════════════════════════════════
  section("E. VOICEMAIL IS UNTOUCHED");

  await test("E1. a machine that never lets the agent speak still ends on the silence window", async () => {
    // What the pipeline produces on a detected voicemail: the machine's
    // greeting is RECORDED as a customer turn, the agent's own greeting
    // is deliberately not committed, and nothing is spoken afterwards.
    const machine = await runScripted({
      transcriptSoFar: [
        caller("The person you are calling is not available. Please leave a message after the tone."),
      ],
      drive: async () => undefined,
    });
    assert.equal(
      await hangupReasonOf(machine.outcome.attemptId!),
      "watchdog:max_silence",
      "a machine must still end the way it already did",
    );
  });

  await test("E2. an agent-only transcript ending in a sign-off never closes the call", async () => {
    const noPerson = await runScripted({
      transcriptSoFar: [agent(GREETING)],
      drive: async (s) => {
        await wait(300);
        s.beginReply();
        await wait(400);
        s.finishReply(CLOSING);
      },
    });
    assert.equal(
      await hangupReasonOf(noPerson.outcome.attemptId!),
      "watchdog:max_silence",
      "a call the person never spoke in is not a conversation that concluded",
    );
  });
} finally {
  await query("DELETE FROM campaigns WHERE id = $1", [campaignId]).catch(() => undefined);
  if (savedSpreadsheetId === undefined) delete process.env["CAMPAIGN_SHEET_SPREADSHEET_ID"];
  else process.env["CAMPAIGN_SHEET_SPREADSHEET_ID"] = savedSpreadsheetId;
  await closeDbPool();
}

report();
