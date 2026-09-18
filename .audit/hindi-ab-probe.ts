/**
 * hindi-ab-probe.ts — THROWAWAY AUDIT PROBE. Hits the real LLM.
 *
 * Modelled on `src/campaign/tests/monologue-ab-probe.ts`: same arm
 * construction (old policy literal read from git vs the shipping one),
 * same k-per-arm methodology, same "a single sample proves nothing"
 * premise. Differences, all forced by what is being measured:
 *
 *   - the language hint is HINDI, not HINGLISH;
 *   - the script is registration v7, the live campaign;
 *   - the scenarios are the seven Hindi situations under validation.
 *
 * Nothing in src/ is imported-and-modified; every module is the real
 * one, read-only. This file is deleted after the run.
 */

import { config as loadEnvFile } from "dotenv";
import { readFileSync } from "node:fs";

loadEnvFile({ path: ".env.local", quiet: true });

const { buildSystemPrompt, currentTurnNote, languageHintFor } = await import(
  "../src/core/session/system-prompt"
);
const { CAMPAIGN_CONVERSATION_POLICY } = await import(
  "../src/campaign/script/conversation-policy"
);
const { findScript } = await import("../src/campaign/script/script-registry");
const { interpolate } = await import("../src/campaign/script/variables");
const { classifyOutcome } = await import("../src/campaign/outcome/classifier");
const { dispositionFor } = await import("../src/campaign/outcome/disposition");
const { OpenAiGptLanguageModelProvider } = await import(
  "../src/providers/language-model/openai-gpt.provider"
);
const { SupportedLanguage } = await import("../src/types/enums");

import type { ConversationTurn } from "../src/types/provider.types";
import type { TranscriptTurn } from "../src/campaign/outcome/transcript";

const K = Number(process.argv[2] ?? 5);

function policyLiteralIn(source: string): string {
  const start = source.indexOf("export const CAMPAIGN_CONVERSATION_POLICY = `");
  if (start < 0) throw new Error("no policy literal in the old file");
  const from = source.indexOf("`", start) + 1;
  const to = source.indexOf("`;", from);
  return source.slice(from, to);
}

const OLD_POLICY = policyLiteralIn(readFileSync(".audit/policy-before.ts", "utf8"));
const ARMS = [
  ["CONTROL", OLD_POLICY],
  ["TREATMENT", CAMPAIGN_CONVERSATION_POLICY],
] as const;

const llm = new OpenAiGptLanguageModelProvider();
type Msg = { role: "user" | "assistant"; content: string };

const words = (t: string) => t.trim().split(/\s+/u).filter((w) => w.length > 0).length;

/** Formal / literary / bureaucratic Hindi — the register the fix targets. */
const FORMAL_MARKERS = [
  "आरक्षित", "कार्यक्रम", "इच्छुक", "अवगत", "सुनिश्चित", "महोदय", "महोदया",
  "प्रतिभागी", "पंजीकरण", "पंजीकृत", "निःशुल्क", "नि:शुल्क", "उपस्थित",
  "सम्मिलित", "आमंत्रित", "अवसर", "माध्यम", "प्रदान", "संबंधित", "अथवा",
  "कृपया", "विषय", "जानकारी हेतु", "हेतु",
];
/** The words a person actually says for the gate's action. In GATE_ACTIONS. */
const NATURAL_GATE_WORDS = ["सीट रिज़र्व", "सीट बुक", "seat reserve", "seat book", "reserve", "book"];

const formalHits = (t: string) => FORMAL_MARKERS.filter((m) => t.includes(m));
const devanagariRatio = (t: string) => {
  const letters = (t.match(/[\p{L}]/gu) ?? []).length;
  const dev = (t.match(/[ऀ-ॿ]/gu) ?? []).length;
  return letters === 0 ? 0 : dev / letters;
};

/** Does the classifier read this agent turn as the commitment gate? */
function registersWith(agentTurn: string, yes: string): boolean {
  const transcript = [
    { role: "assistant", text: "Hello, this is Ishita from Team FlexiFunnels." },
    { role: "assistant", text: agentTurn },
    { role: "user", text: yes },
  ] as TranscriptTurn[];
  const o = classifyOutcome({
    campaignType: "registration",
    status: "COMPLETED",
    failureClass: "COMPLETED",
    answered: true,
    transcript,
  });
  const { disposition } = dispositionFor({
    outcomeType: o.outcomeType,
    failureClass: "COMPLETED",
  });
  return o.primaryReason === "confirmed_at_gate" && disposition === "FINAL_YES";
}

async function ask(system: string, history: readonly Msg[]): Promise<string> {
  const turns: Array<{ role: string; content: string; timestamp: Date }> = [
    { role: "system", content: system, timestamp: new Date() },
    ...history.map((h) => ({ role: h.role as string, content: h.content, timestamp: new Date() })),
  ];
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn && turn.role === "user") {
      turn.content = `${currentTurnNote()}\n${languageHintFor(SupportedLanguage.HINDI)}\n${turn.content}`;
      break;
    }
  }
  const result = await llm.generateCompletion({
    sessionId: "hindi-ab" as never,
    history: turns as unknown as ConversationTurn[],
  });
  return result.turn.content;
}

const SCRIPT = findScript("registration", "v7")!;
const OPENING = "Hello, this is Ishita from Team FlexiFunnels.";

