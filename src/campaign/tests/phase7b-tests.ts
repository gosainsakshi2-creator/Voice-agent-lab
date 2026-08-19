/**
 * phase7b-tests.ts — `npm run test:phase7b`
 *
 * SCRIPT-FAITHFUL CONVERSATIONAL HANDLING.
 *
 * Phase 7 answered "who gets called again". This suite answers the
 * question underneath it: what counts as an answer at all.
 *
 * The approved script is the conversation, and a real person interrupts
 * it — they ask what the event is, whether it costs anything, whether
 * they can join later. Every one of those turns contains a word the
 * phrase tables recognise, and none of them is a decision. So the tests
 * here are mostly about restraint:
 *
 *   a question is not a yes, and not a no
 *   a courtesy "yes" to "is that okay?" is not a registration
 *   a call that drops mid-sentence is a call we still owe someone
 *   an agent that invents a price, a date or a qualification question
 *     is a defect the report has to be able to see
 *
 * Everything except the last section is PURE: no database, no network,
 * no telephony, no TTS, no STT, no model. The last section reads a
 * seeded campaign back out of PostgreSQL to prove that conversion is
 * counted in people and that a customer question cannot inflate it.
 *
 * NOTHING HERE PLACES A CALL.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { config as loadEnvFile } from "dotenv";

loadEnvFile({ path: ".env.local", quiet: true });
loadEnvFile({ quiet: true });

const { classifyOutcome } = await import("../outcome/classifier");
const { dispositionFor } = await import("../outcome/disposition");
const { planRetry } = await import("../dispatch/retry-planner");
const { getDispatchConfig } = await import("../config/dispatch.config");
const { findScript, hashScript } = await import("../script/script-registry");
const { buildCampaignContext } = await import("../domain/campaign-context");
const { CAMPAIGN_CONVERSATION_POLICY, CONVERSATION_POLICY_ID } = await import(
  "../script/conversation-policy"
);
const { checkScriptAdherence } = await import("../outcome/script-adherence");
const { summariseConversation } = await import("../outcome/conversation-events");
const { buildCampaignResults } = await import("../results/campaign-results");
const { query, closeDbPool } = await import("../db/client");

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
const config = getDispatchConfig();

type Turn = { role: "assistant" | "user"; text: string; at: string | null };
const agent = (text: string): Turn => ({ role: "assistant", text, at: null });
const caller = (text: string): Turn => ({ role: "user", text, at: null });

const registrationScript = findScript("registration", "v1");
const reminderScript = findScript("reminder", "v1");
assert.ok(registrationScript && reminderScript, "both approved scripts must be registered");

const SCRIPT_TEXT = registrationScript.systemPromptAppendix;
const REMINDER_TEXT = reminderScript.systemPromptAppendix;

// The approved script's own lines, quoted as the agent would speak them.
const GREETING = "Hi Priya, this is Ishita from Team FlexiFunnels.";
const PERMISSION = "Can I tell you in 20 seconds why I think you should attend?";
const PITCH =
  "Normally, creating a funnel can involve designers, developers, copywriters and multiple tools. " +
  "In this event you'll see the say it, it's done workflow, where a complete online business can be " +
  "built through a conversation with the Agent. And the best part is the registration is completely FREE.";
const GATE = "So Priya, should I reserve your free seat for the live event?";
const REMINDER_GATE = "So Priya, I've marked you as registered — will you be joining us live?";

function classify(transcript: readonly Turn[], campaignType = "registration", scriptText = SCRIPT_TEXT) {
  return classifyOutcome({
    campaignType,
    status: "COMPLETED",
    failureClass: "COMPLETED",
    answered: true,
    transcript,
    scriptText,
  });
}

/** The contact-level verdict and the retry decision for a classified call. */
function settle(outcome: ReturnType<typeof classify>, campaignType = "registration") {
  const disposition = dispositionFor({ outcomeType: outcome.outcomeType, failureClass: "COMPLETED" });
  const decision = planRetry("COMPLETED", 1, config.retry, new Date(), {
    campaignType,
    disposition: disposition.disposition,
    outcomeType: outcome.outcomeType,
  });
  return { disposition: disposition.disposition, decision };
}

