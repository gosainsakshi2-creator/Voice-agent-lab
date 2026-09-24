import io

p = "src/campaign/tests/identity-gate-tests.ts"
s = io.open(p, encoding="utf-8", newline="").read()
NL = "\r\n"

anchor = NL.join([
    "console.log(`\\n${\"═\".repeat(60)}`);",
    "console.log(`${passed} passed, ${failures.length} failed`);",
])
assert s.count(anchor) == 1, s.count(anchor)

SECTION = r'''
// ═════════════════════════════════════════════════════════════════
section("F. A DENIED IDENTITY MUST NOT BECOME A REGISTRATION");
// ═════════════════════════════════════════════════════════════════
//
// THE GATE'S VERDICT USED TO STOP AT THE GATE. `identityState =
// "denied"` kept the identity question from being reopened, and that
// was the whole of it. Everything the campaign does with a finished
// call is read back out of the TRANSCRIPT by `classifyOutcome`:
//
//   stored outcome / confirmed_at_gate   classifier.ts rule 4
//   FINAL_YES disposition / retry        disposition.ts, retry-planner
//   registrations sheet                  isFinalYes(classification, …)
//   live hangup                          definitiveAnswerIn -> verdictFrom
//
// All four read the SAME label, and the transcript does not record
// which sentence was the identity question — so a denial whose words
// are not in the classifier's own (deliberately narrow) WRONG_NUMBER
// table was invisible to every one of them. Reproduced against the real
// classifier on 2026-09-23:
//
//   agent   "Am I speaking with Sakshi?"
//   caller  "No."
//   agent   "…should I reserve your free seat for Sunday?"
//   caller  "Yes."
//   -> registered_confirmed / confirmed_at_gate / succeeded / FINAL_YES
//      -> a sheet row, a closed contact, and an early hangup, for
//         somebody who had just said they were not the person.
//
// The gate's verdict is now carried to that one function (see
// `ClassifyOutcomeInput.identityDenied`), where the repository's own
// existing category for it already sits ABOVE the commitment gate:
// `wrong_number` / `wrong_person` -> FINAL_NO. No new outcome type, no
// new reason, no new disposition, no new retry rule and no new hangup
// rule — the fact is simply made visible where the decisions are taken.

const { classifyOutcome: classifyF } = await import("../outcome/classifier");
const { dispositionFor: dispositionForF } = await import("../outcome/disposition");
const { isFinalYes: isFinalYesF } = await import("../integrations/final-yes-sheet");

const GATE_LINE = "Great — should I reserve your free seat for Sunday?";

/** Every campaign consequence of one transcript, read through the real code. */
function consequencesOf(
  turns: readonly { readonly role: "user" | "assistant"; readonly text: string }[],
  identityDenied: boolean,
) {
  const classification = classifyF({
    campaignType: "registration",
    status: "COMPLETED",
    failureClass: "COMPLETED",
    answered: true,
    transcript: turns as never,
    ...(identityDenied ? { identityDenied: true } : {}),
  });
  const { disposition } = dispositionForF({
    outcomeType: classification.outcomeType,
    failureClass: "COMPLETED",
  });
  return {
    // 1. the stored outcome row
    outcomeType: classification.outcomeType,
    primaryReason: classification.primaryReason,
    succeeded: classification.succeeded,
    // 2. the contact disposition the retry planner reads
    disposition,
    // 3. the registrations-sheet mirror
    sheetRow: isFinalYesF(classification, disposition),
    // 4. the live hangup
    liveVerdict: definitiveAnswerIn(
      turns.map((t) => ({ role: t.role, content: t.text })) as never,
      "registration",
      identityDenied,
    ),
  };
}

/** The reported shape: denied, then a generic yes to the commitment question. */
const DENIED_THEN_YES = (denial: string) => [
  { role: "assistant" as const, text: ID_LINE },
  { role: "user" as const, text: denial },
  { role: "assistant" as const, text: GATE_LINE },
  { role: "user" as const, text: "Yes." },
  { role: "assistant" as const, text: "Perfect, your free seat is reserved." },
];

await test("F1. END TO END: a genuine denial leaves the gate DENIED, through the real pipeline", async () => {
  for (const denial of ["No.", "Nahi, main Sakshi nahi hoon", "Wrong number.", "No, this isn't Sakshi."]) {
    const r = await idFirst([denial]);
    assert.equal(r.identityDenied, true, `"${denial}" must leave the gate denied`);
    assert.equal(idAsks(r.spoken), 0, `"${denial}": a denied gate does not ask again`);
  }
});

await test("F2. (A) a genuine denial does not enter the confirmed campaign path — all four consequences", async () => {
  // The words differ; the verdict does not. Every one of these is a
  // denial the gate already understands (section A/D), and not one of
  // them may produce a registration in any of the four places.
  for (const denial of ["No.", "Nahi, main Sakshi nahi hoon", "No, this isn't Sakshi.", "नहीं"]) {
    const c = consequencesOf(DENIED_THEN_YES(denial), true);
    assert.equal(c.outcomeType, "wrong_number", `"${denial}" -> stored outcome`);
    assert.equal(c.primaryReason, "wrong_person", `"${denial}" -> primary reason`);
    assert.equal(c.succeeded, false, `"${denial}" -> succeeded`);
    assert.notEqual(c.primaryReason, "confirmed_at_gate");
    assert.equal(c.disposition, "FINAL_NO", `"${denial}" -> disposition`);
    assert.notEqual(c.disposition, "FINAL_YES");
    assert.equal(c.sheetRow, false, `"${denial}" must not be mirrored to the registrations sheet`);
    assert.notEqual(c.liveVerdict, "FINAL_YES", `"${denial}" must not hang up as a registration`);
  }
});

await test("F3. (B) a genuine confirmation still enters the confirmed path, unchanged", async () => {
  // The other side of F2, and the one that proves the fix is narrow:
  // the identical transcript with the gate CONFIRMED still registers.
  const confirmed = [
    { role: "assistant" as const, text: ID_LINE },
    { role: "user" as const, text: "Yes, this is Sakshi." },
    { role: "assistant" as const, text: GATE_LINE },
    { role: "user" as const, text: "Yes." },
    { role: "assistant" as const, text: "Perfect, your free seat is reserved." },
  ];
  const c = consequencesOf(confirmed, false);
  assert.equal(c.outcomeType, "registered_confirmed");
  assert.equal(c.primaryReason, "confirmed_at_gate");
  assert.equal(c.succeeded, true);
  assert.equal(c.disposition, "FINAL_YES");
  assert.equal(c.sheetRow, true, "a real registration still reaches the sheet");
  assert.equal(c.liveVerdict, "FINAL_YES", "and still ends the call as one");

  // ...and end to end: a confirming turn never sets the denied verdict.
  for (const said of ["Yes.", "Haan ji.", "Speaking.", "Yes, this is Sakshi"]) {
    const r = await idFirst([said]);
    assert.equal(r.identityDenied, false, `"${said}" must not be read as a denial`);
  }
});

await test("F4. (C) unclear stays unclear — it is not a denial, and nothing downstream moves", async () => {
  // The gate re-asks an unclear answer and gives up on the third; it
  // never sets `denied`. Asserted through the pipeline, because that is
  // where the distinction lives, and then downstream, because the whole
  // risk of this fix would be `unclear` quietly becoming a denial.
  for (const said of ["Who is this?", "Kya chahiye?", "Hmm.", "Yes, I can hear you"]) {
    const r = await idFirst([said]);
    assert.equal(r.identityDenied, false, `"${said}" is unclear, not denied`);
  }
  // Three unclear answers end the call (B9/D12) and still do not deny.
  const gaveUp = await idFirst(["Kya chahiye?", "Kaun bol raha hai?", "Hmm."]);
  assert.equal(gaveUp.identityDenied, false, "giving up is not a denial");
  assert.equal(gaveUp.llmRequests, 0, "and it still never reached the model");
});

await test("F5. (D) a later generic 'Yes' cannot override a prior denial", async () => {
  // THE REPORTED SHAPE, in full. The person said they are not Sakshi;
  // everything after that is a conversation with somebody else, and a
  // "Yes." in it is not their agreement to anything.
  const c = consequencesOf(DENIED_THEN_YES("No."), true);
  assert.equal(c.outcomeType, "wrong_number");
  assert.equal(c.disposition, "FINAL_NO");
  assert.equal(c.sheetRow, false);
  assert.notEqual(c.liveVerdict, "FINAL_YES");

  // ...and the Hinglish twin, where the gate yes is "Haan ji" — the
  // single commonest yes on these calls.
  const hinglish = [
    { role: "assistant" as const, text: ID_LINE },
    { role: "user" as const, text: "Nahi, main Sakshi nahi hoon." },
    { role: "assistant" as const, text: GATE_LINE },
    { role: "user" as const, text: "Haan ji." },
    { role: "assistant" as const, text: "Perfect, your free seat is reserved." },
  ];
  const h = consequencesOf(hinglish, true);
  assert.equal(h.outcomeType, "wrong_number");
  assert.equal(h.disposition, "FINAL_NO");
  assert.equal(h.sheetRow, false);
  assert.notEqual(h.liveVerdict, "FINAL_YES");

  // The repository's flow has no branch that re-opens a denied gate —
  // `handleIdentityGate` returns early on `denied` for the rest of the
  // call — so there is no permitted way for this to be overridden, and
  // the pipeline agrees: the gate is still denied after the later yes.
  const r = await idFirst(["No.", "Yes, this is Sakshi", "Yes."]);
  assert.equal(r.identityDenied, true, "no later turn re-opens a denied gate");
  assert.equal(idAsks(r.spoken), 0, "and it is never asked again");
});

await test("F6. THE DEFECT ITSELF: the same transcript WITHOUT the verdict is what it always was", async () => {
  // The proof that nothing in the classifier moved except the new
  // input. With the gate's verdict absent — every non-campaign caller,
  // every re-scoring of a stored row, every call whose gate confirmed
  // or stayed unclear — this transcript still classifies exactly as it
  // did before the fix existed, defect and all.
  const before = consequencesOf(DENIED_THEN_YES("No."), false);
  assert.equal(before.outcomeType, "registered_confirmed", "unchanged when nothing is passed");
  assert.equal(before.primaryReason, "confirmed_at_gate");
  assert.equal(before.disposition, "FINAL_YES");
  assert.equal(before.sheetRow, true);
});

await test("F7. the live hangup and the stored outcome cannot disagree", async () => {
  // Both readings are made from the same two facts — the transcript and
  // the gate's verdict — so a call can never hang up as a registration
  // and then be stored as a wrong number.
  const turns = DENIED_THEN_YES("No.");
  const c = consequencesOf(turns, true);
  assert.equal(c.liveVerdict === "FINAL_YES", c.sheetRow, "hangup and sheet agree");
  assert.equal(c.liveVerdict === "FINAL_YES", c.disposition === "FINAL_YES", "hangup and disposition agree");
});

await test("F8. compliance still outranks it", async () => {
  // A person who says they are not Sakshi AND asks never to be called
  // again is an opt-out, exactly as before: the new rule sits UNDER the
  // compliance rule, so a do-not-call request cannot be relabelled by it.
  const optOut = [
    { role: "assistant" as const, text: ID_LINE },
    { role: "user" as const, text: "No. Do not call me again." },
  ];
  const c = consequencesOf(optOut, true);
  assert.equal(c.outcomeType, "do_not_call");
  assert.equal(c.primaryReason, "opt_out");
  assert.equal(c.disposition, "FINAL_NO");
});

await test("F9. a call with NO identity gate is untouched", async () => {
  // Every non-campaign session and every script that does not require a
  // name: the gate never exists, the verdict is never true, and the
  // classification is the one it always was.
  const r = await run(["Hello"], { identityLine: "" });
  assert.equal(r.identityDenied, false, "no gate, no denial");
  assert.equal(r.llmRequests, 1, "and no change to the call");
});

'''

s = s.replace(anchor, SECTION.replace("\n", NL).lstrip("\r\n") + NL + anchor, 1)
io.open(p, "w", encoding="utf-8", newline="").write(s)
print("ok")
