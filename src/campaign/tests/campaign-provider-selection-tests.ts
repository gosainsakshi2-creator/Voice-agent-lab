/**
 * campaign-provider-selection-tests.ts — `npm run test:provider-selection`
 *
 * THE INCIDENT THIS PINS.
 *
 * An operator created five campaigns to test Soniox. One persisted
 * `soniox`; four persisted `deepgram`, and the four were named
 * "sonioxx test 2", "soniox check 3", "s hk 3" and "17". Ten manual
 * calls were placed believing they compared two recognizers; eight ran
 * Deepgram.
 *
 * The cause was in the form, not the runtime: the `useCallback` that
 * assembled the create request read `sttProvider` without declaring it
 * as a dependency, so React handed back a memoised callback closing
 * over an EARLIER render's value. Selecting Soniox as the last action
 * before pressing Create sent `"deepgram"` while the button showed
 * Soniox.
 *
 * Every case here runs against the pure request builder or against
 * source text. No network, no database, no provider, no call.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED: nothing in this file gives the
 * campaign NAME any influence over provider selection, because nothing
 * in the product may. A campaign called "soniox test" that selected
 * Deepgram must create a Deepgram campaign — inferring intent from a
 * label would be the same silent substitution running the other way.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { buildCampaignCreateBody, campaignIdempotencyKey } = await import(
  "../domain/campaign-create-request"
);
const { CAMPAIGN_STT_PROVIDERS, DEFAULT_CAMPAIGN_STT_PROVIDER } = await import(
  "../domain/campaign-types"
);
const { resolveSttProviderId, STT_PROVIDER_OVERRIDE_ENV } = await import(
  "../dispatch/call-runner"
);

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
    console.log(`         ${error instanceof Error ? error.message : String(error)}`);
  }
}
function section(title: string): void {
  console.log(`\n${title}`);
}

const FORM = readFileSync("src/components/campaign/campaign-list.tsx", "utf8");
const ROUTE = readFileSync("src/app/api/campaigns/route.ts", "utf8");
const RUNNER = readFileSync("src/campaign/dispatch/call-runner.ts", "utf8");

/** The form's other fields, held constant so a case varies only what it names. */
const BASE = {
  name: "october drive",
  campaignType: "registration" as const,
  language: "en",
  providerAllocation: { cartesia: 100 },
  llmAllocation: { "gpt-5.1": 100 },
  telephonyAllocation: { vobiz: 100 },
  script: { id: "registration-v2", version: "2.0.0" },
};

// ═════════════════════════════════════════════════════════════════
section("A. An explicit selection is the value that is sent");

await test("1. explicit Soniox is sent as soniox", () => {
  const body = buildCampaignCreateBody({ ...BASE, sttProvider: "soniox" });
  assert.equal(body.sttProvider, "soniox");
});

await test("2. explicit Deepgram is sent as deepgram", () => {
  const body = buildCampaignCreateBody({ ...BASE, sttProvider: "deepgram" });
  assert.equal(body.sttProvider, "deepgram");
});

await test("3. every supported recognizer round-trips unchanged", () => {
  for (const id of CAMPAIGN_STT_PROVIDERS) {
    assert.equal(
      buildCampaignCreateBody({ ...BASE, sttProvider: id }).sttProvider,
      id,
      `${id} must survive the builder verbatim`,
    );
  }
});

await test("4. the field is ALWAYS present, so 'chose deepgram' != 'never chose'", () => {
  const body = buildCampaignCreateBody({ ...BASE, sttProvider: DEFAULT_CAMPAIGN_STT_PROVIDER });
  assert.ok("sttProvider" in body, "the key must be sent even for the default");
  assert.equal(body.sttProvider, "deepgram");
  // The API only stores NULL when the key is absent, so sending it is
  // what makes the campaign row record a decision.
  assert.match(
    ROUTE,
    /sttProvider\s*=\s*rawStt\s*!==\s*undefined\s*&&\s*rawStt\.length\s*>\s*0\s*\?\s*rawStt\s*:\s*undefined/,
    "the endpoint must still treat absent as 'no choice'",
  );
});

// ═════════════════════════════════════════════════════════════════
section("B. The stale-closure defect cannot return");