// ═════════════════════════════════════════════════════════════════
section("A. THE SCRIPT RUNS AS WRITTEN");

await test("A. the approved script, followed in order, registers the person", () => {
  const outcome = classify([
    agent(GREETING),
    agent(PERMISSION),
    caller("Sure, go ahead."),
    agent(PITCH),
    agent(GATE),
    caller("Yes, please reserve it."),
  ]);

  assert.equal(outcome.outcomeType, "registered_confirmed");
  assert.equal(outcome.succeeded, true);
  assert.equal(outcome.primaryReason, "confirmed_at_gate");
  assert.equal(settle(outcome).disposition, "FINAL_YES");

  assert.equal(outcome.detail.adherence?.clean, true, "a faithful call must raise no adherence flag");
  assert.equal(outcome.detail.adherence?.restartedScript, false);
  assert.deepEqual(outcome.detail.adherence?.offScriptQuestions, []);
  assert.deepEqual(outcome.detail.adherence?.unsupportedFigures, []);
  assert.equal(outcome.detail.conversation?.customerQuestions, 0);
});

await test("A2. the conversational policy travels with every campaign call, and the script is untouched", () => {
  const before = hashScript(registrationScript);
  const context = buildCampaignContext({
    campaignId: "c1",
    campaignType: "registration",
    script: registrationScript,
    provider: "smallest-ai",
    customerName: "Priya",
    expectedScriptHash: before,
  });

  // The approved words are in there verbatim, placeholders resolved.
  assert.ok(
    context.systemPromptAppendix.includes("should I reserve your free seat for the live event?"),
    "the approved script must reach the prompt unchanged",
  );
  assert.ok(!context.systemPromptAppendix.includes("{{"), "no placeholder may survive");

  // And the handling rules ride after them, not instead of them.
  assert.ok(
    context.systemPromptAppendix.endsWith(CAMPAIGN_CONVERSATION_POLICY),
    "the policy is appended AFTER the script, so the script keeps its position",
  );
  assert.equal(context.conversationPolicyId, CONVERSATION_POLICY_ID);
  assert.equal(
    hashScript(registrationScript),
    before,
    "adding conversational handling must not change a pinned script's hash",
  );
  assert.ok(
    context.systemPromptAppendix.indexOf("--- SCRIPT ---") <
      context.systemPromptAppendix.indexOf("# HOW TO RUN THIS SCRIPT"),
    "the script comes first and the rules about it come last",
  );
});

await test("A3. the policy forbids exactly what it must, in the words it must", () => {
  // Line-wrapped prose: matched on collapsed whitespace so a phrase
  // split across two lines still counts as present.
  const policy = CAMPAIGN_CONVERSATION_POLICY.toLowerCase().replace(/\s+/g, " ");
  for (const required of [
    "never invent a price",
    "you do not add steps",
    "you do not invent questions",
    "never repeat the opening line",
    "please answer yes or no",
    "a question is not an answer",
  ]) {
    assert.ok(policy.includes(required), `the policy must address "${required}"`);
  }
  // It must not smuggle in a qualification flow of its own.
  for (const banned of ["what is your budget", "how many employees", "your monthly revenue"]) {
    assert.ok(!policy.includes(banned), `the policy must not introduce "${banned}"`);
  }
  // Nor constrain language, which the master prompt owns entirely.
  for (const banned of ["only speak", "speak only", "always reply in english"]) {
    assert.ok(!policy.includes(banned), `the policy must not constrain language: "${banned}"`);
  }
});

// ═════════════════════════════════════════════════════════════════
section("B. A QUESTION IS ANSWERED AND THE SCRIPT CONTINUES");

