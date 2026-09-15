/**
 * monologue-ab-probe.ts — AUDIT ONLY, hits the real LLM. Not a suite.
 *
 * A single sample of a stochastic model proves nothing: the same prompt
 * and the same history produced 55, 90, 71 and 191-word replies on four
 * consecutive runs. So this measures the policy change the only way it
 * can be measured — the OLD policy text and the NEW one, same scenarios,
 * same histories, k samples each, reported as a distribution.
 *
 * The old text is read from git (`policy-before.ts` in the scratchpad),
 * so arm A is literally the bytes that were shipping.
 *
 * Run: npx tsx src/campaign/tests/monologue-ab-probe.ts [old-policy.ts] [k]
 */

import { config as loadEnvFile } from "dotenv";
import { readFileSync } from "node:fs";

loadEnvFile({ path: ".env.local", quiet: true });

const { buildSystemPrompt, currentTurnNote, languageHintFor } = await import(
  "../../core/session/system-prompt"
);
const { buildCampaignContext } = await import("../domain/campaign-context");
const { CAMPAIGN_CONVERSATION_POLICY } = await import("../script/conversation-policy");
const { findScript } = await import("../script/script-registry");
const { interpolate } = await import("../script/variables");
const { OpenAiGptLanguageModelProvider } = await import(
  "../../providers/language-model/openai-gpt.provider"
);
const { SupportedLanguage } = await import("../../types/enums");

import type { ConversationTurn } from "../../types/provider.types";

// Flags (`--scripts`) are not positional arguments. In script mode there
// is no old policy to read, so the sample count is the only positional.
const scriptMode = process.argv.includes("--scripts");
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const oldPolicyPath = scriptMode ? undefined : positional[0];
const K = Number((scriptMode ? positional[0] : positional[1]) ?? 5);

/** The old `CAMPAIGN_CONVERSATION_POLICY` literal, lifted out of the file. */
function policyLiteralIn(source: string): string {
  const start = source.indexOf("export const CAMPAIGN_CONVERSATION_POLICY = `");
  if (start < 0) throw new Error("no policy literal in the old file");
  const from = source.indexOf("`", start) + 1;
  const to = source.indexOf("`;", from);
  return source.slice(from, to);
}

/**
 * Arm A. A path to any earlier copy of this file — `git show
 * <rev>:src/campaign/script/conversation-policy.ts > old.ts` — measures
 * this change against the bytes that were shipping then. Omitted, there
 * is one arm and the run is a plain measurement of what ships now.
 */
const OLD_POLICY =
  oldPolicyPath !== undefined ? policyLiteralIn(readFileSync(oldPolicyPath, "utf8")) : undefined;
const NEW_POLICY = CAMPAIGN_CONVERSATION_POLICY;
const ARMS = (
  OLD_POLICY !== undefined
    ? ([
        ["BEFORE", OLD_POLICY],
        ["AFTER", NEW_POLICY],
      ] as const)
    : ([["CURRENT", NEW_POLICY]] as const)
) as ReadonlyArray<readonly [string, string]>;

const llm = new OpenAiGptLanguageModelProvider();

type Msg = { role: "user" | "assistant"; content: string };

const words = (t: string) => t.trim().split(/\s+/u).filter((w) => w.length > 0).length;
const sentenceCount = (t: string) =>
  t
    .split(/(?<=[.!?।])\s+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0).length;

async function ask(system: string, history: readonly Msg[]): Promise<string> {
  const turns: Array<{ role: string; content: string; timestamp: Date }> = [
    { role: "system", content: system, timestamp: new Date() },
    ...history.map((h) => ({ role: h.role as string, content: h.content, timestamp: new Date() })),
  ];
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn && turn.role === "user") {
      turn.content = `${currentTurnNote()}\n${languageHintFor(SupportedLanguage.HINGLISH)}\n${turn.content}`;
      break;
    }
  }
  const result = await llm.generateCompletion({
    sessionId: "ab" as never,
    history: turns as unknown as ConversationTurn[],
  });
  return result.turn.content;
}

