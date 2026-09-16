/**
 * scenarios.ts — the 13 approved benchmark scenarios.
 *
 * PHASE 3 BATCH 3. Pure data plus prompt assembly. Importing this file
 * makes no network request and constructs no provider.
 *
 * ── HOW THE INPUT IS BUILT ────────────────────────────────────────
 *
 * Through the SAME exported surfaces production uses, not a
 * simplification of them:
 *
 *   findScript / buildCampaignContext  -> the interpolated script
 *                                         appendix + policy
 *   buildSystemPrompt                  -> master prompt + appendix,
 *                                         exactly as `SessionRecord`'s
 *                                         constructor assembles it
 *   languageHintFor / currentTurnNote  -> the per-turn annotation
 *
 * The result is the real ~17,100-token production prompt, not a
 * shortened stand-in. Both models receive it byte-for-byte.
 *
 * ── THE ONE PIECE OF MIRRORED LOGIC, AND WHY ──────────────────────
 *
 * `ConversationPipeline.buildRequestHistory` is PRIVATE, so
 * `annotateHistory` below re-applies its two exported helpers in the
 * same order rather than calling it. That is duplication and is
 * declared as such: if the pipeline changes how it annotates a turn,
 * this file does not follow automatically. It is pinned by
 * `test:llm-benchmark` (section A) so the shape is at least asserted,
 * and it is the only production behaviour this harness reproduces
 * rather than invokes.
 *
 * ── LANGUAGE FIXTURES ─────────────────────────────────────────────
 *
 * Measured against production before choosing: 0 of 2,552 real caller
 * turns contain Devanagari. Deepgram's `language: "multi"` has
 * returned romanized Hindi in every stored transcript. So the Hindi
 * and Hinglish scenarios use ROMANIZED text, which is what the model
 * actually receives on a call, and Devanagari appears once as an
 * explicit control rather than as the default.
 */

import { buildSystemPrompt, currentTurnNote, languageHintFor } from "../../core/session/system-prompt";
import { buildCampaignContext } from "../../campaign/domain/campaign-context";
import { findScript } from "../../campaign/script/script-registry";
import { SupportedLanguage } from "../../types/enums";
import { TTS_VOICE_METADATA } from "../../constants/voice.constants";
import type { ConversationTurn } from "../../types/provider.types";

/** The stack the scenarios are built against — the current production lane. */
const BENCH_SCRIPT_ID = "registration";
const BENCH_SCRIPT_VERSION = "v6";
const BENCH_TTS_PROVIDER = "sarvam";
/** Synthetic. Never a real contact — see the PII note in `cli.ts`. */
const BENCH_CUSTOMER_NAME = "Rahul Sharma";

/**
 * How the fixtures are allowed to refer to the event.
 *
 * The first benchmark run had assistant turns saying "this Saturday"
 * while `registration.v6` says Sunday 4 October. The model correctly
 * followed the script over the fixture, so nothing was mis-measured —
 * but a fixture that contradicts the script makes every quality
 * judgement arguable, because a reviewer cannot tell a model error
 * from a fixture error.
 *
 * This phrase is therefore CHECKED AGAINST the script's own
 * machine-readable `eventAt` by `canonicalEventDateMatchesScript()`
 * below, and asserted by `test:llm-benchmark`. The script remains the
 * source of truth; this constant is only the wording, and it cannot
 * drift from the date without failing a test.
 */
export const CANONICAL_EVENT_PHRASE = "Sunday, 4th October at 11 AM";

/** The components the phrase above asserts, in the script's timezone (IST). */
const CANONICAL_EVENT = { year: 2026, month: 10, day: 4, hour: 11 } as const;

export interface BenchmarkScenario {
  /** Stable identifier. Appears in every raw record; do not renumber. */
  readonly id: string;
  readonly title: string;
  /** What this scenario is testing, for the human adjudicating quality. */
  readonly intent: string;
  readonly language: SupportedLanguage;
  /** Prior exchange, oldest first. Excludes the system turn. */
  readonly history: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
  /** The caller utterance the model must answer. */
  readonly callerUtterance: string;
}