await test("B. a relevant question mid-script is an event, and the later yes still registers", () => {
  const outcome = classify([
    agent(GREETING),
    agent(PERMISSION),
    caller("What exactly is this event about?"),
    agent(
      "It's a live reveal of our Funnel Builder Agent — you'll watch it build a funnel, landing pages, " +
        "products, checkout, courses and emails from simple commands. And the registration is completely FREE.",
    ),
    agent(GATE),
    caller("Yes, please reserve my seat."),
  ]);

  assert.equal(outcome.detail.conversation?.customerQuestions, 1, "the question must be counted");
  assert.equal(outcome.outcomeType, "registered_confirmed", "answering a question does not lose the gate");
  assert.equal(settle(outcome).disposition, "FINAL_YES");
  assert.equal(outcome.detail.adherence?.restartedScript, false, "the agent resumed, it did not restart");
  assert.equal(outcome.detail.adherence?.clean, true);
});

await test("B2. a question BEFORE the gate never becomes the answer to it", () => {
  const outcome = classify([agent(GATE), caller("Is this free? Okay, so what will I actually see?")]);

  assert.notEqual(outcome.outcomeType, "registered_confirmed", "a question is not a registration");
  assert.equal(outcome.succeeded, null, "an undecided call is stored as undecided, never as false");
  assert.equal(outcome.primaryReason, "no_decisive_signal");
  assert.equal(outcome.detail.conversation?.customerQuestions, 1);
  assert.ok(
    /question/i.test(outcome.detail.explanation),
    "the row must say the person was asking, not merely that nothing was decided",
  );
  // The "okay" is still on the row — as evidence, marked unusable.
  const okay = outcome.detail.signals.find((signal) => signal.kind === "affirmation");
  assert.ok(okay, "the phrase must still be recorded for audit");
  assert.equal(okay.decisive, false, "and it must be marked as not an answer");
  assert.equal(okay.atGate, false);

  const { disposition, decision } = settle(outcome);
  assert.equal(disposition, "UNRESOLVED");
  assert.equal(decision.retry, true, "a person who asked a question is still owed a call");
});

// ═════════════════════════════════════════════════════════════════
section("C. AN UNSUPPORTED QUESTION IS NOT ANSWERED WITH AN INVENTION");

await test("C. an honest 'I don't have that detail' raises no flag", () => {
  const outcome = classify([
    agent(GREETING),
    agent(PERMISSION),
    caller("How much does the course cost after the event?"),
    agent("I don't have that detail with me. What I can tell you is that the registration is completely FREE."),
    agent(GATE),
    caller("Yes, please reserve it."),
  ]);

  assert.deepEqual(outcome.detail.adherence?.unsupportedFigures, [], "nothing was invented");
  assert.equal(outcome.detail.adherence?.clean, true);
  assert.equal(outcome.outcomeType, "registered_confirmed");
});

await test("C2. a fabricated price, date or seat count is caught and reported", () => {
  const report = checkScriptAdherence({
    scriptText: SCRIPT_TEXT,
    transcript: [
      agent(GREETING),
      caller("How much is it, and when does it start?"),
      agent("It's ₹4,999 and the next batch starts on 12 August. Only 47 seats are left."),
    ],
  });

  assert.equal(report.clean, false, "an invented figure must not read as a faithful call");
  assert.ok(
    report.unsupportedFigures.some((figure) => figure.includes("4,999")),
    `the invented price must be named, saw ${JSON.stringify(report.unsupportedFigures)}`,
  );
  assert.ok(report.unsupportedFigures.length >= 2, "each invented figure is reported, not just the first");

  // The figures the script DOES supply are never flagged.
  const approved = checkScriptAdherence({
    scriptText: SCRIPT_TEXT,
    transcript: [
      agent(GREETING),
      agent("Live attendees also get the attendee-only bonus bundle worth ₹1,50,000+."),
      agent(PERMISSION),
    ],
  });
  assert.deepEqual(approved.unsupportedFigures, [], "an approved figure must not raise a false alarm");
});