await test("5. the builder cannot read a value it was not passed", () => {
  const src = readFileSync("src/campaign/domain/campaign-create-request.ts", "utf8");
  const builder = src.slice(src.indexOf("export function buildCampaignCreateBody"));
  // Every value in the body comes off the one argument object. If a
  // bare identifier were read instead, it could be captured from an
  // enclosing scope — which is the whole shape of the original bug.
  assert.ok(
    /sttProvider:\s*fields\.sttProvider/.test(builder),
    "sttProvider must be read from the argument, never from a closure",
  );
  for (const field of ["providerAllocation", "llmAllocation", "telephonyAllocation"]) {
    assert.ok(
      new RegExp(`${field}:\\s*fields\\.${field}`).test(builder),
      `${field} must be read from the argument`,
    );
  }
});

await test("6. the create callback declares every value its body is built from", () => {
  const start = FORM.indexOf("const create = useCallback(");
  assert.ok(start > 0, "the create callback must still exist");
  // The dependency array is the one that closes the callback.
  const deps = FORM.slice(start).match(/\}, \[([\s\S]*?)\]\);/);
  assert.ok(deps, "the create callback must have a dependency array");
  const declared = deps[1] ?? "";
  assert.ok(declared.length > 0, "the dependency array must not be empty");
  for (const dep of [
    "sttProvider",
    "llmPercents",
    "telephonyPercents",
    "percents",
    "name",
    "campaignType",
    "language",
    "selectedScript",
  ]) {
    assert.ok(
      new RegExp(`\\b${dep}\\b`).test(declared),
      `"${dep}" is read by the request body and MUST be a declared dependency — ` +
        `omitting it is what sent deepgram while the form showed soniox`,
    );
  }
});

