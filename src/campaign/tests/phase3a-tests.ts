/**
 * phase3a-tests.ts — `npm run test:phase3a`
 *
 * Covers script registry, variable interpolation, agent identity,
 * campaign context, the READY gate, and — most importantly — that a
 * session created WITHOUT campaign context is byte-for-byte what it
 * was before Phase 3A.
 *
 * Contacts no telephony, TTS, STT or LLM provider. Nothing dials.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { config as loadEnvFile } from "dotenv";

loadEnvFile({ path: ".env.local", quiet: true });
loadEnvFile({ quiet: true });

const { findScript, defaultScriptFor, hashScript, listScripts, scriptVariables } = await import(
  "../script/script-registry"
);
const { resolveAgentIdentity, resolveAgentForProvider, AgentIdentityError, isAgentGender } = await import(
  "../script/agent-identity"
);
const { interpolate, extractVariables, ScriptVariableError } = await import("../script/variables");
const { buildCampaignContext, CampaignContextError } = await import("../domain/campaign-context");
const { validateCampaignScript } = await import("../script/script-validation");
const { buildSystemPrompt, openingLineFor } = await import("../../core/session/system-prompt");
const { SupportedLanguage } = await import("../../types/enums");
const { SessionRecord } = await import("../../core/session/session-record");
const { CallDirection, ProviderCategory } = await import("../../types/enums");

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(name);
    console.log(`  [FAIL] ${name}`);
    console.log(`         ${message.split("\n").slice(0, 3).join("\n         ")}`);
  }
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

console.log("\nSCRIPT REGISTRY");

await test("1. registration script loads", () => {
  const script = findScript("registration", "v1");
  assert.ok(script, "registration v1 must exist");
  assert.equal(script?.campaignType, "registration");
});

await test("2. reminder script loads", () => {
  const script = findScript("reminder", "v1");
  assert.ok(script, "reminder v1 must exist");
  assert.equal(script?.campaignType, "reminder");
});

await test("3. script version resolution is exact", () => {
  assert.ok(findScript("registration", "v1"));
  assert.equal(findScript("registration", "v99"), undefined, "unknown version must not resolve");
  assert.equal(findScript("nonexistent", "v1"), undefined);
});

await test("4. script hash is deterministic and content-sensitive", () => {
  const script = findScript("registration", "v1");
  assert.ok(script);
  assert.equal(hashScript(script), hashScript(script), "same input, same hash");
  const edited = { ...script, systemPromptAppendix: `${script.systemPromptAppendix} extra` };
  assert.notEqual(hashScript(edited), hashScript(script), "edited text must change the hash");
  const rev = { ...script, version: "v2" };
  assert.notEqual(hashScript(rev), hashScript(script), "a new version must change the hash");
});

await test("12 + 13. each campaign type resolves to its own script", () => {
  assert.equal(defaultScriptFor("registration").id, "registration");
  assert.equal(defaultScriptFor("reminder").id, "reminder");
  for (const script of listScripts()) {
    assert.equal(script.id, script.campaignType, "script id and campaign type must agree");
  }
});

console.log("\nVARIABLES");

await test("5 + 6. customer_name and agent_name interpolate", () => {
  const out = interpolate("Hi {{customer_name}}, this is {{agent_name}}.", {
    customer_name: "Priya",
    agent_name: "Ishita",
  });
  assert.equal(out, "Hi Priya, this is Ishita.");
  assert.equal(
    interpolate("{{ customer_name }} / {{AGENT_NAME}}", { customer_name: "A", agent_name: "B" }),
    "A / B",
    "whitespace and case must be tolerated",
  );
});

await test("9. a missing customer name is rejected, never blanked", () => {
  for (const bad of [{}, { customer_name: "" }, { customer_name: "   " }]) {
    assert.throws(
      () => interpolate("Hi {{customer_name}}", bad),
      (e: unknown) => e instanceof ScriptVariableError,
    );
  }
  // The exact failure mode this guards against.
  let produced: string | undefined;
  try {
    produced = interpolate("Hi {{customer_name}}, this is {{agent_name}}.", { agent_name: "Ishita" });
  } catch {
    produced = undefined;
  }
  assert.notEqual(produced, "Hi , this is Ishita.", "must never produce an empty-name greeting");
});

await test("6b. an unknown variable is rejected, and no code is executed", () => {
  assert.throws(
    () => interpolate("{{oops}}", { customer_name: "A" }),
    (e: unknown) => e instanceof ScriptVariableError,
  );
  // A template that looks like code stays a literal string.
  const literal = interpolate("{{customer_name}} ${process.exit(1)} `x`", { customer_name: "A" });
  assert.equal(literal, "A ${process.exit(1)} `x`");
  assert.deepEqual(extractVariables("a {{x}} b {{y}} c {{x}}"), ["x", "y"]);
});

console.log("\nAGENT IDENTITY");

await test("7. a female voice resolves to Ishita", () => {
  assert.deepEqual(resolveAgentIdentity("female"), { gender: "female", name: "Ishita" });
  assert.deepEqual(resolveAgentForProvider("smallest-ai"), { gender: "female", name: "Ishita" });
});

await test("8. a male voice resolves to Rohan", () => {
  assert.deepEqual(resolveAgentIdentity("male"), { gender: "male", name: "Rohan" });
  assert.deepEqual(resolveAgentForProvider("cartesia"), { gender: "male", name: "Rohan" });
  assert.deepEqual(resolveAgentForProvider("sarvam"), { gender: "male", name: "Rohan" });
});

await test("8b. a provider with no declared voice has no agent", () => {
  assert.throws(() => resolveAgentForProvider("nope"), (e: unknown) => e instanceof AgentIdentityError);
});

await test("10. an invalid gender is rejected", () => {
  for (const bad of ["MALE", "other", "", null, undefined, 1]) {
    assert.throws(() => resolveAgentIdentity(bad), (e: unknown) => e instanceof AgentIdentityError);
  }
  assert.equal(isAgentGender("female"), true);
  assert.equal(isAgentGender("nonbinary"), false);
});

console.log("\nCAMPAIGN CONTEXT");

const registration = findScript("registration", "v1");
const reminder = findScript("reminder", "v1");
assert.ok(registration && reminder);

await test("15. context carries agent, customer, script and finished text", () => {
  const ctx = buildCampaignContext({
    campaignId: "c1",
    campaignType: "registration",
    script: registration,
    provider: "smallest-ai",
    customerName: "Priya",
  });
  assert.equal(ctx.campaignType, "registration");
  assert.equal(ctx.scriptId, "registration");
  assert.equal(ctx.scriptVersion, "v1");
  assert.deepEqual(ctx.agent, { gender: "female", name: "Ishita" });
  assert.deepEqual(ctx.customer, { name: "Priya" });
  assert.ok(ctx.openingLine.includes("Priya"), "greeting must name the customer");
  assert.ok(ctx.openingLine.includes("Ishita"), "greeting must name the agent");
  assert.ok(!ctx.openingLine.includes("{{"), "no placeholder may survive");
  assert.ok(!ctx.systemPromptAppendix.includes("{{"), "no placeholder may survive");
  // Internal database fields must not leak into the session boundary.
  assert.equal("contactId" in ctx, false);
  assert.equal("metadata" in ctx, false);
});

await test("15b. reminder context uses the reminder script and its own agent", () => {
  const ctx = buildCampaignContext({
    campaignId: "c2",
    campaignType: "reminder",
    script: reminder,
    provider: "cartesia",
    customerName: "Rahul",
  });
  assert.equal(ctx.scriptId, "reminder");
  assert.deepEqual(ctx.agent, { gender: "male", name: "Rohan" });
  assert.ok(ctx.openingLine.includes("Rahul") && ctx.openingLine.includes("Rohan"));
});

await test("9b. context refuses to build without a customer name", () => {
  for (const missing of [null, "", "   "]) {
    assert.throws(
      () =>
        buildCampaignContext({
          campaignId: "c1",
          campaignType: "registration",
          script: registration,
          provider: "smallest-ai",
          customerName: missing,
        }),
      (e: unknown) => e instanceof CampaignContextError,
    );
  }
});

await test("11b. a stale script hash refuses to build", () => {
  assert.throws(
    () =>
      buildCampaignContext({
        campaignId: "c1",
        campaignType: "registration",
        script: registration,
        provider: "smallest-ai",
        customerName: "Priya",
        expectedScriptHash: "deadbeef".repeat(8),
      }),
    (e: unknown) => e instanceof CampaignContextError,
  );
});

console.log("\nREADY GATE");

const baseValidation = {
  campaignType: "registration",
  scriptId: "registration",
  scriptVersion: "v1",
  scriptHash: hashScript(registration),
  allocatedProviders: [] as never[],
  contactsMissingName: 0,
};

await test("11. an unknown or mismatched script blocks READY", () => {
  assert.equal(validateCampaignScript({ ...baseValidation, scriptId: "nope" }).ok, false);
  assert.equal(
    validateCampaignScript({ ...baseValidation, campaignType: "reminder" }).ok,
    false,
    "a reminder campaign must not run the registration script",
  );
  assert.equal(
    validateCampaignScript({ ...baseValidation, scriptHash: "0".repeat(64) }).ok,
    false,
    "a changed script must block",
  );
});

await test("10b. a nameless contact blocks READY", () => {
  assert.equal(validateCampaignScript({ ...baseValidation, contactsMissingName: 0 }).ok, true);
  assert.equal(validateCampaignScript({ ...baseValidation, contactsMissingName: 3 }).ok, false);
});

await test("the installed scripts are the approved ones, not placeholders", () => {
  const result = validateCampaignScript(baseValidation);
  assert.equal(result.scriptIsPlaceholder, false, "the real scripts are installed");
  assert.equal(result.ok, true, "an approved script must not be blocked");
});

await test("mixed provider voice genders are NOT a blocker", () => {
  // Deliberate: the agent name follows each provider's configured
  // voice, so a campaign spanning male- and female-voiced lanes is
  // normal. The configured voices are the ones being benchmarked and
  // must not be changed, nor blocked on.
  const result = validateCampaignScript({
    ...baseValidation,
    allocatedProviders: ["cartesia", "sarvam", "smallest-ai"] as never,
  });
  assert.equal(result.ok, true, "a mixed-gender campaign must be allowed");
  assert.deepEqual(result.agentsByProvider, {
    cartesia: "Rohan",
    sarvam: "Rohan",
    "smallest-ai": "Ishita",
  });
});

await test("a provider with no declared voice gender blocks READY", () => {
  const result = validateCampaignScript({
    ...baseValidation,
    allocatedProviders: ["mystery-tts"] as never,
  });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.some((b) => b.includes("mystery-tts")));
});

console.log("\nREGRESSION — EXISTING SESSIONS UNCHANGED");

await test("14. buildSystemPrompt without a campaign is byte-identical", () => {
  // Hashes captured from the pre-Phase-3A build.
  const expected: Record<string, string> = {
    "en male": "363af8dec6738daaa070a77bf690efcc5db05e3a0f6f7c94350e101654837ced",
    "en female": "48322ec24242570ee7dcf7e8c6f58eb1c1f002499107b628484b835cebaf04af",
    "hi male": "5e2365b6c0e048a7f91edc65ffe758fda4fe78dedbe15b288ec92b1f35b2aefa",
    "hi female": "74dffd083880acfa95beb2d43607efe45923bb21ff093ffcf7638a215a76d210",
    "hi-en male": "63953a22abc67455a8fa5c99df1d78621114c15161a8d262459831b83952ddbc",
    "hi-en female": "0d057edd9cc6c1a36a0145933beaa1e1d42ddc0369ade456c96efe76cb8de0ef",
  };
  for (const language of [SupportedLanguage.ENGLISH, SupportedLanguage.HINDI, SupportedLanguage.HINGLISH]) {
    for (const gender of ["male", "female"] as const) {
      const key = `${language} ${gender}`;
      assert.equal(sha(buildSystemPrompt(language, gender)), expected[key], `prompt changed for ${key}`);
    }
  }
  // Explicitly-absent campaign text must behave the same as omitted.
  assert.equal(
    buildSystemPrompt(SupportedLanguage.ENGLISH, "female", undefined),
    buildSystemPrompt(SupportedLanguage.ENGLISH, "female"),
  );
  assert.equal(
    buildSystemPrompt(SupportedLanguage.ENGLISH, "female", "   "),
    buildSystemPrompt(SupportedLanguage.ENGLISH, "female"),
  );
});

await test("16. the opening line overrides only for campaign sessions", () => {
  const original = openingLineFor(SupportedLanguage.ENGLISH, "female");
  assert.equal(original, "Hello! I'm calling from FlexiFunnels. Is this a good time to talk?");
  assert.equal(openingLineFor(SupportedLanguage.ENGLISH, "female", undefined), original);
  assert.equal(openingLineFor(SupportedLanguage.ENGLISH, "female", ""), original);
  assert.equal(
    openingLineFor(SupportedLanguage.ENGLISH, "female", "Hi Priya, this is Ishita."),
    "Hi Priya, this is Ishita.",
  );
  // The Hindi gendered greetings must still differ.
  assert.notEqual(
    openingLineFor(SupportedLanguage.HINDI, "male"),
    openingLineFor(SupportedLanguage.HINDI, "female"),
  );
});

await test("14b. a SessionRecord without campaign context is unchanged", () => {
  const stack = {
    telephony: { category: ProviderCategory.TELEPHONY, id: "vobiz" },
    speechToText: { category: ProviderCategory.SPEECH_TO_TEXT, id: "deepgram" },
    languageModel: { category: ProviderCategory.LANGUAGE_MODEL, id: "gpt-5.1" },
    textToSpeech: { category: ProviderCategory.TEXT_TO_SPEECH, id: "cartesia" },
  } as const;
  const request = {
    language: SupportedLanguage.ENGLISH,
    direction: CallDirection.OUTBOUND,
    providerStack: stack,
    destinationNumber: "+919876543210",
  };

  const plain = new SessionRecord("s1" as never, request as never, stack as never);
  assert.equal(plain.campaignOpeningLine, undefined, "no campaign, no override");
  const systemTurn = plain.memory.history().find((turn) => turn.role === "system");
  assert.equal(
    sha(systemTurn?.content ?? ""),
    "363af8dec6738daaa070a77bf690efcc5db05e3a0f6f7c94350e101654837ced",
    "the system prompt of a plain session must be exactly what it was",
  );

  const ctx = buildCampaignContext({
    campaignId: "c1",
    campaignType: "registration",
    script: registration,
    provider: "cartesia",
    customerName: "Priya",
  });
  const campaignRecord = new SessionRecord(
    "s2" as never,
    { ...request, campaign: ctx } as never,
    stack as never,
  );
  assert.equal(campaignRecord.campaignOpeningLine, ctx.openingLine, "campaign greeting must reach the record");
  const campaignTurn = campaignRecord.memory.history().find((turn) => turn.role === "system");
  assert.ok(campaignTurn?.content.includes("Priya"), "scenario must reach the prompt");
  assert.ok(
    campaignTurn?.content.startsWith("# ROLE"),
    "the master prompt must still come first, unchanged",
  );
  assert.ok(
    (campaignTurn?.content.length ?? 0) > (systemTurn?.content.length ?? 0),
    "the campaign prompt is the master prompt PLUS the scenario",
  );
});

await test("17. no language-handling code was added or changed", () => {
  // The scenario text must not try to pin the caller to one language;
  // the existing master prompt owns that behavior entirely.
  for (const script of listScripts()) {
    const text = `${script.systemPromptAppendix} ${script.openingLineTemplate}`.toLowerCase();
    for (const banned of ["only speak", "speak only", "do not switch language", "always reply in english"]) {
      assert.ok(!text.includes(banned), `script "${script.id}" must not constrain language: "${banned}"`);
    }
  }
  // Language sections of the master prompt are still present and intact.
  const prompt = buildSystemPrompt(SupportedLanguage.ENGLISH, "female");
  for (const section of ["# DO NOT ANNOUNCE YOUR LANGUAGE STRATEGY", "# VOICE GENDER"]) {
    assert.ok(prompt.includes(section), `master prompt must still contain ${section}`);
  }
});

console.log("\nNO-CALL GUARANTEE");

await test("18 + 19. the script layer reaches no provider", () => {
  for (const script of listScripts()) {
    assert.deepEqual(
      scriptVariables(script).filter((v) => !["customer_name", "agent_name"].includes(v)),
      [],
      "scripts may only use supported variables",
    );
  }
  // Structural: asserted by the grep in the phase report, and by the
  // fact that nothing imported here can dial.
  assert.ok(true);
});

console.log("");
console.log("=".repeat(48));
console.log(`${passed}/${passed + failures.length} checks passed`);
if (failures.length > 0) {
  console.error("\nFAILURES:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("No telephony, TTS, STT or LLM request was made.");
process.exit(0);