// ═════════════════════════════════════════════════════════════════
section("D. SEVERAL QUESTIONS IN A ROW STAY CONTEXTUAL");

await test("D. three questions, then a registration — counted as three questions and one yes", () => {
  const outcome = classify([
    agent(GREETING),
    agent(PERMISSION),
    caller("What is this event?"),
    agent("A live reveal of the Funnel Builder Agent, building a complete online business from simple commands."),
    caller("Is it online?"),
    agent("Yes, it's a live online session."),
    caller("Okay, and how do I register?"),
    agent(`I'll get your registration done and send the details to you on WhatsApp. ${GATE}`),
    caller("Yes, please register me."),
  ]);

  assert.equal(outcome.detail.conversation?.customerQuestions, 3);
  assert.equal(outcome.outcomeType, "registered_confirmed");
  assert.equal(settle(outcome).disposition, "FINAL_YES");
  assert.equal(outcome.detail.adherence?.restartedScript, false, "the script was never restarted");
  assert.ok(
    outcome.detail.signals.some((signal) => signal.decisive === false),
    '"Okay, and how do I register?" must be recorded as a question, not as the confirmation',
  );
  assert.ok(
    outcome.detail.signals.some((signal) => signal.atGate && signal.decisive !== false),
    "the actual confirmation must be the signal at the gate",
  );
});

// ═════════════════════════════════════════════════════════════════
section("E. A YES TO SOMETHING ELSE IS NOT A REGISTRATION");

await test('E. "yes" to "is that okay?" does not reserve a seat', () => {
  const outcome = classify([
    agent(GATE),
    agent("The registration is completely free. Is that okay?"),
    caller("Yes."),
  ]);

  assert.notEqual(outcome.outcomeType, "registered_confirmed", "the yes answered the wrong question");
  assert.notEqual(outcome.succeeded, true);
  assert.equal(outcome.primaryReason, "affirmative_not_at_gate");
  const { disposition, decision } = settle(outcome);
  assert.notEqual(disposition, "FINAL_YES");
  assert.equal(disposition, "UNRESOLVED");
  assert.equal(decision.retry, true, "nobody registered, so the contact stays open");
});

await test('E2. "haan" inside a question does not reserve a seat either', () => {
  const outcome = classify([agent(GATE), caller("Haan theek hai, par ye event kis time hai?")]);

  assert.notEqual(outcome.outcomeType, "registered_confirmed");
  assert.notEqual(outcome.succeeded, true);
  assert.equal(outcome.detail.conversation?.customerQuestions, 1);
  assert.notEqual(settle(outcome).disposition, "FINAL_YES");
});

// ═════════════════════════════════════════════════════════════════
section("F. A REAL CONFIRMATION IS STILL A REAL CONFIRMATION");

await test("F. an unambiguous yes at the gate registers, in English and in Hinglish", () => {
  for (const reply of [
    "Yes, please register me for the event.",
    "Haan ji, kar dijiye",
    "Sure, go ahead and book my seat.",
  ]) {
    const outcome = classify([agent(PITCH), agent(GATE), caller(reply)]);
    assert.equal(outcome.outcomeType, "registered_confirmed", `"${reply}" must register`);
    assert.equal(outcome.succeeded, true);
    const { disposition, decision } = settle(outcome);
    assert.equal(disposition, "FINAL_YES");
    assert.equal(decision.retry, false, "a registered person is never called again");
  }
});

await test("F2. a reminder confirmation still closes the contact as attending", () => {
  const outcome = classify([agent(REMINDER_GATE), caller("Yes, I will join.")], "reminder", REMINDER_TEXT);
  assert.equal(outcome.outcomeType, "attendance_confirmed");
  assert.equal(outcome.succeeded, true);
  assert.equal(settle(outcome, "reminder").disposition, "FINAL_YES");
});