function systemFor(scriptId: string, version: string, policy: string): { system: string; opening: string } {
  const script = findScript(scriptId, version)!;
  const context = buildCampaignContext({
    campaignId: "ab",
    campaignType: script.campaignType,
    script,
    provider: "smallest-ai",
    customerName: "Priya",
  });
  // Same composition the campaign layer does, with the policy swapped:
  // script first, rules about it last.
  const appendix = `${interpolate(script.systemPromptAppendix, {
    customer_name: "Priya",
    agent_name: "Ishita",
  })}\n\n${policy}`;
  return {
    system: buildSystemPrompt(SupportedLanguage.HINGLISH, "female", appendix),
    opening: context.openingLine,
  };
}

interface Scenario {
  readonly name: string;
  readonly scriptId: string;
  readonly version: string;
  /** Built from the opening line, which differs per script. */
  readonly history: (opening: string) => Msg[];
  /** Text that must NOT reappear — the part the caller already heard. */
  readonly alreadyHeard?: string;
  /**
   * Count replies that do the name step at all: ask who is on the line,
   * or say the name back. Roadmap "identify and use the customer's name
   * early" is a claim about how often this happens, so it is counted
   * rather than eyeballed.
   */
  readonly countsNameStep?: boolean;
}

/** Does this reply ask who is on the line, or use the name it has? */
function doesNameStep(reply: string): boolean {
  const t = reply.toLowerCase();
  const asks =
    /your name|aapka naam|aapkaa naam|and you are|who am i speaking|am i speaking (with|to)|main .*se baat kar/u.test(
      t,
    );
  const uses = /\bpriya\b/u.test(t);
  return asks || uses;
}

/** ...and does it do it in a shape the classifier reads as the gate? */
function nameStepIsGateShaped(reply: string): boolean {
  const t = reply.toLowerCase();
  return /naam likh|naam note|naam darj|naam add|put your name down|add your name/u.test(t);
}

/**
 * Does the reply open by saying the opening line over again?
 *
 * Counted because the name step is one prompt edit away from causing it:
 * an instruction to establish who is on the line reads, to a model, a
 * little like an instruction to introduce yourself. It did exactly that
 * on an earlier draft of this change (reminder v2 went 3/5 -> 5/5), so
 * this column is what keeps the fix for that honest.
 */
function reGreets(reply: string, opening: string): boolean {
  const norm = (t: string) =>
    t
      .toLowerCase()
      .replace(/[^a-z\u0900-\u097f ]+/gu, " ")
      .replace(/ +/gu, " ")
      .trim();
  return norm(reply).slice(0, 120).includes(norm(opening).split(" ").slice(0, 5).join(" "));
}

const V4_PART_ONE =
  "I'm calling to personally invite you to a free live workshop on Sunday, 6th September at " +
  "11 AM. We'll actually build a complete online business live, directly from a phone. Are you with me?";
const V3_PART_ONE =
  "Actually, I'm calling you with a very interesting invitation. We have created Flexi Genie, " +
  "which helps you build and automate your online business just by chatting with AI. Are you with me?";