/**
 * The 13 approved scenarios. Seeded from the behaviours the Phase 1
 * suites encode and the outcome mix observed in production
 * (`registered_confirmed` 116, `interested_not_confirmed` 173,
 * `declined` 58, `wrong_number` 3).
 *
 * The assistant turns are short stand-ins for the real pitch blocks:
 * what is under test is how the model ANSWERS the caller, and a
 * 400-character block reproduced here would add tokens without adding
 * a decision. The gate wording, however, is reproduced exactly,
 * because the gate is what the registration criteria are judged on.
 */
export const SCENARIOS: readonly BenchmarkScenario[] = [
  {
    id: "S01-english-normal",
    title: "Normal English exchange",
    intent: "Baseline conversational reply in English mid-pitch.",
    language: SupportedLanguage.ENGLISH,
    history: [
      { role: "assistant", content: "Hi Rahul, this is Ishita calling from FlexiFunnels. Is this a good time to talk?" },
      { role: "user", content: "Yes, go ahead." },
      { role: "assistant", content: "Great. We're running a free live workshop on building funnels that convert." },
    ],
    callerUtterance: "Okay, tell me a bit more about it.",
  },
  {
    id: "S02-hindi-romanized",
    title: "Hindi — romanized",
    intent: "Hindi caller as production actually receives it (romanized, not Devanagari).",
    language: SupportedLanguage.HINDI,
    history: [
      { role: "assistant", content: "Namaste Rahul, main Ishita bol rahi hoon FlexiFunnels se. Kya abhi baat kar sakte hain?" },
      { role: "user", content: "Haan ji, boliye." },
    ],
    callerUtterance: "Yeh workshop kis baare mein hai?",
  },
  {
    id: "S03-hinglish-mixed",
    title: "Hinglish mixed",
    intent: "Mixed-script caller; the reply should mirror the mix rather than pick one language.",
    language: SupportedLanguage.HINGLISH,
    history: [
      { role: "assistant", content: "Hi Rahul, this is Ishita from FlexiFunnels. Is this a good time?" },
      { role: "user", content: "Haan bolo, but thoda jaldi." },
    ],
    callerUtterance: "Yeh free hai ya paid? Mujhe timing bhi batao.",
  },
  {
    id: "S04-devanagari-control",
    title: "Devanagari control",
    intent: "CONTROL. No production instance exists (0 of 2,552 turns); tests the other script path.",
    language: SupportedLanguage.HINDI,
    history: [
      { role: "assistant", content: "Namaste Rahul, main Ishita bol rahi hoon FlexiFunnels se." },
      { role: "user", content: "हाँ जी, बोलिए।" },
    ],
    callerUtterance: "यह वर्कशॉप किस बारे में है?",
  },
  {
    id: "S05-short-utterance-gate",
    title: "Short utterance at the gate",
    intent: "A bare Hinglish affirmation answering the registration gate. Must register.",
    language: SupportedLanguage.HINGLISH,
    history: [
      { role: "assistant", content: "The workshop is free and runs for about an hour." },
      { role: "user", content: "Theek hai." },
      { role: "assistant", content: "Shall I register you for the workshop?" },
    ],
    callerUtterance: "Haanji.",
  },
  {
    id: "S06-question-mid-pitch",
    title: "Caller question mid-pitch",
    intent: "Answer the question asked, then return to the script — without restarting it.",
    language: SupportedLanguage.ENGLISH,
    history: [
      { role: "assistant", content: "Hi Rahul, this is Ishita from FlexiFunnels. Is this a good time to talk?" },
      { role: "user", content: "Yes." },
      { role: "assistant", content: "We're running a free live workshop on building high-converting funnels." },
    ],
    callerUtterance: "Sorry, who is this again and how did you get my number?",
  },
  {
    id: "S07-objection-refusal",
    title: "Objection / refusal",
    intent: "A polite Hinglish refusal. Must NOT be read as a registration.",
    language: SupportedLanguage.HINGLISH,
    history: [
      { role: "assistant", content: "The workshop is completely free and takes about an hour." },
      { role: "assistant", content: "Shall I register you for the workshop?" },
    ],
    callerUtterance: "Nahi ji, mujhe interest nahi hai.",
  },
  {
    id: "S08-registration-intent",
    title: "Registration intent at gate",
    intent: "Unambiguous English yes at the gate. Must register and confirm.",
    language: SupportedLanguage.ENGLISH,
    history: [
      { role: "assistant", content: "It's free, and it's on Sunday, 4th October at 11 AM." },
      { role: "assistant", content: "Shall I register you for the workshop?" },
    ],
    callerUtterance: "Yes, please register me.",
  },
  {
    id: "S09-confirmation-plus-question",
    title: "Confirmation + question",
    intent: "A yes that carries a question. Must register AND answer, not drop either.",
    language: SupportedLanguage.ENGLISH,
    history: [
      { role: "assistant", content: "It's free, and it's on Sunday, 4th October at 11 AM." },
      { role: "assistant", content: "Shall I register you for the workshop?" },
    ],
    callerUtterance: "Yes, but will I get a recording if I miss it?",
  },
  {
    id: "S10-multiple-followups",
    title: "Multiple follow-up questions",
    intent: "Three questions in one turn. All should be addressed, concisely, without a list.",
    language: SupportedLanguage.ENGLISH,
    history: [
      { role: "assistant", content: "We're running a free live workshop on building funnels that convert." },
      { role: "user", content: "Okay." },
      { role: "assistant", content: "It's on Sunday, 4th October at 11 AM and runs for about an hour." },
    ],
    callerUtterance: "Who is teaching it, is it beginner friendly, and do I need to install anything?",
  },
  {
    id: "S11-identity-wrong-person",
    title: "Identity context / wrong person",
    intent: "The person reached is not the contact. Must not pitch or register.",
    language: SupportedLanguage.ENGLISH,
    history: [
      { role: "assistant", content: "Am I speaking with Rahul Sharma?" },
    ],
    callerUtterance: "No, you have the wrong number. There's no Rahul here.",
  },
  {
    id: "S12-faq-off-script",
    title: "FAQ / off-script",
    intent: "A question the script does not answer. Must not fabricate a fact.",
    language: SupportedLanguage.ENGLISH,
    history: [
      { role: "assistant", content: "The workshop is free and runs for about an hour, on Sunday, 4th October." },
    ],
    callerUtterance: "Do you offer a refund if I buy the paid course afterwards and don't like it?",
  },
  {
    id: "S13-long-utterance-closing",
    title: "Long caller utterance + natural closing",
    intent: "A long rambling turn ending in a decision. Should close naturally, not restart.",
    language: SupportedLanguage.ENGLISH,
    history: [
      { role: "assistant", content: "Shall I register you for the workshop?" },
      { role: "user", content: "Yes go ahead." },
      { role: "assistant", content: "Done — you're registered. You'll get the link on WhatsApp." },
    ],
    callerUtterance:
      "Okay so I've been trying a few of these funnel tools for about six months now, honestly most of them were too complicated for me and I gave up halfway, my nephew set one up once and it broke, anyway I think that's everything I needed to know so thank you.",
  },
];