await test("F3. a registration confirmed BEFORE the line dropped is not undone by a trailing question", () => {
  const outcome = classify([
    agent(GATE),
    caller("Yes, please reserve my seat."),
    agent("Perfect! I'll send the details to you on WhatsApp."),
    caller("Great, and what time does it start—"),
  ]);
  assert.equal(
    outcome.outcomeType,
    "registered_confirmed",
    "an established yes survives a question asked afterwards",
  );
  assert.equal(settle(outcome).disposition, "FINAL_YES");
});

// ═════════════════════════════════════════════════════════════════
section("G. A CLEAR NO IS A CLEAR NO");

await test("G. an explicit refusal and an opt-out both close the contact", () => {
  const declined = classify([agent(GATE), caller("No, I'm not interested.")]);
  assert.equal(declined.outcomeType, "declined");
  assert.equal(settle(declined).disposition, "FINAL_NO");
  assert.equal(settle(declined).decision.retry, false);

  const optOut = classify([agent(GATE), caller("Please don't call me again, remove my number.")]);
  assert.equal(optOut.outcomeType, "do_not_call");
  assert.equal(settle(optOut).disposition, "FINAL_NO");

  // A refusal stated inside a question is still a refusal.
  const refusedWhileAsking = classify([
    agent(GATE),
    caller("I'm not interested — why do you keep calling me?"),
  ]);
  assert.equal(
    refusedWhileAsking.outcomeType,
    "declined",
    "the question wrapper must not rescue an explicit no",
  );
});

await test("G2. a hesitation is NOT a refusal", () => {
  for (const reply of [
    "I need to check first.",
    "Send me the details and I'll decide.",
    "Hmm, I will see how the day goes.",
  ]) {
    const outcome = classify([agent(GATE), caller(reply)]);
    assert.notEqual(outcome.outcomeType, "declined", `"${reply}" is not a refusal`);
    const { disposition, decision } = settle(outcome);
    assert.notEqual(disposition, "FINAL_NO");
    assert.equal(decision.retry, true, `"${reply}" must leave the contact retryable`);
  }
});

// ═════════════════════════════════════════════════════════════════
section("H. A CALLBACK IS A CALLBACK, IN EITHER LANGUAGE");

await test("H. callback intent is recognised in English and Hinglish, and stays retryable", () => {
  const now = new Date("2026-01-01T10:00:00.000Z");
  for (const reply of [
    "Call me later please.",
    "Abhi busy hoon, baad mein call karna.",
    "Can you call me tomorrow?",
    "Thodi der baad call karna.",
  ]) {
    const outcome = classify([agent(GATE), caller(reply)]);
    assert.equal(outcome.outcomeType, "callback_requested", `"${reply}" must read as a callback`);
    const disposition = dispositionFor({ outcomeType: outcome.outcomeType, failureClass: "COMPLETED" });
    assert.equal(disposition.disposition, "RETRYABLE", `"${reply}" must never be a refusal`);

    const decision = planRetry("COMPLETED", 1, config.retry, now, {
      campaignType: "registration",
      disposition: disposition.disposition,
      outcomeType: outcome.outcomeType,
    });
    assert.equal(decision.retry, true);
    assert.equal(
      decision.nextAttemptAfter?.getTime() ?? 0,
      now.getTime() + config.retry.callbackDelayMinutes * 60_000,
      "the configured callback wait is used, unchanged",
    );
  }
});

// ═════════════════════════════════════════════════════════════════
section("I. AN INTERRUPTED CONVERSATION IS NOT A DECISION");