function systemFor(policy: string): string {
  const appendix = `${interpolate(SCRIPT.systemPromptAppendix, {
    customer_name: "Priya",
    agent_name: "Ishita",
  })}\n\n${policy}`;
  return buildSystemPrompt(SupportedLanguage.HINDI, "female", appendix);
}

const PITCH_EN =
  "I'm calling to invite you to a free two-day event we're running on the 19th and 20th of " +
  "September — the AI Income Blueprint. It's live on Zoom, and it's about using AI to build " +
  "an online income. Are you currently running a business, or are you looking to start something online?";

interface Scenario {
  readonly name: string;
  readonly history: Msg[];
  /** Judge whether the reply reaches the gate, and whether it registers. */
  readonly expectGate?: boolean;
}

const SCENARIOS: Scenario[] = [
  {
    name: "1. caller asks for Hindi",
    history: [
      { role: "assistant", content: OPENING },
      { role: "user", content: "Hello." },
      { role: "assistant", content: PITCH_EN },
      { role: "user", content: "Hindi mein batao." },
    ],
  },
  {
    name: "2. agent explains the event, in Hindi",
    history: [
      { role: "assistant", content: OPENING },
      { role: "user", content: "Hindi mein baat kijiye. Ye event kya hai?" },
    ],
  },
  {
    name: "3. an event FAQ in Hindi",
    history: [
      { role: "assistant", content: OPENING },
      { role: "user", content: "Hindi mein batao." },
      { role: "assistant", content: "ज़रूर। ये एक free do-din ka online event है, 19 और 20 September ko." },
      { role: "user", content: "Kya ye sach mein bilkul free hai? Aur laptop chahiye kya?" },
    ],
  },
  {
    name: "4. THE GATE, asked in Hindi",
    expectGate: true,
    history: [
      { role: "assistant", content: OPENING },
      { role: "user", content: "Hindi mein batao." },
      {
        role: "assistant",
        content:
          "ज़रूर। मैं आपको एक free do-din के AI Income Blueprint event के लिए invite करने के लिए call कर रही हूँ, " +
          "19 और 20 September को, Zoom पर live. क्या आप अभी कोई business चला रही हैं, या online कुछ शुरू करना चाह रही हैं?",
      },
      { role: "user", content: "Abhi kuch nahi kiya hai, shuru karna chahti hoon." },
    ],
  },
  {
    name: "5. a follow-up question in Hindi",
    history: [
      { role: "assistant", content: OPENING },
      { role: "user", content: "Hindi mein batao." },
      {
        role: "assistant",
        content: "ज़रूर। ये free do-din ka event है, 19 और 20 September ko, Zoom पर live.",
      },
      { role: "user", content: "Timing kya hai? Aur ye kaun le raha hai?" },
    ],
  },
  {
    name: "6. mixed Hindi/Hinglish",
    history: [
      { role: "assistant", content: OPENING },
      {
        role: "user",
        content: "Haan ji boliye, main sun rahi hoon. Thoda Hindi mein bataiye na, ye kis type ka event hai?",
      },
    ],
  },
  {
    name: "7. a fact-carrying answer in Hindi",
    history: [
      { role: "assistant", content: OPENING },
      { role: "user", content: "Hindi mein batao." },
      { role: "assistant", content: "ज़रूर। ये एक free do-din ka online event है।" },
      { role: "user", content: "Isme exactly kya kya sikhaya jayega? Aur kitne baje se kitne baje tak?" },
    ],
  },
];

console.log(`HINDI A/B PROBE — k=${K} per arm, ${SCENARIOS.length} scenarios, registration v7`);
console.log(`model=${process.env.OPENAI_MODEL ?? "(default)"}\n`);

for (const scenario of SCENARIOS) {
  console.log(`\n${"═".repeat(72)}\n${scenario.name}\n${"═".repeat(72)}`);
  for (const [arm, policy] of ARMS) {
    const system = systemFor(policy);
    const rows: string[] = [];
    let formalTotal = 0;
    let gateRegistered = 0;
    let gateAsked = 0;
    let wordTotal = 0;
    for (let i = 0; i < K; i += 1) {
      let reply: string;
      try {
        reply = (await ask(system, scenario.history)).trim();
      } catch (error) {
        reply = `<<LLM ERROR: ${error instanceof Error ? error.message : String(error)}>>`;
      }
      const hits = formalHits(reply);
      formalTotal += hits.length;
      wordTotal += words(reply);
      const asksGate = NATURAL_GATE_WORDS.some((w) => reply.toLowerCase().includes(w.toLowerCase()));
      if (asksGate) gateAsked += 1;
      const registers = registersWith(reply, "Haan ji.");
      if (registers) gateRegistered += 1;
      rows.push(
        `   [${i + 1}] w=${String(words(reply)).padStart(3)} dev=${devanagariRatio(reply).toFixed(2)} ` +
          `formal=${hits.length === 0 ? "-" : hits.join(",")} ` +
          `${scenario.expectGate ? `gateWords=${asksGate ? "Y" : "n"} REGISTERS=${registers ? "YES" : "no"}` : ""}\n` +
          `       ${reply.replace(/\n+/gu, " ")}`,
      );
    }
    console.log(
      `\n-- ${arm} — median words ${Math.round(wordTotal / K)}, formal markers ${formalTotal}` +
        (scenario.expectGate ? `, gate asked ${gateAsked}/${K}, REGISTERS ${gateRegistered}/${K}` : ""),
    );
    for (const row of rows) console.log(row);
  }
}
console.log("\nDONE. No call was placed. No TTS vendor was contacted.");