/** Every scenario id, for CLI filtering and test assertions. */
export const SCENARIO_IDS: readonly string[] = SCENARIOS.map((s) => s.id);

/**
 * Reads the pinned script's own `eventAt` and reports whether
 * `CANONICAL_EVENT_PHRASE` still describes it.
 *
 * Parsed from the raw ISO string rather than through `new Date()`:
 * `eventAt` is `"2026-10-04T11:00:00+05:30"`, and a `Date` would
 * render it in whatever timezone the benchmark machine happens to be
 * in — which in a UTC CI container is 05:30 on the 4th, and the
 * assertion would start failing for a reason that has nothing to do
 * with the fixtures.
 */
export function canonicalEventDateMatchesScript(): {
  readonly matches: boolean;
  readonly scriptEventAt: string | undefined;
  readonly detail: string;
} {
  const script = findScript(BENCH_SCRIPT_ID, BENCH_SCRIPT_VERSION);
  const eventAt = script?.eventAt;
  if (eventAt === undefined) {
    return {
      matches: false,
      scriptEventAt: undefined,
      detail: `script ${BENCH_SCRIPT_ID}.${BENCH_SCRIPT_VERSION} declares no eventAt to anchor against`,
    };
  }
  const parsed = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):/u.exec(eventAt);
  if (!parsed) {
    return { matches: false, scriptEventAt: eventAt, detail: `eventAt "${eventAt}" is not the expected ISO shape` };
  }
  const [, y, m, d, h] = parsed;
  const matches =
    Number(y) === CANONICAL_EVENT.year &&
    Number(m) === CANONICAL_EVENT.month &&
    Number(d) === CANONICAL_EVENT.day &&
    Number(h) === CANONICAL_EVENT.hour;
  return {
    matches,
    scriptEventAt: eventAt,
    detail: matches
      ? `"${CANONICAL_EVENT_PHRASE}" agrees with eventAt ${eventAt}`
      : `"${CANONICAL_EVENT_PHRASE}" contradicts eventAt ${eventAt} — update the phrase AND the fixtures`,
  };
}