await test("I. a call that drops while the person is asking stays open", () => {
  const outcome = classify([agent(GATE), caller("Actually I wanted to ask—")]);

  assert.notEqual(outcome.outcomeType, "registered_confirmed");
  assert.notEqual(outcome.outcomeType, "declined");
  assert.equal(outcome.succeeded, null);
  assert.equal(outcome.detail.conversation?.endedOnCustomerQuestion, true);
  assert.equal(outcome.detail.conversation?.unfinishedTurns, 1);
  assert.ok(/interrupted/i.test(outcome.detail.explanation), "the row must say the call was interrupted");

  const { disposition, decision } = settle(outcome);
  assert.equal(disposition, "UNRESOLVED");
  assert.equal(decision.retry, true);
});

await test('I2. "Yes, I am interested, but I wanted to know—" is not a registration', () => {
  const outcome = classify([agent(GATE), caller("Yes, I am interested, but I wanted to know—")]);

  assert.notEqual(
    outcome.outcomeType,
    "registered_confirmed",
    "an interrupted sentence must not close a contact as registered",
  );
  assert.notEqual(outcome.succeeded, true);
  assert.equal(outcome.detail.conversation?.endedOnCustomerQuestion, true);
  const { disposition, decision } = settle(outcome);
  assert.notEqual(disposition, "FINAL_YES");
  assert.equal(decision.retry, true, "the person was mid-sentence — we still owe them the call");
});

await test("I3. an answered question is not an interrupted call", () => {
  const events = summariseConversation([
    agent(GATE),
    caller("Is it free?"),
    agent("Yes, the registration is completely free."),
  ]);
  assert.equal(events.customerQuestions, 1);
  assert.equal(
    events.endedOnCustomerQuestion,
    false,
    "the agent's reply is the proof that the question was handled",
  );
});

// ═════════════════════════════════════════════════════════════════
section("J. THE SCRIPT IS NOT RESTARTED AFTER A QUESTION");

await test("J. resuming after an answer is clean; re-introducing yourself is not", () => {
  const resumed = checkScriptAdherence({
    scriptText: SCRIPT_TEXT,
    transcript: [
      agent(GREETING),
      agent(PERMISSION),
      caller("What is this about?"),
      agent("A live reveal of the Funnel Builder Agent, building a funnel, pages and checkout from commands."),
      agent(GATE),
      caller("Yes, please reserve it."),
    ],
  });
  assert.equal(resumed.restartedScript, false);
  assert.equal(resumed.clean, true);

  const restarted = checkScriptAdherence({
    scriptText: SCRIPT_TEXT,
    transcript: [
      agent(GREETING),
      agent(PERMISSION),
      caller("What is this about?"),
      agent(`${GREETING} Actually, I'm calling you with a very interesting invitation.`),
    ],
  });
  assert.equal(restarted.restartedScript, true, "the greeting spoken twice is a restart");
  assert.equal(restarted.clean, false);
});

// ═════════════════════════════════════════════════════════════════
section("K. NO QUESTION THE SCRIPT DOES NOT ASK");

await test("K. invented qualification questions are caught; approved ones are not", () => {
  const invented = checkScriptAdherence({
    scriptText: SCRIPT_TEXT,
    transcript: [
      agent(GREETING),
      agent("What kind of business do you have?"),
      caller("I run a small coaching business."),
      agent("What tools do you currently use?"),
      caller("Mostly spreadsheets."),
      agent("And what is your monthly revenue?"),
    ],
  });
  assert.equal(
    invented.offScriptQuestions.length,
    3,
    `every invented question must be reported, saw ${JSON.stringify(invented.offScriptQuestions)}`,
  );
  assert.equal(invented.clean, false);

  const faithful = checkScriptAdherence({
    scriptText: SCRIPT_TEXT,
    transcript: [
      agent(GREETING),
      agent(PERMISSION),
      caller("Sure."),
      agent(PITCH),
      agent(GATE),
      caller("Yes, please reserve it."),
      agent("Perfect! Can I count on you to attend live?"),
      caller("Yes, I will attend."),
    ],
  });
  assert.deepEqual(
    faithful.offScriptQuestions,
    [],
    "the script's own questions must never be flagged as off-script",
  );
  assert.equal(faithful.repeatedScriptLines, 0, "no approved line was delivered twice");
  assert.equal(faithful.clean, true);
});

