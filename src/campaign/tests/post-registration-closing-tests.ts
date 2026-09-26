/**
 * post-registration-closing-tests.ts — `npm run test:post-registration-closing`
 *
 * ISSUE: THE CALL IS DROPPED THE MOMENT THE REGISTRATION IS CONFIRMED.
 *
 *   agent    "Would you like me to reserve your free seat?"
 *   caller   "Yes, please."
 *   agent    "Perfect, your seat is reserved. Hope to see you there!"
 *   -> line dropped on the next 500ms watchdog tick
 *
 * The person never got to say "okay, thank you", and every registration
 * ended like a dropped call. The desired shape:
 *
 *   REGISTRATION CONFIRMED -> confirmation spoken -> WAIT for the person
 *   -> they close ("okay, thank you") -> ONE short goodbye -> hang up
 *
 * THE FIX IS IN TWO PLACES AND NOWHERE ELSE:
 *
 *   1. `call-runner.ts` — the watchdog reads `liveRegistrationReading`,
 *      which adds `awaitingClosingResponse` beside the unchanged
 *      `definitiveAnswerIn` verdict: FINAL_YES, the confirmation has
 *      been spoken, and the person has not said a word since. The
 *      hangup is HELD while that is true, bounded by the new
 *      `closingWaitSeconds`, and fires — still named
 *      `agent_hangup:final_yes` — once the person has taken their turn
 *      and the agent has answered it, or the bound expires.
 *   2. `conversation-pipeline.ts` — `armScriptedClosing`, called by the
 *      watchdog the moment the classifier reads a confirmed
 *      registration, makes the pipeline answer a BARE closing
 *      acknowledgement with one fixed goodbye and no language-model
 *      request. Anything with content takes the contextual path.
 *
 * NOT TOUCHED: `classifyOutcome`, `dispositionFor`, `isFinalYes`, the
 * gate, the anchors, the sheet writer, `definitiveAnswerIn`'s verdict.
 *
 * SECTIONS
 *   A  the live reading — held after the confirmation, released by the
 *      person's word, never by the agent's; every other verdict unchanged
 *   B  the closing vocabulary boundary — what is a pleasantry and what
 *      is not
 *   C  the pipeline — the fixed goodbye, once, without the language
 *      model; questions still go to the model; unarmed is unchanged
 *   D  the live watchdog through the real `runCall`: the full exchange,
 *      the bounded wait, a question first, a refusal unchanged, and the
 *      registration persisted exactly once
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
const { runCall, definitiveAnswerIn, liveRegistrationReading, agentClosedIn } = await import("../dispatch/call-runner");
const { classifyOutcome } = await import("../outcome/classifier");
const { dispositionFor } = await import("../outcome/disposition");
const { isFinalYes } = await import("../integrations/final-yes-sheet");
const { SessionObserver } = await import("../dispatch/session-observer");
const { findScript, hashScript } = await import("../script/script-registry");
const { claimContacts } = await import("../db/repositories/call-attempt.repo");
const { getCampaign } = await import("../db/repositories/campaign.repo");
const { query, closeDbPool } = await import("../db/client");
const { ConversationPipeline, isClosingAcknowledgement } = await import("../../core/session/conversation-pipeline");
const { SessionRecord } = await import("../../core/session/session-record");
const { SessionState, SupportedLanguage, CallDirection, ProviderCategory } = await import("../../types/enums");
type SessionStateValue = (typeof SessionState)[keyof typeof SessionState];

import type { AudioPayload, ConversationTurn, TranscriptSegment } from "../../types/provider.types";
import type { CompletionRequest } from "../../interfaces/providers/language-model-provider.interface";
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
      `         ${(error instanceof Error ? error.message : String(error)).split("\n").slice(0, 5).join("\n         ")}`,
    );
  }
}

const section = (t: string) => console.log(`\n${t}`);
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const turn = (role: "assistant" | "user", text: string): ConversationTurn => ({ role, content: text, timestamp: new Date() });
const agent = (text: string) => turn("assistant", text);
const caller = (text: string) => turn("user", text);

const GREETING = "Hi Priya, this is Ishita from Team FlexiFunnels.";
const GATE = "So Priya, would you like me to reserve your free seat?";
const CONFIRMED = "Perfect, I'll get your free seat reserved. Hope to see you there!";
const GOODBYE = "Thank you. Have a great day. Bye!";
const ANSWER = "It runs ten to twelve in the morning and one to three in the afternoon, both days.";
const REFUSAL_CLOSE = "No problem at all. Thanks for your time. Have a great day!";

const live = (turns: readonly ConversationTurn[]) => liveRegistrationReading(turns, "registration");

function settled(turns: readonly ConversationTurn[]) {
  const stored = turns.map((t) => ({ role: t.role as "user" | "assistant", text: t.content, at: null }));
  const classification = classifyOutcome({
    campaignType: "registration",
    status: "COMPLETED",
    failureClass: "COMPLETED",
    answered: true,
    transcript: stored,
  });
  const { disposition } = dispositionFor({ outcomeType: classification.outcomeType, failureClass: "COMPLETED" });
  return { classification, disposition, sheet: isFinalYes(classification, disposition) };
}

// ═════════════════════════════════════════════════════════════════
section("A. THE LIVE READING — HELD AFTER THE CONFIRMATION, RELEASED BY THE PERSON");

await test("A1. the confirmation has been spoken and the person has not answered: FINAL_YES is read but the closing response is awaited", () => {
  const reading = live([agent(GREETING), agent(GATE), caller("Yes, please."), agent(CONFIRMED)]);
  assert.equal(reading.verdict, "FINAL_YES", "the verdict is unchanged");
  assert.equal(reading.registrationConfirmed, true);
  assert.equal(reading.awaitingClosingResponse, true, "the watchdog must hold here");
  // ...and `definitiveAnswerIn` is byte-for-byte what it was.
  assert.equal(definitiveAnswerIn([agent(GREETING), agent(GATE), caller("Yes, please."), agent(CONFIRMED)], "registration"), "FINAL_YES");
});

await test("A2. the registration is read as confirmed from the person's yes, before the agent has replied", () => {
  const reading = live([agent(GREETING), agent(GATE), caller("Yes, please.")]);
  assert.equal(reading.registrationConfirmed, true, "this is what arms the pipeline's goodbye early");
  assert.equal(reading.verdict, undefined, "...but nothing is acted on until the agent has replied");
  assert.equal(reading.awaitingClosingResponse, false);
});

await test("A3. the person's closing word, answered by the goodbye, releases the hangup", () => {
  for (const closing of ["Okay, thank you.", "Great.", "Okay.", "Theek hai, dhanyavaad.", "Thanks, bye."]) {
    const reading = live([agent(GREETING), agent(GATE), caller("Yes, please."), agent(CONFIRMED), caller(closing), agent(GOODBYE)]);
    assert.equal(reading.verdict, "FINAL_YES", `"${closing}" then the goodbye must end as FINAL_YES`);
    assert.equal(reading.awaitingClosingResponse, false, `"${closing}" is the person's response`);
  }
});

await test("A4. ...and while the goodbye is still being spoken nothing fires", () => {
  const reading = live([agent(GREETING), agent(GATE), caller("Yes, please."), agent(CONFIRMED), caller("Okay, thank you.")]);
  assert.equal(reading.verdict, undefined, "the last turn is the person's");
  assert.equal(reading.awaitingClosingResponse, false);
});

await test("A5. the AGENT cannot release the hold on the person's behalf", () => {
  // A second agent turn after the confirmation — a check-in, a
  // sign-off — is still the agent talking. Only the person's word counts.
  const reading = live([agent(GREETING), agent(GATE), caller("Yes, please."), agent(CONFIRMED), agent("Take care, Priya.")]);
  assert.equal(reading.verdict, "FINAL_YES");
  assert.equal(reading.awaitingClosingResponse, true, "two agent turns in a row are still an unanswered confirmation");
});

await test("A6. a question after the confirmation is held by the EXISTING guard, and the person's closing then releases it", () => {
  const asked = [agent(GREETING), agent(GATE), caller("Yes, please."), agent(CONFIRMED), caller("What time does it start?"), agent(ANSWER)];
  const reading = live(asked);
  assert.equal(reading.verdict, undefined, "callerQuestionPending still withholds the hangup");
  assert.equal(reading.awaitingClosingResponse, false, "the person HAS responded — this is the question guard, not the closing wait");
  const closed = live([...asked, caller("Okay, thank you."), agent(GOODBYE)]);
  assert.equal(closed.verdict, "FINAL_YES");
  assert.equal(closed.awaitingClosingResponse, false);
});

await test("A7. a retraction after the confirmation still flips the verdict — nothing about the classifier moved", () => {
  const reading = live([agent(GREETING), agent(GATE), caller("Yes, please."), agent(CONFIRMED), caller("Sorry, I am not interested after all."), agent(REFUSAL_CLOSE)]);
  assert.equal(reading.verdict, "FINAL_NO");
  assert.equal(reading.registrationConfirmed, false);
  assert.equal(reading.awaitingClosingResponse, false);
  assert.equal(settled([agent(GATE), caller("Yes, please."), agent(CONFIRMED), caller("Sorry, I am not interested after all."), agent(REFUSAL_CLOSE)]).sheet, false);
});

await test("A8. every non-registration ending is untouched: FINAL_NO, undecided, empty", () => {
  const refused = live([agent(GREETING), agent(GATE), caller("No, not interested."), agent(REFUSAL_CLOSE)]);
  assert.equal(refused.verdict, "FINAL_NO");
  assert.equal(refused.awaitingClosingResponse, false, "the closing wait exists for a registration only");
  assert.equal(refused.registrationConfirmed, false);

  const undecided = live([agent(GREETING), agent(GATE), caller("Let me think about it."), agent("Sure, take your time.")]);
  assert.equal(undecided.verdict, undefined);
  assert.equal(undecided.awaitingClosingResponse, false);

  assert.deepEqual(live([]), { verdict: undefined, registrationConfirmed: false, awaitingClosingResponse: false, closingDelivered: false });
  assert.deepEqual(live([agent(GREETING)]), { verdict: undefined, registrationConfirmed: false, awaitingClosingResponse: false, closingDelivered: false });
});

await test("A10. `closingDelivered`: true only when the agent's LATEST turn is a delivered sign-off", () => {
  const base = [agent(GREETING), agent(GATE), caller("Yes, please."), agent(CONFIRMED)];
  // The confirmation itself is not a closing — it is what the person is owed a chance to answer.
  assert.equal(live(base).closingDelivered, false);
  // The person spoke, the agent replied with something that is NOT a goodbye: the line must stay up.
  // Real call 2026-09-21 15:39: "Uh, 2 minutes, 2 minutes." → "Sure, no problem, take your time." → hung up.
  const granted = live([...base, caller("Uh, 2 minutes, 2 minutes."), agent("Sure, no problem, take your time.")]);
  assert.equal(granted.verdict, "FINAL_YES", "the verdict is unchanged — only WHEN the hangup fires moves");
  assert.equal(granted.awaitingClosingResponse, false, "the person has responded");
  assert.equal(granted.closingDelivered, false, "...but the agent has not said goodbye, so the watchdog must still hold");
  // The fixed goodbye, and an ordinary short sign-off, are closings.
  assert.equal(live([...base, caller("Okay, bye."), agent(GOODBYE)]).closingDelivered, true);
  assert.equal(live([...base, caller("Okay, thanks."), agent("Thanks for your time, Priya. Have a great day!")]).closingDelivered, true);
  // A closing that asks a question is a handover, not an ending.
  assert.equal(live([...base, caller("Okay."), agent("Take care — anything else before I go?")]).closingDelivered, false);
  // While the person is speaking (live partial appended last), nothing is delivered.
  assert.equal(live([...base, caller("Okay, bye."), agent(GOODBYE), caller("Bye")]).closingDelivered, false);
});

await test("A9. the hangup and the sheet still cannot disagree", () => {
  const turns = [agent(GREETING), agent(GATE), caller("Haan ji, kar dijiye."), agent(CONFIRMED), caller("Theek hai, shukriya."), agent(GOODBYE)];
  assert.equal(live(turns).verdict, "FINAL_YES");
  const { sheet, classification } = settled(turns);
  assert.equal(sheet, true, "one registration, one row");
  assert.equal(classification.primaryReason, "confirmed_at_gate");
  // The courtesy "theek hai" after the confirmation is not a second registration.
  const gateTurns = new Set(
    classification.detail.signals.filter((s) => s.kind === "affirmation" && s.atGate && s.decisive !== false).map((s) => s.turnIndex),
  );
  assert.equal(gateTurns.size, 1, "exactly one at-gate turn — the closing word is not one");
  assert.ok(gateTurns.has(2), "and it is the yes at the gate");
});

// ═════════════════════════════════════════════════════════════════
section("B. THE CLOSING VOCABULARY BOUNDARY");

await test("B1. a bare closing pleasantry is recognised, in English, Hinglish and Devanagari", () => {
  for (const line of [
    "Okay, thank you.", "Okay thank you", "Great.", "Okay.", "Thank you. Have a great day. Bye!",
    "Thanks a lot, bye.", "Perfect, thank you so much.", "Alright, thanks.", "Sure, thank you ji.",
    "Theek hai, dhanyavaad.", "Achha, shukriya.", "Haan ji, theek hai. Bye.", "Chalo, theek hai.",
    "ठीक है, धन्यवाद।", "अच्छा, शुक्रिया।", "बहुत बढ़िया, धन्यवाद जी।",
    "Great, see you there.", "Okay bye.", "Done, thanks.",
  ]) {
    assert.equal(isClosingAcknowledgement(line), true, `must close on: "${line}"`);
  }
});

await test("B2. anything with content of its own is NOT a closing — it belongs to the language model", () => {
  for (const line of [
    "What time does it start?", "Okay, and what about the link?", "Thank you, but I have a question.",
    "Okay, is it free?", "Great, how do I join?", "Thanks. Will I get a recording?",
    "Okay, please send the details on WhatsApp.", "Theek hai, link kab milega?",
    "Thank you, I want to register my brother as well.",
  ]) {
    assert.equal(isClosingAcknowledgement(line), false, `must NOT close on: "${line}"`);
  }
});

await test("B3. no negation is ever a closing — a refusal or a retraction must reach the model", () => {
  for (const line of ["No, thank you.", "No thanks.", "Nahi, thank you.", "Cancel it.", "No, that's all.", "Nahi chahiye, bye.", "Not interested, bye."]) {
    assert.equal(isClosingAcknowledgement(line), false, `must NOT close on: "${line}"`);
  }
});

await test("B4. a long sentence is not a pleasantry, and a question mark is disqualifying", () => {
  assert.equal(isClosingAcknowledgement("Okay thank you so much for calling me today about this and telling me everything."), false);
  assert.equal(isClosingAcknowledgement("Okay, thank you?"), false);
  assert.equal(isClosingAcknowledgement(""), false);
});

// ═════════════════════════════════════════════════════════════════
section("C. THE PIPELINE — ONE FIXED GOODBYE, WITHOUT THE LANGUAGE MODEL");

const CHARS_PER_SECOND = 22;
function clipFor(text: string): AudioPayload {
  const seconds = Math.max(0.05, text.length / CHARS_PER_SECOND);
  return { data: new Uint8Array(Math.round(seconds * 8000)), encoding: "MULAW", sampleRateHz: 8000 };
}
function descriptor(category: (typeof ProviderCategory)[keyof typeof ProviderCategory], id: string) {
  return { category, id, displayName: id, supportedLanguages: [SupportedLanguage.ENGLISH, SupportedLanguage.HINGLISH], version: "fake" };
}
const healthy = (identifier: { category: unknown; id: string }) => ({ identifier, isHealthy: true, checkedAt: new Date() });
const sleep = wait;

interface Harness {
  readonly pipeline: InstanceType<typeof ConversationPipeline>;
  readonly record: InstanceType<typeof SessionRecord>;
  readonly requests: Array<readonly ConversationTurn[]>;
  readonly synthesized: string[];
  say(text: string): void;
  waitForReplies(n: number, timeoutMs?: number): Promise<void>;
  history(): readonly ConversationTurn[];
  stop(): Promise<void>;
}

function startHarness(input: { readonly replies: readonly string[] }): Harness {
  const requests: Array<readonly ConversationTurn[]> = [];
  const synthesized: string[] = [];
  const segments: TranscriptSegment[] = [];
  const waiters: Array<() => void> = [];
  let closed = false;
  let clockMs = 0;
  let replyIndex = 0;

  const stt = {
    descriptor: descriptor(ProviderCategory.SPEECH_TO_TEXT, "fake-stt"),
    transcribe: async () => [],
    checkHealth: async () => healthy(descriptor(ProviderCategory.SPEECH_TO_TEXT, "fake-stt")),
    transcribeStream: async function* (): AsyncIterable<TranscriptSegment> {
      while (!closed) {
        const next = segments.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
  };
  const llm = {
    descriptor: descriptor(ProviderCategory.LANGUAGE_MODEL, "fake-llm"),
    generateCompletion: async (request: CompletionRequest) => {
      requests.push(request.history);
      return { turn: { role: "assistant" as const, content: "", timestamp: new Date() }, latencyMs: 0 };
    },
    checkHealth: async () => healthy(descriptor(ProviderCategory.LANGUAGE_MODEL, "fake-llm")),
    generateCompletionStream: async function* (request: CompletionRequest, signal?: AbortSignal) {
      if (request.history.length === 1 && request.history[0]?.role === "system") {
        yield { type: "token" as const, delta: "", index: 0 };
        return;
      }
      requests.push(request.history);
      const reply = input.replies[replyIndex] ?? "Okay.";
      replyIndex += 1;
      await sleep(10);
      if (signal?.aborted) return;
      for (const delta of reply.split(/(?<=\s)/u)) {
        if (signal?.aborted) return;
        yield { type: "token" as const, delta, index: 0 };
      }
      yield { type: "final" as const, turn: { role: "assistant" as const, content: reply, timestamp: new Date() }, latencyMs: 1 };
    },
  };
  const tts = {
    descriptor: descriptor(ProviderCategory.TEXT_TO_SPEECH, "fake-tts"),
    synthesize: async (task: { request: { text: string } }) => {
      synthesized.push(task.request.text);
      return clipFor(task.request.text);
    },
    checkHealth: async () => healthy(descriptor(ProviderCategory.TEXT_TO_SPEECH, "fake-tts")),
  };
  const telephony = {
    descriptor: descriptor(ProviderCategory.TELEPHONY, "fake-telephony"),
    startCall: async () => ({ providerCallId: "fake", startedAt: new Date() }),
    endCall: async () => undefined,
    checkHealth: async () => healthy(descriptor(ProviderCategory.TELEPHONY, "fake-telephony")),
  };
  const stack = {
    telephony: { category: ProviderCategory.TELEPHONY, id: "fake-telephony" },
    speechToText: { category: ProviderCategory.SPEECH_TO_TEXT, id: "fake-stt" },
    languageModel: { category: ProviderCategory.LANGUAGE_MODEL, id: "fake-llm" },
    textToSpeech: { category: ProviderCategory.TEXT_TO_SPEECH, id: "fake-tts" },
  };
  const record = new SessionRecord(
    "closing-test" as SessionId,
    {
      language: SupportedLanguage.ENGLISH,
      direction: CallDirection.OUTBOUND,
      providerStack: stack,
      destinationNumber: "+910000000000",
      campaign: {
        campaignId: "test", campaignType: "registration", scriptId: "test", scriptVersion: "v1", scriptHash: "test",
        agent: { gender: "male", name: "Rohan" }, customer: { name: "Sakshi" },
        openingLine: GREETING, systemPromptAppendix: "TEST APPENDIX",
      },
    },
    stack,
  );
  record.loopAbortController = new AbortController();
  record.state = SessionState.CALLING;
  record.outboundAudioListeners.add(() => undefined);
  const host = {
    transition: (r: InstanceType<typeof SessionRecord>, to: (typeof SessionState)[keyof typeof SessionState]) => {
      r.state = to;
    },
    markError: () => undefined,
  };
  const pipeline = new ConversationPipeline(record, { telephony, stt, llm, tts } as never, host as never);
  const loop = pipeline.run();

  return {
    pipeline,
    record,
    requests,
    synthesized,
    say(text) {
      const startedAtMs = clockMs;
      clockMs += Math.max(200, (text.length / CHARS_PER_SECOND) * 1000);
      segments.push({ text, isFinal: true, isSpeechFinal: true, confidence: 0.95, language: SupportedLanguage.ENGLISH, startedAtMs, endedAtMs: clockMs });
      waiters.shift()?.();
    },
    async waitForReplies(n, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const replies = record.memory.history().filter((t) => t.role === "assistant").length;
        if (replies >= n && record.state === SessionState.LISTENING) return;
        await sleep(20);
      }
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${n} replies`);
    },
    history() {
      return record.memory.history().filter((t) => t.role !== "system");
    },
    async stop() {
      closed = true;
      for (const waiter of waiters.splice(0)) waiter();
      record.loopAbortController?.abort();
      await Promise.race([loop, sleep(500)]).catch(() => undefined);
    },
  };
}

const assistantTexts = (h: Harness) => h.history().filter((t) => t.role === "assistant").map((t) => t.content);

await test("C1. armed, a bare 'Okay, thank you.' is answered with the fixed goodbye and NO language-model request", async () => {
  // Greeting, then the model asks the gate, then confirms the yes — so
  // the history the campaign layer reads afterwards is a real
  // registration, and the released hangup can be asserted on it.
  const h = startHarness({ replies: [GATE, CONFIRMED] });
  try {
    await h.waitForReplies(1);
    h.say("Yes, tell me.");
    await h.waitForReplies(2);
    h.say("Yes, please.");
    await h.waitForReplies(3);
    assert.equal(h.requests.length, 2, "both caller turns went to the model");
    assert.equal(liveRegistrationReading(h.history(), "registration").awaitingClosingResponse, true, "the watchdog would be holding here");
    // ...and would have armed the closing on reading the yes.
    h.pipeline.armScriptedClosing();
    h.say("Okay, thank you.");
    await h.waitForReplies(4);
    assert.equal(h.requests.length, 2, "the closing word made NO language-model request");
    const texts = assistantTexts(h);
    assert.equal(texts[3], GOODBYE, "the fixed goodbye, committed as the agent's turn");
    // Spoken through the same speech formatter every reply goes through.
    assert.ok(h.synthesized.some((t) => t.includes("Have a great day")), `...and actually spoken: ${JSON.stringify(h.synthesized)}`);
    assert.ok(!texts[3]!.includes("?"), "the goodbye asks nothing");
    assert.equal(agentClosedIn(h.history()), true, "it reads as a closing to the campaign layer too");
    assert.equal(definitiveAnswerIn(h.history(), "registration"), "FINAL_YES", "and the hangup is released");
    assert.equal(liveRegistrationReading(h.history(), "registration").awaitingClosingResponse, false);
  } finally {
    await h.stop();
  }
});

for (const cue of ["Tell me, sir. Okay.", "हाँ जी।", "ओके।"]) {
  await test(`C1c. armed, a bare continuation cue ("${cue}") also gets the fixed goodbye — the confirmation is NOT said again (real call c343e150)`, async () => {
    const h = startHarness({ replies: [GATE, CONFIRMED, "SHOULD-NOT-BE-GENERATED"] });
    try {
      await h.waitForReplies(1);
      h.say("Yes, tell me.");
      await h.waitForReplies(2);
      h.say("Yes, please.");
      await h.waitForReplies(3);
      h.pipeline.armScriptedClosing();
      h.say(cue);
      await h.waitForReplies(4);
      assert.equal(h.requests.length, 2, "the cue made NO language-model request");
      assert.equal(assistantTexts(h)[3], GOODBYE, "the fixed goodbye, not a second confirmation");
      assert.ok(!h.synthesized.includes("SHOULD-NOT-BE-GENERATED"));
    } finally {
      await h.stop();
    }
  });
}

await test("C2. a QUESTION after arming still goes to the language model; the closing comes after its answer", async () => {
  const h = startHarness({ replies: [GATE, CONFIRMED, ANSWER] });
  try {
    await h.waitForReplies(1);
    h.say("Yes, tell me.");
    await h.waitForReplies(2);
    h.say("Yes, please.");
    await h.waitForReplies(3);
    h.pipeline.armScriptedClosing();
    h.say("What time does it start?");
    await h.waitForReplies(4);
    assert.equal(h.requests.length, 3, "the question reached the model");
    assert.equal(assistantTexts(h)[3], ANSWER);
    assert.equal(definitiveAnswerIn(h.history(), "registration"), undefined, "the question guard still holds the hangup");
    h.say("Great, thanks.");
    await h.waitForReplies(5);
    assert.equal(h.requests.length, 3, "the closing word made no request");
    assert.equal(assistantTexts(h)[4], GOODBYE);
    assert.equal(definitiveAnswerIn(h.history(), "registration"), "FINAL_YES");
  } finally {
    await h.stop();
  }
});

await test("C3. UNARMED, the same 'Okay, thank you.' takes the contextual path exactly as before", async () => {
  const h = startHarness({ replies: [CONFIRMED, "You're welcome! Take care."] });
  try {
    await h.waitForReplies(1);
    h.say("Yes, please.");
    await h.waitForReplies(2);
    h.say("Okay, thank you.");
    await h.waitForReplies(3);
    assert.equal(h.requests.length, 2, "without arming, the model answers");
    assert.equal(assistantTexts(h)[2], "You're welcome! Take care.");
    assert.ok(!h.synthesized.includes(GOODBYE));
  } finally {
    await h.stop();
  }
});

await test("C4. the goodbye is spoken ONCE — a second pleasantry is not answered with a second goodbye", async () => {
  const h = startHarness({ replies: [CONFIRMED, "Bye!"] });
  try {
    await h.waitForReplies(1);
    h.say("Yes, please.");
    await h.waitForReplies(2);
    h.pipeline.armScriptedClosing();
    h.pipeline.armScriptedClosing(); // idempotent
    h.say("Okay, thank you.");
    await h.waitForReplies(3);
    h.say("Thanks again.");
    await h.waitForReplies(4);
    assert.equal(assistantTexts(h).filter((t) => t === GOODBYE).length, 1, "one goodbye per call");
    assert.equal(h.requests.length, 2, "the second pleasantry fell through to the model");
  } finally {
    await h.stop();
  }
});

await test("C5. a closing word said to the agent's QUESTION is an answer, not a goodbye", async () => {
  // The agent's confirmation happened to end on a question. "Okay" is
  // the answer to it and must reach the model, exactly as the campaign
  // layer already refuses to hang up while the agent's latest turn asks.
  const h = startHarness({ replies: ["Perfect, your seat is reserved. Shall I also note your email?", "Sure, noted."] });
  try {
    await h.waitForReplies(1);
    h.say("Yes, please.");
    await h.waitForReplies(2);
    h.pipeline.armScriptedClosing();
    h.say("Okay.");
    await h.waitForReplies(3);
    assert.equal(h.requests.length, 2, "the okay answered the question, through the model");
    assert.equal(assistantTexts(h)[2], "Sure, noted.");
  } finally {
    await h.stop();
  }
});

await test("C6. the pitch is never repeated and the gate is never re-asked by the closing", async () => {
  const h = startHarness({ replies: [CONFIRMED] });
  try {
    await h.waitForReplies(1);
    h.say("Yes, please.");
    await h.waitForReplies(2);
    h.pipeline.armScriptedClosing();
    h.say("Great.");
    await h.waitForReplies(3);
    const goodbye = assistantTexts(h)[2]!;
    assert.ok(!/reserve|seat|register|workshop|event|zoom/iu.test(goodbye), `no pitch, no gate: "${goodbye}"`);
    assert.equal(goodbye.split(/\s+/).length <= 12, true, "short");
  } finally {
    await h.stop();
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
  readonly drive: (session: ScriptedSession, armed: () => boolean) => Promise<void>;
}) {
  let listener: ((sessionId: string, transition: unknown) => void) | undefined;
  const sessionId = `closing-${randomUUID()}`;
  const transcript: ConversationTurn[] = [...input.transcriptSoFar];
  let state: SessionStateValue = SessionState.CALLING;
  let closed = false;

  const telemetry = {
    endCalls: 0,
    endedInState: undefined as SessionStateValue | undefined,
    endedAt: 0,
    confirmationCommittedAt: 0,
    goodbyeCommittedAt: 0,
    armCalls: 0,
    armedAt: 0,
    callerTurns: [] as string[],
    /** Whether the line was still up when the caller spoke after the confirmation. */
    upWhenCallerClosed: false,
  };

  function transition(to: SessionStateValue): void {
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
      if (text === CONFIRMED && telemetry.confirmationCommittedAt === 0) telemetry.confirmationCommittedAt = Date.now();
      if (text === GOODBYE) telemetry.goodbyeCommittedAt = Date.now();
      transition(SessionState.LISTENING);
    },
    say(text: string): void {
      if (closed) return;
      telemetry.callerTurns.push(text);
      if (telemetry.confirmationCommittedAt !== 0) telemetry.upWhenCallerClosed = true;
      transcript.push(caller(text));
    },
  };

  return {
    telemetry,
    createSession: async () => ({ id: sessionId }),
    warmUpProviders: async () => undefined,
    start: async () => {
      transition(SessionState.LISTENING);
      void input.drive(session, () => telemetry.armCalls > 0).catch(() => undefined);
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
    armScriptedClosing: () => {
      telemetry.armCalls += 1;
      if (telemetry.armedAt === 0) telemetry.armedAt = Date.now();
      return true;
    },
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
  console.log(`\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`);
  for (const name of failures) console.log(`  - ${name}`);
  console.log("No call was placed. Telephony, Deepgram, the LLM, the TTS vendors and Google were not contacted.");
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

/** Scaled down from the shipped windows; the clocks under test are the shipped ones. */
const WINDOW_SECONDS = 6;
const WINDOW_MS = WINDOW_SECONDS * 1000;
const CLOSING_WAIT_SECONDS = 2;
const CLOSING_WAIT_MS = CLOSING_WAIT_SECONDS * 1000;
/** Comfortably more than the 500ms watchdog tick, and well under the closing wait. */
const TICKS_MS = 1_200;

async function runScripted(input: {
  readonly transcriptSoFar: readonly ConversationTurn[];
  readonly drive: (session: ScriptedSession, armed: () => boolean) => Promise<void>;
}) {
  seedIndex += 1;
  const inserted = await query<{ id: string }>(
    `INSERT INTO contacts (campaign_id, name, normalized_phone, original_phone, assigned_provider, csv_row_number)
     VALUES ($1, 'Priya', $2, $2, 'cartesia', $3) RETURNING id`,
    [campaignId, `+9198115${String(80000 + seedIndex)}`, seedIndex],
  );
  const contactId = inserted.rows[0]!.id;
  const claimed = await claimContacts(campaignId, "cartesia" as never, 50, "post-registration-closing");
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
        closingWaitSeconds: CLOSING_WAIT_SECONDS,
      },
      campaign,
      script: registrationScript!,
    },
    Date.now(),
  );
  return { outcome, telemetry: manager.telemetry, contactId };
}