const SCENARIOS: Scenario[] = [
  {
    name: "v4 pitch turn",
    scriptId: "registration",
    version: "v4",
    history: (o) => [
      { role: "assistant", content: o },
      { role: "user", content: "Hello, haan boliye." },
    ],
  },
  {
    name: "v4 full-detail request",
    scriptId: "registration",
    version: "v4",
    history: (o) => [
      { role: "assistant", content: o },
      { role: "user", content: "Hello." },
      { role: "assistant", content: V4_PART_ONE },
      {
        role: "user",
        content: "Poori detail mein batao, sab kuch, exactly kya kya hoga is session mein?",
      },
    ],
  },
  {
    name: "v4 'continue' after a check-in",
    scriptId: "registration",
    version: "v4",
    history: (o) => [
      { role: "assistant", content: o },
      { role: "user", content: "Hello." },
      { role: "assistant", content: V4_PART_ONE },
      { role: "user", content: "Haan continue kijiye." },
    ],
    alreadyHeard: "personally invite",
  },
  {
    name: "v3 pitch turn (the reported monologue)",
    scriptId: "registration",
    version: "v3",
    history: (o) => [
      { role: "assistant", content: o },
      { role: "user", content: "Hello, haan boliye." },
    ],
  },
  {
    name: "v3 'continue' after a check-in",
    scriptId: "registration",
    version: "v3",
    history: (o) => [
      { role: "assistant", content: o },
      { role: "user", content: "Hello." },
      { role: "assistant", content: V3_PART_ONE },
      { role: "user", content: "Haan continue kijiye." },
    ],
    alreadyHeard: "interesting invitation",
  },
  {
    name: "reminder v2 confirmation turn",
    scriptId: "reminder",
    version: "v2",
    history: (o) => [
      { role: "assistant", content: o },
      { role: "user", content: "Hello, haan boliye." },
    ],
  },
  {
    name: "v4 FIRST reply — name step?",
    scriptId: "registration",
    version: "v4",
    history: (o) => [
      { role: "assistant", content: o },
      { role: "user", content: "Hello?" },
    ],
    countsNameStep: true,
  },
  {
    name: "v4 first reply, caller invites — name step?",
    scriptId: "registration",
    version: "v4",
    history: (o) => [
      { role: "assistant", content: o },
      { role: "user", content: "Haan boliye." },
    ],
    countsNameStep: true,
  },
  {
    name: "reminder v2 FIRST reply — name step?",
    scriptId: "reminder",
    version: "v2",
    history: (o) => [
      { role: "assistant", content: o },
      { role: "user", content: "Hello?" },
    ],
    countsNameStep: true,
  },
];

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

/**
 * MODE 2 — `--scripts`. The policy A/B above answers "did this prompt
 * edit change anything". It cannot answer "is the approved pitch now a
 * conversation", because that lives in the script. This holds the
 * policy fixed at what ships and swaps registration v4 for v5.
 */