await test("K2. the classifier attaches the adherence report to the row it writes", () => {
  const outcome = classify([agent(GREETING), agent("What is your monthly revenue?"), caller("Why?")]);
  assert.ok(outcome.detail.adherence, "the report must be stored with the outcome");
  assert.equal(outcome.detail.adherence.offScriptQuestions.length, 1);

  // And with no script supplied, the label is identical and the report absent.
  const withoutScript = classifyOutcome({
    campaignType: "registration",
    status: "COMPLETED",
    failureClass: "COMPLETED",
    answered: true,
    transcript: [agent(GATE), caller("Yes, please reserve it.")],
  });
  assert.equal(withoutScript.detail.adherence, undefined);
  assert.equal(withoutScript.outcomeType, "registered_confirmed", "adherence never changes an outcome");
});

// ═════════════════════════════════════════════════════════════════
// L needs the database.

if (!process.env["DATABASE_URL"]) {
  console.log("\n[SKIP] DATABASE_URL is not set — the analytics section was skipped.");
} else {
  const campaignId = randomUUID();

  try {
    section("L. ANALYTICS: QUESTIONS DO NOT INFLATE CONVERSION");

    await test("L. conversion counts one contact once, however many times it was called", async () => {
      await query(
        `INSERT INTO campaigns (id, name, campaign_type, status, script_id, script_version, script_hash,
                                provider_allocation, telephony_provider, language, idempotency_key, dispatch_config)
         VALUES ($1, '__phase7b__', 'registration', 'READY', 'registration', 'v1', $2,
                 '{"cartesia":100}'::jsonb, 'vobiz', 'en', $3, '{"agent":{"gender":"female"}}'::jsonb)`,
        [campaignId, hashScript(registrationScript), `phase7b-${campaignId}`],
      );

      // One person. Two calls: the first was a question-led conversation
      // that decided nothing, the second was the registration.
      const contact = await query<{ id: string }>(
        `INSERT INTO contacts (campaign_id, name, normalized_phone, original_phone, assigned_provider,
                               csv_row_number, status, attempt_count, final_disposition, last_outcome_type,
                               closure_reason, closed_at)
         VALUES ($1, 'Priya', '+919811100001', '+919811100001', 'cartesia', 1, 'COMPLETED', 2,
                 'FINAL_YES', 'registered_confirmed', 'registration confirmed at the commitment question', now())
         RETURNING id`,
        [campaignId],
      );
      const contactId = contact.rows[0]!.id;

      const attemptIds: string[] = [];
      for (const attemptNumber of [1, 2]) {
        const attempt = await query<{ id: string }>(
          `INSERT INTO call_attempts (campaign_id, contact_id, attempt_number, provider, telephony_provider,
                                      status, dialed_at, answered_at, ended_at, failure_class)
           VALUES ($1, $2, $3, 'cartesia', 'vobiz', 'COMPLETED', now(), now(), now(), 'COMPLETED')
           RETURNING id`,
          [campaignId, contactId, attemptNumber],
        );
        attemptIds.push(attempt.rows[0]!.id);
      }

      // The two outcome rows are produced by the REAL classifier, not
      // hand-written. That is the point of doing it this way: it proves
      // the analytics query reads the shape the classifier actually
      // stores, rather than a shape the test invented.
      //
      // Attempt 1: three questions, one objection, cut off mid-question,
      // and an agent that drifted off script — a restart, an invented
      // question and an invented price.
      const questionLed = classify([
        agent(GREETING),
        agent(PERMISSION),
        caller("What is this event about?"),
        agent("It's a live reveal of the Funnel Builder Agent."),
        caller("Is it free?"),
        agent("Yes, completely free. It's ₹4,999 after that."),
        agent("What is your monthly revenue?"),
        caller("Send me the details and I'll decide."),
        agent(`${GREETING} Actually, I'm calling you with a very interesting invitation.`),
        caller("Wait, how long is it—"),
      ]);
      // The undecided call must be undecided before it is counted.
      assert.equal(questionLed.succeeded, null);
      assert.equal(questionLed.detail.conversation?.customerQuestions, 3);
      assert.equal(questionLed.detail.conversation?.objections, 1);
      assert.equal(questionLed.detail.conversation?.endedOnCustomerQuestion, true);
      assert.equal(questionLed.detail.adherence?.restartedScript, true);
      assert.equal(questionLed.detail.adherence?.offScriptQuestions.length, 1);
      assert.equal(questionLed.detail.adherence?.unsupportedFigures.length, 1);

      // Attempt 2: the registration.
      const registered = classify([agent(PITCH), agent(GATE), caller("Yes, please reserve my seat.")]);
      assert.equal(registered.outcomeType, "registered_confirmed");

      for (const [index, outcome] of [questionLed, registered].entries()) {
        await query(
          `INSERT INTO call_outcomes (call_attempt_id, campaign_id, outcome_type, schema_version, succeeded,
                                      primary_reason, classifier, detail)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
          [
            attemptIds[index],
            campaignId,
            outcome.outcomeType,
            outcome.schemaVersion,
            outcome.succeeded,
            outcome.primaryReason,
            outcome.classifier,
            JSON.stringify(outcome.detail),
          ],
        );
      }

      const results = await buildCampaignResults(campaignId);
      assert.ok(results);
      const { contactOutcomes, conversation } = results;

      assert.equal(contactOutcomes.total, 1, "one person");
      assert.equal(contactOutcomes.totalAttempts, 2, "two calls");
      assert.equal(contactOutcomes.conversionRate.denominator, 1, "the denominator is PEOPLE");
      assert.equal(contactOutcomes.conversionRate.numerator, 1);
      assert.equal(contactOutcomes.conversionRate.value, 1);
      assert.equal(
        results.funnel.attempts,
        2,
        "the attempt-level view still sees both calls, and stays separate",
      );

      // The question-led attempt is visible, and nowhere near the numerator.
      assert.equal(conversation.attemptsWithQuestions, 1);
      assert.equal(conversation.customerQuestions, 3);
      assert.equal(conversation.attemptsWithObjections, 1);
      assert.equal(conversation.interruptedOnQuestion, 1);
      assert.equal(conversation.adherence.attemptsChecked, 2);
      assert.equal(conversation.adherence.scriptRestarts, 1);
      assert.equal(conversation.adherence.offScriptQuestionAttempts, 1);
      assert.equal(conversation.adherence.unsupportedFigureAttempts, 1);
      assert.ok(/FINAL_YES/.test(conversation.registrationNote));
    });

    await test("L2. the report says out loud that a question is not a verdict", async () => {
      const results = await buildCampaignResults(campaignId);
      assert.ok(results);
      const warnings = results.dataHealth.warnings;
      assert.ok(
        warnings.some((warning) => /question is not a registration and not a refusal/i.test(warning)),
        "the report must state that questions are not verdicts",
      );
      assert.ok(
        warnings.some((warning) => /still asking something/i.test(warning)),
        "the report must flag the interrupted call as undecided rather than lost",
      );
      assert.ok(
        warnings.some((warning) => /Script adherence/i.test(warning)),
        "off-script behaviour must be reported, with its own caveat",
      );
      assert.ok(
        warnings.some((warning) => /counts the same person more than once/i.test(warning)),
        "the attempt-vs-contact warning must survive",
      );
    });
  } finally {
    await query("DELETE FROM campaigns WHERE id = $1", [campaignId]);
    await closeDbPool();
  }
}

// ─────────────────────────────────────────────────────────────────
console.log(`\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`);
console.log("No telephony, TTS, STT or LLM request was made. No call was placed.");
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
