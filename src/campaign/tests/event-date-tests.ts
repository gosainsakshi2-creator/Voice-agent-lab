/**
 * event-date-tests.ts — `npm run test:event-date`
 *
 * PHASE 1 §4.5 BATCH 2 — F2. THE SCRIPT'S DATE, AND THE CLOCK.
 *
 * WHAT WAS WRONG. A campaign script states its event date in prose,
 * inside text that is immutable and pinned by content hash. There was
 * no machine-readable form of it, so nothing could check it — and
 * `validateCampaignScript`, which is the gate between a campaign and a
 * dialable state, checked the hash, the campaign type, the variables
 * and the contact names and never asked whether the event had already
 * happened.
 *
 * `registration v5` invites people to "this Sunday, 6th September at 11
 * AM", and repeats "Sunday, 6 September at 11 AM IST" in the FAQ list
 * the agent answers "when is it?" from. Nine days after that date it
 * was still saying both, to every caller, with no blocker anywhere in
 * the system. A confident, specific, wrong fact is the exact failure
 * the no-invention policy exists to prevent, arriving through the one
 * channel that policy trusts without question.
 *
 * THE FIX IS TWO HALVES and this suite asserts both:
 *
 *   A  v5 is untouched. Correcting a pinned script by editing it is
 *      the thing the whole versioning mechanism exists to forbid, so
 *      the fix is a NEW version and v5 must come through it
 *      byte-identical, hash included.
 *
 *   B  v6 is that version: v5's words with the date corrected and
 *      nothing else, carrying the same gate, the same middle question
 *      and the same campaign facts.
 *
 *   C  `eventAt` is the date in the one form a machine can read, and
 *      it is OUTSIDE the content hash — so declaring one neither
 *      changes a script's hash nor invalidates a campaign pinned to it.
 *
 *   D  preflight blocks a script whose event has passed, accepts one
 *      in the future, and is unchanged for every script that declares
 *      no date at all.
 *
 *   E  every validation invariant that existed before still fires.
 *
 * The date under test is a TEST DATE — Sunday 4 October 2026, 11:00
 * IST — not a business-approved one. `now` is injected everywhere so
 * both sides of the boundary are asserted directly rather than by
 * waiting for a date to pass; D5 is the one case that uses the real
 * clock, because "is the shipping script stale RIGHT NOW" is the
 * question this whole suite exists to answer.
 *
 * NOTHING HERE PLACES A CALL, TOUCHES A DATABASE, OR CONTACTS GOOGLE.
 */

import assert from "node:assert/strict";

import {
  defaultScriptFor,
  findScript,
  hashScript,
  listScripts,
  scriptVariables,
} from "../script/script-registry";
import { eventDateBlocker, validateCampaignScript } from "../script/script-validation";
import type { CampaignScript } from "../script/script-types";