await test("7. the form no longer assembles the body inline", () => {
  assert.ok(
    /buildCampaignCreateBody\(/.test(FORM),
    "the form must build its request through the shared builder",
  );
  // The inline literal that carried the bug is gone: no hand-rolled
  // idempotency key, and no second place for the body shape to drift.
  assert.ok(
    !/idempotencyKey:\s*`ui:\$\{campaignType\}/.test(FORM),
    "the inline idempotency key must not be duplicated in the form",
  );
});

// ═════════════════════════════════════════════════════════════════
section("C. A new campaign still gets the intended default");

await test("8. the selector still initialises to the platform default", () => {
  assert.equal(DEFAULT_CAMPAIGN_STT_PROVIDER, "deepgram");
  assert.match(
    FORM,
    /useState<string>\(DEFAULT_CAMPAIGN_STT_PROVIDER\)/,
    "a genuinely new form must start from the platform default, not from a remembered value",
  );
});

await test("9. a successful create does NOT reset the operator's selection", () => {
  const start = FORM.indexOf("const create = useCallback(");
  const end = FORM.indexOf("}, [", start);
  const body = FORM.slice(start, end);
  assert.ok(
    !/setSttProvider\(/.test(body),
    "creating a campaign must not return the recognizer to a default — " +
      "re-selecting it for every campaign is how the incident happened",
  );
  // Only the name is cleared, which is what makes the next campaign a
  // new campaign rather than a fresh set of provider choices.
  assert.ok(/setName\(""\)/.test(body), "the name must still be cleared after a create");
});

// ═════════════════════════════════════════════════════════════════
section("D. The campaign NAME never influences provider selection");

await test("10. a soniox-named campaign that selected deepgram sends deepgram", () => {
  for (const name of ["soniox test", "sonioxx test 2", "soniox check 3", "s hk 3", "SONIOX"]) {
    const body = buildCampaignCreateBody({ ...BASE, name, sttProvider: "deepgram" });
    assert.equal(
      body.sttProvider,
      "deepgram",
      `"${name}" must NOT be promoted to soniox by its label`,
    );
  }
});

await test("11. a deepgram-named campaign that selected soniox sends soniox", () => {
  const body = buildCampaignCreateBody({
    ...BASE,
    name: "deepgram baseline",
    sttProvider: "soniox",
  });
  assert.equal(body.sttProvider, "soniox");
});

await test("12. the name changes only the idempotency key, nothing else", () => {
  const a = buildCampaignCreateBody({ ...BASE, name: "soniox test", sttProvider: "deepgram" });
  const b = buildCampaignCreateBody({ ...BASE, name: "anything else", sttProvider: "deepgram" });
  assert.notEqual(a.idempotencyKey, b.idempotencyKey);
  assert.equal(a.sttProvider, b.sttProvider);
  assert.deepEqual(a.providerAllocation, b.providerAllocation);
  assert.deepEqual(a.llmAllocation, b.llmAllocation);
});

await test("13. the idempotency key does NOT depend on the recognizer", () => {
  // If it did, correcting a mis-selected provider would create a
  // SECOND campaign instead of resolving to the same one.
  const dg = buildCampaignCreateBody({ ...BASE, sttProvider: "deepgram" });
  const sx = buildCampaignCreateBody({ ...BASE, sttProvider: "soniox" });
  assert.equal(dg.idempotencyKey, sx.idempotencyKey);
  assert.equal(campaignIdempotencyKey("registration", "October Drive "), "ui:registration:october drive");
});

await test("14. no provider id is inferred from text anywhere in the builder", () => {
  const src = readFileSync("src/campaign/domain/campaign-create-request.ts", "utf8");
  const code = src
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("*") && !l.trimStart().startsWith("/*") && !l.trimStart().startsWith("//"))
    .join("\n");
  assert.ok(
    !/name[\s\S]{0,40}(includes|match|test|indexOf)\(/.test(code),
    "the builder must never read the campaign name to decide a provider",
  );
  assert.ok(!/["']soniox["']/.test(code), "no provider id may be hard-coded in the builder");
});

// ═════════════════════════════════════════════════════════════════
section("E. Backend persistence and runtime resolution are UNCHANGED");

await test("15. the endpoint still validates against the supported set and fails closed", () => {
  assert.match(ROUTE, /!isCampaignSttProvider\(rawStt\)/);
  assert.match(ROUTE, /is not a supported speech-to-text provider/);
  assert.match(ROUTE, /status:\s*400/);
});

await test("16. the endpoint still omits the column when no choice was sent", () => {
  assert.match(ROUTE, /\.\.\.\(sttProvider !== undefined \? \{ sttProvider \} : \{\}\)/);
});

await test("17. runtime resolution precedence is untouched: campaign choice, then env, then deepgram", () => {
  // The campaign's own choice outranks the process-wide override.
  assert.equal(resolveSttProviderId("soniox"), "soniox");
  assert.equal(resolveSttProviderId("deepgram"), "deepgram");
  // An unrecognised stored value falls back rather than dialing through it.
  assert.equal(resolveSttProviderId("not-a-provider"), "deepgram");
  // No campaign choice and no override => the shipped default.
  const previous = process.env[STT_PROVIDER_OVERRIDE_ENV];
  delete process.env[STT_PROVIDER_OVERRIDE_ENV];
  try {
    assert.equal(resolveSttProviderId(), "deepgram");
    assert.equal(resolveSttProviderId(""), "deepgram");
    assert.equal(resolveSttProviderId("   "), "deepgram");
  } finally {
    if (previous !== undefined) process.env[STT_PROVIDER_OVERRIDE_ENV] = previous;
  }
});

await test("18. STT still has no allocation dimension", () => {
  assert.ok(
    !/pickByAllocation\([\s\S]{0,80}soniox/i.test(RUNNER),
    "STT must not become a per-contact percentage split",
  );
  const src = readFileSync("src/campaign/domain/campaign-create-request.ts", "utf8");
  assert.ok(
    !/sttAllocation/i.test(src),
    "the request body must carry a single STT id, never an allocation",
  );
});

await test("19. this change touched no provider adapter and no resolution code", () => {
  // `resolveSttProviderId` is still the only thing that turns a stored
  // id into a running provider, and it still lives in the call runner.
  assert.match(RUNNER, /export function resolveSttProviderId/);
  assert.ok(
    !/resolveSttProviderId|SPEECH_TO_TEXT_PROVIDER_IDS/.test(FORM),
    "the form must not duplicate runtime provider resolution",
  );
});

// ═════════════════════════════════════════════════════════════════
section("F. The persisted choice is shown back, so a substitution cannot be silent");

await test("20. the confirmation reports the SERVER's value, not the form's", () => {
  assert.match(
    FORM,
    /created\.sttProvider \?\? "not recorded/,
    "the confirmation must read the persisted value echoed by the endpoint",
  );
  // Reading form state there would confirm the operator's intention
  // back to them regardless of what was actually stored.
  assert.ok(
    !/Speech-to-text:[\s\S]{0,160}\{sttProvider\}/.test(FORM),
    "the confirmation must not echo the form's own selection",
  );
});

await test("21. the pending selection is visible before Create is pressed", () => {
  assert.match(FORM, /\$\{sttProvider\} STT/, "the summary line must name the pending recognizer");
});

console.log(
  `\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`,
);
if (failures.length > 0) {
  for (const f of failures) console.log(`  failed: ${f}`);
  process.exitCode = 1;
}
console.log("No telephony, TTS, STT, LLM or database request was made. No call was placed.");