if (scriptMode) {
  const SCRIPT_SCENARIOS: Array<{ name: string; history: (o: string) => Msg[]; mid?: string }> = [
    {
      // AFTER the name step, so this measures the pitch itself rather
      // than v5's identity check. v4 has no name step, so on that arm
      // these two turns are simply an exchange it did not ask for —
      // which is the fair comparison: same history, both scripts.
      name: "the pitch turn",
      history: (o) => [
        { role: "assistant", content: o },
        { role: "user", content: "Hello?" },
        { role: "assistant", content: "Am I speaking with Priya?" },
        { role: "user", content: "Haan, Priya bol rahi hoon." },
      ],
    },
    {
      name: "after the caller answers",
      mid: "Nahi, kabhi nahi kiya.",
      history: (o) => [
        { role: "assistant", content: o },
        { role: "user", content: "Haan boliye." },
        {
          role: "assistant",
          content:
            "I'm calling to invite you to a free live workshop this Sunday, 6th September at 11 AM. " +
            "We'll build a complete online business live — the website, the product, checkout and " +
            "payments — all from a phone. Have you tried putting something online before?",
        },
        { role: "user", content: "Nahi, kabhi nahi kiya." },
      ],
    },
  ];

  const asksSomething = (t: string) => /\?/u.test(t);
  const reachesGate = (t: string) =>
    /reserve your free seat|seat reserve|free seat reserve|reserve.*seat/iu.test(t);
  // v5's middle question, in every form it was actually observed in:
  // English as written, romanized Hinglish, and Devanagari. The first
  // version of this matched only the English and under-counted a
  // question the model was in fact asking 8 times out of 8.
  const asksAboutThem = (t: string) =>
    /have you tried|tried (putting|something)|pehle kabhi|kabhi (kuch )?(try|banaya|kiya|daal)|looked at before|where are you with/iu.test(
      t,
    ) || /कोशिश की है|पहले कभी/u.test(t);

  console.log(`SCRIPT A/B — policy fixed at what ships, k=${K} per arm\n`);
  console.log(
    "scenario".padEnd(26) +
      "script".padEnd(9) +
      "words med/max".padEnd(16) +
      "sent med/max".padEnd(15) +
      "ends on ?".padEnd(12) +
      "asks about them".padEnd(18) +
      "reaches gate",
  );
  console.log("-".repeat(112));

  for (const scenario of SCRIPT_SCENARIOS) {
    for (const version of ["v4", "v5"] as const) {
      const { system, opening } = systemFor("registration", version, NEW_POLICY);
      const history = scenario.history(opening);
      const w: number[] = [];
      const sc: number[] = [];
      let q = 0;
      let about = 0;
      let gate = 0;
      for (let i = 0; i < K; i += 1) {
        const reply = await ask(system, history);
        w.push(words(reply));
        sc.push(sentenceCount(reply));
        if (asksSomething(reply)) q += 1;
        if (asksAboutThem(reply)) about += 1;
        if (reachesGate(reply)) gate += 1;
      }
      console.log(
        scenario.name.padEnd(26) +
          version.padEnd(9) +
          `${median(w)}/${Math.max(...w)}`.padEnd(16) +
          `${median(sc)}/${Math.max(...sc)}`.padEnd(15) +
          `${q}/${K}`.padEnd(12) +
          `${about}/${K}`.padEnd(18) +
          `${gate}/${K}`,
      );
    }
  }
  process.exit(0);
}

console.log(`k=${K} samples per arm\n`);
console.log(
  "scenario".padEnd(38) +
    "arm".padEnd(8) +
    "words med/max".padEnd(16) +
    "sent med/max".padEnd(15) +
    "no-question".padEnd(13) +
    "repeats".padEnd(10) +
    "re-greets".padEnd(12) +
    "name-step (gate-shaped)",
);
console.log("-".repeat(128));

for (const scenario of SCENARIOS) {
  for (const [arm, policy] of ARMS) {
    const { system, opening } = systemFor(scenario.scriptId, scenario.version, policy);
    const history = scenario.history(opening);
    const w: number[] = [];
    const s: number[] = [];
    let noQuestion = 0;
    let repeats = 0;
    let nameStep = 0;
    let gateShaped = 0;
    let regreets = 0;
    for (let i = 0; i < K; i += 1) {
      const reply = await ask(system, history);
      w.push(words(reply));
      s.push(sentenceCount(reply));
      if (!/\?/u.test(reply)) noQuestion += 1;
      if (doesNameStep(reply)) nameStep += 1;
      if (nameStepIsGateShaped(reply)) gateShaped += 1;
      if (reGreets(reply, opening)) regreets += 1;
      if (
        scenario.alreadyHeard !== undefined &&
        reply.toLowerCase().includes(scenario.alreadyHeard.toLowerCase())
      ) {
        repeats += 1;
      }
    }
    console.log(
      scenario.name.padEnd(38) +
        arm.padEnd(8) +
        `${median(w)}/${Math.max(...w)}`.padEnd(16) +
        `${median(s)}/${Math.max(...s)}`.padEnd(15) +
        `${noQuestion}/${K}`.padEnd(13) +
        (scenario.alreadyHeard !== undefined ? `${repeats}/${K}` : "-").padEnd(10) +
        `${regreets}/${K}`.padEnd(12) +
        (scenario.countsNameStep === true ? `${nameStep}/${K} (${gateShaped}/${K})` : "-"),
    );
  }
}