let passed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  [FAIL] ${name}`);
    console.log(`         ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`);
  }
}

const section = (title: string) => console.log(`\n${title}`);

const V5 = findScript("registration", "v5")!;
const V6 = findScript("registration", "v6")!;

/**
 * v5's hash, recorded here as a literal.
 *
 * This is the assertion that makes "v5 is untouched" mean something. A
 * test that re-derives the hash from the file proves only that the file
 * hashes to whatever it currently is; a literal proves the words did
 * not move. Same device `long-monologue-tests` I1 uses for v4.
 */
const V5_HASH = "86cd439509f902097656b0ec9093458279b920ad20562a4ed59aa111e5c9fc2b";

/** The chosen TEST event date, as the script declares it. */
const V6_EVENT_AT = "2026-10-04T11:00:00+05:30";

/** A validation input that is valid in every respect except what a test varies. */
const validationFor = (script: CampaignScript, now: Date) => ({
  campaignType: script.campaignType,
  scriptId: script.id,
  scriptVersion: script.version,
  scriptHash: hashScript(script),
  allocatedProviders: ["cartesia"] as const,
  contactsMissingName: 0,
  now,
});

const BEFORE_EVENT = new Date("2026-10-01T00:00:00+05:30");
const AFTER_EVENT = new Date("2026-10-05T00:00:00+05:30");

// ═════════════════════════════════════════════════════════════════
section("A. v5 IS UNTOUCHED — A PINNED SCRIPT IS NEVER EDITED");

test("A1. v5 is still registered, and its content hash is unchanged", () => {
  assert.ok(V5, "v5 must stay registered for campaigns pinned to it");
  assert.equal(
    hashScript(V5),
    V5_HASH,
    "correcting the date must NOT have edited v5 — publish a new version instead",
  );
});

test("A2. v5 still says what it always said, wrong date included", () => {
  // Deliberate. v5's text is what some campaigns are pinned to, and a
  // test that let it drift would be the same defect as editing it.
  assert.ok(V5.systemPromptAppendix.includes("this Sunday, 6th September at 11"));
  assert.ok(V5.systemPromptAppendix.includes("- When: Sunday, 6 September at 11 AM IST."));
});

test("A3. v5 declares no event date, so nothing about its validation changed", () => {
  assert.equal(V5.eventAt, undefined, "v5 must not gain a field that would block pinned campaigns");
  const result = validateCampaignScript(validationFor(V5, AFTER_EVENT));
  assert.equal(result.ok, true, "a script that declares no date is validated exactly as before");
  assert.deepEqual(result.blockers, []);
});

// ═════════════════════════════════════════════════════════════════
section("B. v6 IS v5 WITH THE DATE CORRECTED, AND NOTHING ELSE");

test("B1. v6 is registered, and the default is the workshop script", () => {
  // v6 WAS the default until `registration v15` — the same workshop,
  // the same date and the same facts, in the conversation shape v8-v14
  // converged on — took its place. v6 stays registered for the
  // campaigns pinned to its hash, which is what this section is about.
  assert.ok(V6, "v6 must be registered");
  assert.equal(defaultScriptFor("registration").version, "v15");
  assert.equal(defaultScriptFor("registration").eventAt, V6.eventAt, "the same workshop instant");
  assert.equal(V6.campaignType, "registration");
  assert.equal(V6.isPlaceholder, false, "a placeholder script must never be the default");
  assert.equal(V6.requiresName, true, "the identity check and the greeting both need the name");
});

test("B2. v6 carries the FUTURE test date, in the script and in the FAQ", () => {
  assert.ok(
    V6.systemPromptAppendix.includes("on Sunday, 4th October at 11"),
    "the pitch must state the corrected date",
  );
  assert.ok(
    V6.systemPromptAppendix.includes("- When: Sunday, 4 October at 11 AM IST."),
    "and the FAQ line the agent answers \"when is it?\" from must agree with it",
  );
  assert.ok(
    !V6.systemPromptAppendix.includes("6th September") &&
      !V6.systemPromptAppendix.includes("6 September"),
    "no trace of the stale date may survive anywhere in v6",
  );
});

test("B3. the pitch and the FAQ cannot disagree about the date", () => {
  // The defect this guards against is subtler than a stale date: a
  // version that corrects the pitch and forgets the FAQ answers "when
  // is it?" with a different date than it just said out loud.
  const dates = [...V6.systemPromptAppendix.matchAll(/(\d{1,2})(?:st|nd|rd|th)? (January|February|March|April|May|June|July|August|September|October|November|December)/g)];
  assert.ok(dates.length >= 2, "the date must appear in both the pitch and the FAQ");
  const unique = new Set(dates.map((m) => `${m[1]} ${m[2]}`));
  assert.equal(unique.size, 1, `v6 states more than one event date: ${[...unique].join(" / ")}`);
  assert.equal([...unique][0], "4 October");
});

test("B4. every campaign fact v5 stated is still stated, and none is added", () => {
  const text = V6.systemPromptAppendix.toLowerCase();
  for (const required of [
    "free live workshop", "sunday", "11 am", "complete online business", "from a phone",
    "website", "product", "checkout", "payments", "coding", "design skills",
    "reserve your free seat", "whatsapp and email", "launch-in-a-day starter kit",
    "1,50,000", "live q&a session", "special reveal",
    "have you tried putting something online before",
    "registration is completely free",
  ]) {
    assert.ok(text.includes(required.toLowerCase()), `v6 must still carry "${required}"`);
  }
});

test("B5. the gate and the middle question are byte-identical to v5's", () => {
  // The gate is a COMMIT_ANCHORS entry: re-wording it silently stops
  // the sheet mirror and the end-of-call check. The middle question was
  // worded specifically so the classifier CANNOT read it as the gate.
  for (const line of [
    "Would you like me to reserve your free seat?",
    "Have you tried putting something online before?",
  ]) {
    assert.ok(V5.systemPromptAppendix.includes(line), `v5 baseline: "${line}"`);
    assert.ok(V6.systemPromptAppendix.includes(line), `v6 must not re-word: "${line}"`);
  }
});

test("B6. v6 differs from v5 ONLY in the lines that state the date", () => {
  const a = V5.systemPromptAppendix.split("\n");
  const b = V6.systemPromptAppendix.split("\n");
  assert.equal(a.length, b.length, "v6 must not add or remove a line");
  const differing = a.map((line, i) => [i, line, b[i]] as const).filter(([, x, y]) => x !== y);
  assert.equal(differing.length, 3, `expected exactly 3 changed lines, got ${differing.length}`);
  for (const [i, before, after] of differing) {
    assert.ok(
      /September/.test(before ?? "") && /October/.test(after ?? ""),
      `line ${i + 1} changed for a reason other than the date:\n  ${before}\n  ${after}`,
    );
  }
  assert.equal(
    V5.openingLineTemplate,
    V6.openingLineTemplate,
    "the spoken opening line must not change",
  );
});

test("B7. v6 uses no variable the campaign layer cannot supply", () => {
  assert.deepEqual(scriptVariables(V6), ["agent_name", "customer_name"]);
});

// ═════════════════════════════════════════════════════════════════
section("C. eventAt IS MACHINE-READABLE, AND OUTSIDE THE CONTENT HASH");

test("C1. v6 declares the date it speaks, as a parseable instant with an offset", () => {
  assert.equal(V6.eventAt, V6_EVENT_AT);
  const parsed = new Date(V6.eventAt!);
  assert.ok(!Number.isNaN(parsed.getTime()), "eventAt must parse");
  assert.equal(parsed.getUTCDay(), 0, "the script says Sunday, so the instant must be a Sunday");
});

test("C2. declaring an event date does not change a script's content hash", () => {
  // The safety case for putting this on `CampaignScript` at all: a
  // script can gain a date without invalidating a campaign pinned to
  // its hash. Proved by hashing a copy with the field stripped.
  const { eventAt: _dropped, ...withoutDate } = V6;
  assert.equal(
    hashScript(withoutDate as CampaignScript),
    hashScript(V6),
    "eventAt must not be part of the hashed content",
  );
});

test("C3. no OTHER registered script silently gained a date", () => {
  // If a later change declares `eventAt` on an older version, that
  // version's campaigns start being blocked by the clock. That may be
  // wanted — but it must be a deliberate edit, visible here.
  const declaring = listScripts().filter((s) => s.eventAt !== undefined).map((s) => `${s.id}/${s.version}`);
  // v9 and v10 declare 2026-09-22T19:30:00+05:30 deliberately: a
  // one-evening webinar is exactly the case the field was made for.
  // v13 declares 2026-09-22T20:00:00+05:30 for the same reason — a
  // single-evening implementation session, dialled on the day it runs,
  // which makes the clock blocker load-bearing rather than decorative.
  // v14 is the same session for a different audience, so it declares the
  // same instant, and the two are asserted equal in the v14 suite.
  // v15 is v6's workshop in the later conversation shape, so it declares
  // v6's instant — asserted equal in B1 above and in the v15 suite.
  assert.deepEqual(declaring, [
    "registration/v15", "registration/v6", "registration/v13", "registration/v14",
    "registration/v12", "registration/v11", "registration/v10", "registration/v9",
  ]);
});

// ═════════════════════════════════════════════════════════════════
section("D. PREFLIGHT BLOCKS A SCRIPT WHOSE EVENT HAS PASSED");

test("D1. a future event date validates", () => {
  const result = validateCampaignScript(validationFor(V6, BEFORE_EVENT));
  assert.equal(result.ok, true, `unexpected blockers: ${result.blockers.join(" | ")}`);
});

test("D2. a past event date is a blocker, and says why", () => {
  const result = validateCampaignScript(validationFor(V6, AFTER_EVENT));
  assert.equal(result.ok, false, "a campaign must not dial a workshop that already happened");
  assert.equal(result.blockers.length, 1, "only the date may be wrong in this fixture");
  assert.match(result.blockers[0]!, /already happened/i);
  assert.match(result.blockers[0]!, /registration v6/);
});

test("D3. the boundary is the event instant itself", () => {
  const at = new Date(V6_EVENT_AT);
  assert.equal(
    validateCampaignScript(validationFor(V6, new Date(at.getTime() - 1))).ok,
    true,
    "one millisecond before it starts is still dialable",
  );
  assert.equal(
    validateCampaignScript(validationFor(V6, at)).ok,
    false,
    "once it has started, inviting people to it is a wrong fact",
  );
});

test("D4. an unreadable declared date is a blocker, not silent protection", () => {
  // Tested through `eventDateBlocker` rather than the whole validator,
  // because the validator resolves its script from the registry by id
  // and version and a malformed script cannot be handed to it. A date
  // the layer cannot parse must not read as protection it is not
  // giving.
  for (const bad of [
    "next Sunday",
    "",
    "Sunday 4 October",
    // Parses FINE, and to the wrong day: JS reads this month-first, so
    // it is 10 April 2026. A script meaning 4 October would otherwise
    // pass the check carrying a date six months out.
    "04/10/2026",
    // Valid ISO, no offset — read as UTC, which puts an 11 AM IST event
    // five and a half hours off.
    "2026-10-04T11:00:00",
    "2026-10-04",
  ]) {
    const broken = { ...V6, eventAt: bad } as CampaignScript;
    const blocker = eventDateBlocker(broken, BEFORE_EVENT);
    assert.ok(blocker, `"${bad}" must be rejected, not silently accepted`);
    assert.match(blocker, /cannot read/i, `"${bad}" must be rejected AS UNREADABLE`);
  }
});

test("D4c. the accepted spellings are ISO instants that carry an offset", () => {
  for (const good of [
    "2026-10-04T11:00:00+05:30",
    "2026-10-04T11:00+05:30",
    "2026-10-04T05:30:00Z",
    "2026-10-04T11:00:00.000+05:30",
  ]) {
    const ok = { ...V6, eventAt: good } as CampaignScript;
    assert.equal(eventDateBlocker(ok, BEFORE_EVENT), undefined, `"${good}" must be accepted`);
  }
});

test("D4b. the helper and the validator agree, so the extraction changed nothing", () => {
  for (const now of [BEFORE_EVENT, AFTER_EVENT, new Date(V6_EVENT_AT)]) {
    const viaHelper = eventDateBlocker(V6, now) !== undefined;
    const viaValidator = !validateCampaignScript(validationFor(V6, now)).ok;
    assert.equal(viaHelper, viaValidator, `disagreement at ${now.toISOString()}`);
  }
  assert.equal(eventDateBlocker(V5, AFTER_EVENT), undefined, "no declared date, no blocker");
});

test("D5. the SHIPPING script is not stale right now, on the real clock", () => {
  // The one case that does not inject a clock. This is the question the
  // whole batch exists to answer, and it must be asked of the real
  // present or it is not being asked at all. When this fails, the test
  // date has passed and a new version is due — which is the mechanism
  // working, not a broken test.
  const shipping = defaultScriptFor("registration");
  const result = validateCampaignScript({
    campaignType: shipping.campaignType,
    scriptId: shipping.id,
    scriptVersion: shipping.version,
    scriptHash: hashScript(shipping),
    allocatedProviders: ["cartesia"],
    contactsMissingName: 0,
  });
  assert.equal(
    result.ok,
    true,
    `the shipping script is not dialable today: ${result.blockers.join(" | ")}`,
  );
});

// ═════════════════════════════════════════════════════════════════
section("E. EVERY PRE-EXISTING VALIDATION INVARIANT STILL FIRES");

test("E1. an unregistered script, a type mismatch and a stale hash all still block", () => {
  const base = validationFor(V6, BEFORE_EVENT);
  assert.equal(validateCampaignScript({ ...base, scriptId: "nope" }).ok, false);
  assert.equal(validateCampaignScript({ ...base, campaignType: "reminder" }).ok, false);
  assert.equal(validateCampaignScript({ ...base, scriptHash: "0".repeat(64) }).ok, false);
});

test("E2. a contact with no name still blocks a name-speaking script", () => {
  const base = validationFor(V6, BEFORE_EVENT);
  assert.equal(validateCampaignScript({ ...base, contactsMissingName: 0 }).ok, true);
  assert.equal(validateCampaignScript({ ...base, contactsMissingName: 3 }).ok, false);
});

// The provider/voice-gender blocker is deliberately NOT re-asserted
// here: which providers have a declared gender is read from the
// environment, so a copy of that assertion would pass or fail on the
// machine's `.env.local` rather than on this change. `phase3a-tests`
// owns it, in the environment it was written for.

test("E4. the date blocker is ADDITIVE — it never removes another one", () => {
  // A stale date plus a missing name must report both. A new blocker
  // that masked an existing one would be a regression dressed as a fix.
  const result = validateCampaignScript({
    ...validationFor(V6, AFTER_EVENT),
    contactsMissingName: 2,
  });
  assert.equal(result.ok, false);
  assert.equal(result.blockers.length, 2, `expected both blockers, got: ${result.blockers.join(" | ")}`);
  assert.ok(result.blockers.some((b) => /already happened/i.test(b)));
  assert.ok(result.blockers.some((b) => /no name/i.test(b)));
});

// ═════════════════════════════════════════════════════════════════
console.log(
  failures.length === 0
    ? `\nALL PASSED — ${passed} passed, 0 failed`
    : `\nFAILURES — ${passed} passed, ${failures.length} failed`,
);
for (const name of failures) console.log(`  - ${name}`);
console.log("\nNo telephony, TTS, STT, LLM or database request was made. No call was placed.");
process.exit(failures.length === 0 ? 0 : 1);