/** Every assistant/user line across all scenarios, for fixture-level assertions. */
export function allFixtureText(): string[] {
  return SCENARIOS.flatMap((s) => [...s.history.map((t) => t.content), s.callerUtterance]);
}

/**
 * The system prompt for the benchmark's campaign context — built once
 * and shared by every scenario and both models, so no scenario can
 * accidentally receive a different prompt from another.
 */
export function buildBenchmarkSystemPrompt(language: SupportedLanguage): string {
  // Fails loudly rather than being cast away: if the pinned script
  // version is ever removed from the registry, a benchmark that
  // silently fell back to another script would compare two models on
  // a prompt neither production run uses.
  const script = findScript(BENCH_SCRIPT_ID, BENCH_SCRIPT_VERSION);
  if (!script) {
    throw new Error(
      `benchmark harness: script "${BENCH_SCRIPT_ID}.${BENCH_SCRIPT_VERSION}" is not in the registry`,
    );
  }
  const context = buildCampaignContext({
    campaignId: "benchmark",
    campaignType: BENCH_SCRIPT_ID,
    script,
    provider: BENCH_TTS_PROVIDER,
    customerName: BENCH_CUSTOMER_NAME,
  });
  const voiceGender = TTS_VOICE_METADATA.get(BENCH_TTS_PROVIDER) ?? "female";
  return buildSystemPrompt(language, voiceGender, context.systemPromptAppendix);
}

/**
 * Applies the per-turn annotation to the latest user turn.
 *
 * MIRRORS `ConversationPipeline.buildRequestHistory`, which is private
 * — see the file header. Same two exported helpers, same order, same
 * placement on the last user turn.
 */
export function annotateHistory(
  turns: readonly ConversationTurn[],
  language: SupportedLanguage,
): ConversationTurn[] {
  const annotated = turns.map((turn) => ({ ...turn }));
  const hint = languageHintFor(language);
  for (let i = annotated.length - 1; i >= 0; i -= 1) {
    const turn = annotated[i];
    if (!turn) continue;
    if (turn.role === "user") {
      turn.content = `${currentTurnNote()}\n${hint}\n${turn.content}`;
      break;
    }
  }
  return annotated;
}

/**
 * The finished history for one scenario: system turn, prior exchange,
 * then the caller's current utterance, annotated exactly as the
 * pipeline annotates it. This is what BOTH providers receive.
 */
export function buildScenarioHistory(scenario: BenchmarkScenario): readonly ConversationTurn[] {
  const now = new Date(0); // fixed: timestamps are not sent to either vendor
  const turns: ConversationTurn[] = [
    { role: "system", content: buildBenchmarkSystemPrompt(scenario.language), timestamp: now },
    ...scenario.history.map((t) => ({ role: t.role, content: t.content, timestamp: now })),
    { role: "user" as const, content: scenario.callerUtterance, timestamp: now },
  ];
  return annotateHistory(turns, scenario.language);
}

/**
 * A short, stable fingerprint of the exact input a scenario produced.
 * Recorded on every raw result so a number can be tied to the bytes
 * that generated it without storing the whole 17k-token prompt.
 */
export function scenarioInputFingerprint(scenario: BenchmarkScenario): string {
  const history = buildScenarioHistory(scenario);
  const totalChars = history.reduce((sum, t) => sum + t.content.length, 0);
  let hash = 0;
  for (const turn of history) {
    for (let i = 0; i < turn.content.length; i += 1) {
      hash = (Math.imul(31, hash) + turn.content.charCodeAt(i)) | 0;
    }
  }
  return `${history.length}t/${totalChars}c/${(hash >>> 0).toString(16)}`;
}