async function hangupReasonOf(attemptId: string): Promise<string | null> {
  const row = await query<{ hangup_reason: string | null }>("SELECT hangup_reason FROM call_attempts WHERE id = $1", [attemptId]);
  return row.rows[0]?.hangup_reason ?? null;
}

async function outcomesOf(attemptId: string): Promise<Array<{ reason: string | null; type: string | null }>> {
  const row = await query<{ primary_reason: string | null; outcome_type: string | null }>(
    "SELECT primary_reason, outcome_type FROM call_outcomes WHERE call_attempt_id = $1",
    [attemptId],
  );
  return row.rows.map((r) => ({ reason: r.primary_reason, type: r.outcome_type }));
}

try {
  await query(
    `INSERT INTO campaigns (id, name, campaign_type, status, script_id, script_version, script_hash,
                            provider_allocation, telephony_provider, language, idempotency_key, dispatch_config)
     VALUES ($1, '__post_registration_closing__', 'registration', 'READY', 'registration', 'v1', $2,
             '{"cartesia":100}'::jsonb, 'vobiz', 'en', $3, '{"agent":{"gender":"female"}}'::jsonb)`,
    [campaignId, hashScript(registrationScript!), `closing-${campaignId}`],
  );

  // ═══════════════════════════════════════════════════════════════
  section("D. THE LIVE WATCHDOG — THE FULL CLOSING EXCHANGE, END TO END");

  // The desired shape, driven through the real runner. The fake manager
  // plays the pipeline's part: once the watchdog has armed the closing
  // and the person has said "okay, thank you", it speaks the goodbye.
  const full = await runScripted({
    transcriptSoFar: [agent(GREETING), agent(GATE), caller("Yes, please.")],
    drive: async (s) => {
      await wait(300);
      s.beginReply();
      await wait(400);
      s.finishReply(CONFIRMED);
      // The gap the person used to be cut off in.
      await wait(TICKS_MS);
      s.say("Okay, thank you.");
      s.beginReply();
      await wait(400);
      s.finishReply(GOODBYE);
    },
  });

  await test("D1. the call is NOT ended on the tick after the confirmation — the person gets to speak", () => {
    assert.equal(full.telemetry.upWhenCallerClosed, true, "the line must still be up when the person says thank you");
    assert.deepEqual(full.telemetry.callerTurns, ["Okay, thank you."]);
    const heldForMs = full.telemetry.endedAt - full.telemetry.confirmationCommittedAt;
    assert.ok(heldForMs > TICKS_MS, `the line must survive the gap after the confirmation (${heldForMs}ms)`);
  });

  await test("D2. the pipeline was told to ready its goodbye — once, and before the confirmation had even been committed", () => {
    assert.equal(full.telemetry.armCalls, 1, "armed exactly once per call");
    assert.ok(
      full.telemetry.armedAt <= full.telemetry.confirmationCommittedAt,
      "armed from the person's yes, ahead of the agent's reply",
    );
  });

  await test("D3. the hangup comes AFTER the goodbye, promptly, and is still named agent_hangup:final_yes", async () => {
    assert.equal(full.outcome.failureClass, "COMPLETED");
    assert.equal(await hangupReasonOf(full.outcome.attemptId!), "agent_hangup:final_yes");
    assert.ok(full.telemetry.goodbyeCommittedAt > 0, "the goodbye was spoken");
    assert.ok(full.telemetry.endedAt >= full.telemetry.goodbyeCommittedAt, "never before the goodbye");
    const afterGoodbyeMs = full.telemetry.endedAt - full.telemetry.goodbyeCommittedAt;
    assert.ok(afterGoodbyeMs < CLOSING_WAIT_MS, `...and within a tick or two of it, not another wait later (${afterGoodbyeMs}ms)`);
    assert.notEqual(full.telemetry.endedInState, SessionState.SPEAKING, "never mid-goodbye");
  });

  await test("D4. the registration is persisted exactly once, as it always was", async () => {
    const stored = await outcomesOf(full.outcome.attemptId!);
    assert.equal(stored.length, 1, "one outcome row per attempt");
    assert.equal(stored[0]!.reason, "confirmed_at_gate");
    assert.equal(stored[0]!.type, "registered_confirmed");
    const contact = await query<{ final_disposition: string | null; status: string }>(
      "SELECT final_disposition, status::text AS status FROM contacts WHERE id = $1",
      [full.contactId],
    );
    assert.equal(contact.rows[0]?.final_disposition, "FINAL_YES", "the contact is closed as a registration");
    // One attempt for this contact, so one sheet mirror call at most —
    // the sheet is unconfigured for this suite and nothing is written.
    const attempts = await query<{ n: string }>("SELECT count(*)::text AS n FROM call_attempts WHERE contact_id = $1", [full.contactId]);
    assert.equal(attempts.rows[0]?.n, "1", "exactly one attempt — no second registration");
  });

  await test("D5. a person who says nothing is still hung up — at the closing-wait bound, not the silence window", async () => {
    const quiet = await runScripted({
      transcriptSoFar: [agent(GREETING), agent(GATE), caller("Yes, please.")],
      drive: async (s) => {
        await wait(300);
        s.beginReply();
        await wait(400);
        s.finishReply(CONFIRMED);
      },
    });
    assert.equal(await hangupReasonOf(quiet.outcome.attemptId!), "agent_hangup:final_yes", "the bound names the hangup as the registration it is");
    const afterConfirmationMs = quiet.telemetry.endedAt - quiet.telemetry.confirmationCommittedAt;
    assert.ok(afterConfirmationMs >= CLOSING_WAIT_MS - 100, `the person was given the whole closing wait (${afterConfirmationMs}ms)`);
    assert.ok(afterConfirmationMs < WINDOW_MS, `...and not the whole silence window (${afterConfirmationMs}ms)`);
    const stored = await outcomesOf(quiet.outcome.attemptId!);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.reason, "confirmed_at_gate");
  });

  await test("D6. a question after the confirmation is answered first; the closing then ends the call", async () => {
    const asked = await runScripted({
      transcriptSoFar: [agent(GREETING), agent(GATE), caller("Yes, please.")],
      drive: async (s) => {
        await wait(300);
        s.beginReply();
        await wait(400);
        s.finishReply(CONFIRMED);
        await wait(TICKS_MS);
        s.say("What time does it start?");
        s.beginReply();
        await wait(400);
        s.finishReply(ANSWER);
        await wait(TICKS_MS);
        s.say("Okay, thank you.");
        s.beginReply();
        await wait(400);
        s.finishReply(GOODBYE);
      },
    });
    assert.deepEqual(asked.telemetry.callerTurns, ["What time does it start?", "Okay, thank you."], "both caller turns happened on a live line");
    assert.equal(await hangupReasonOf(asked.outcome.attemptId!), "agent_hangup:final_yes");
    assert.ok(asked.telemetry.endedAt >= asked.telemetry.goodbyeCommittedAt);
    assert.equal(asked.telemetry.armCalls, 1);
    const stored = await outcomesOf(asked.outcome.attemptId!);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.reason, "confirmed_at_gate");
  });

  await test("D7. a refusal still ends promptly as agent_hangup:final_no — the closing wait exists for a registration only", async () => {
    const refused = await runScripted({
      transcriptSoFar: [agent(GREETING), agent(GATE), caller("No, I am not interested.")],
      drive: async (s) => {
        await wait(300);
        s.beginReply();
        await wait(400);
        s.finishReply(REFUSAL_CLOSE);
      },
    });
    assert.equal(await hangupReasonOf(refused.outcome.attemptId!), "agent_hangup:final_no");
    assert.equal(refused.telemetry.armCalls, 0, "nothing to arm on a refusal");
    assert.notEqual(refused.telemetry.endedInState, SessionState.SPEAKING);
  });

  await test("D8. an undecided call ends on the silence window exactly as before", async () => {
    const undecided = await runScripted({
      transcriptSoFar: [agent(GREETING), agent(GATE), caller("Let me think about it.")],
      drive: async (s) => {
        await wait(300);
        s.beginReply();
        await wait(400);
        s.finishReply("Sure, take your time. Take care.");
      },
    });
    assert.equal(await hangupReasonOf(undecided.outcome.attemptId!), "agent_hangup:closing", "the agent's own sign-off still closes an undecided call");
    assert.equal(undecided.telemetry.armCalls, 0);
  });

  // ── The agent's goodbye must be DELIVERED before the line drops ──
  //
  // Real call 2026-09-21 15:39 (attempt fd6e4333): "your seat is
  // reserved" → "Uh, 2 minutes, 2 minutes." → "Sure, no problem, take
  // your time." → hangup on the next tick. The person had spoken, so the
  // hold was released, and whatever the agent said next became the end
  // of the call. The hangup now waits for the agent's closing.
  const granted = await runScripted({
    transcriptSoFar: [agent(GREETING), agent(GATE), caller("Yes, please.")],
    drive: async (s) => {
      await wait(300);
      s.beginReply();
      await wait(400);
      s.finishReply(CONFIRMED);
      await wait(TICKS_MS);
      s.say("Uh, 2 minutes, 2 minutes.");
      s.beginReply();
      await wait(400);
      s.finishReply("Sure, no problem, take your time.");
      // The gap the person used to be cut off in: they asked for time.
      await wait(TICKS_MS);
      s.say("Okay, bye.");
      s.beginReply();
      await wait(400);
      s.finishReply(GOODBYE);
    },
  });

  await test("D9. the person speaks after the confirmation but the agent has NOT said goodbye: the line stays up", () => {
    assert.deepEqual(granted.telemetry.callerTurns, ["Uh, 2 minutes, 2 minutes.", "Okay, bye."], "both caller turns happened on a live line");
    assert.equal(granted.telemetry.armCalls, 1);
  });

  await test("D10. ...and the call ends promptly once the goodbye HAS been delivered, still as agent_hangup:final_yes", async () => {
    assert.equal(await hangupReasonOf(granted.outcome.attemptId!), "agent_hangup:final_yes");
    assert.ok(granted.telemetry.goodbyeCommittedAt > 0, "the goodbye was spoken");
    assert.ok(granted.telemetry.endedAt >= granted.telemetry.goodbyeCommittedAt, "never before the goodbye's audio has drained and it was committed");
    const afterGoodbyeMs = granted.telemetry.endedAt - granted.telemetry.goodbyeCommittedAt;
    assert.ok(afterGoodbyeMs < CLOSING_WAIT_MS, `within a tick or two of the goodbye, not another wait later (${afterGoodbyeMs}ms)`);
    assert.notEqual(granted.telemetry.endedInState, SessionState.SPEAKING, "never mid-goodbye");
    const stored = await outcomesOf(granted.outcome.attemptId!);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.reason, "confirmed_at_gate");
  });

  await test("D11. a person who keeps talking and never closes is hung up at the closing-wait bound after the agent's LAST reply — not before", async () => {
    let lastReplyCommittedAt = 0;
    const talkative = await runScripted({
      transcriptSoFar: [agent(GREETING), agent(GATE), caller("Yes, please.")],
      drive: async (s) => {
        await wait(300);
        s.beginReply();
        await wait(400);
        s.finishReply(CONFIRMED);
        await wait(TICKS_MS);
        s.say("Okay, one more thing.");
        s.beginReply();
        await wait(400);
        s.finishReply("Sure, go ahead.");
        await wait(TICKS_MS);
        s.say("Okay, I will join from my phone then.");
        s.beginReply();
        await wait(400);
        s.finishReply("That works perfectly.");
        lastReplyCommittedAt = Date.now();
      },
    });
    assert.deepEqual(talkative.telemetry.callerTurns, ["Okay, one more thing.", "Okay, I will join from my phone then."], "every caller turn happened on a live line");
    assert.equal(await hangupReasonOf(talkative.outcome.attemptId!), "agent_hangup:final_yes", "still the registration it is");
    const afterLastReplyMs = talkative.telemetry.endedAt - lastReplyCommittedAt;
    assert.ok(afterLastReplyMs >= CLOSING_WAIT_MS - 100, `the bound ran from the agent's last reply (${afterLastReplyMs}ms)`);
    assert.ok(afterLastReplyMs < WINDOW_MS, `...and not the whole silence window (${afterLastReplyMs}ms)`);
  });
} finally {
  await query("DELETE FROM campaigns WHERE id = $1", [campaignId]).catch(() => undefined);
  if (savedSpreadsheetId === undefined) delete process.env["CAMPAIGN_SHEET_SPREADSHEET_ID"];
  else process.env["CAMPAIGN_SHEET_SPREADSHEET_ID"] = savedSpreadsheetId;
  await closeDbPool();
}

report();
