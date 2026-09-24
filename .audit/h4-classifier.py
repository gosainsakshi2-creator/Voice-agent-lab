import io
p = "src/campaign/outcome/classifier.ts"
s = io.open(p, encoding="utf-8", newline="").read()
NL = "\r\n"

# ── 1. the optional input field ────────────────────────────────────
anchor1 = "  readonly scriptText?: string;\r\n}\r\n"
assert s.count(anchor1) == 1, ("anchor1", s.count(anchor1))
field = NL.join([
    "  readonly scriptText?: string;",
    "  /**",
    "   * ADDITIVE, OPTIONAL. The IDENTITY GATE'S OWN VERDICT: the person",
    "   * on the line said they are not the person we called.",
    "   *",
    "   * Not a reading of the transcript and not a second phrase table —",
    "   * it is `ConversationPipeline`'s `denied` state, produced by",
    "   * `classifyIdentityAnswer` from the one turn that answered the one",
    "   * question \"am I speaking with <name>?\", and carried here by",
    "   * `call-runner.ts` through the manager.",
    "   *",
    "   * WHY IT HAS TO BE CARRIED. This function is the single point all",
    "   * four campaign consequences hang off — the stored outcome, the",
    "   * contact disposition (and therefore the retry planner), the",
    "   * registrations-sheet mirror and the early hangup all read the",
    "   * label it produces. It reads the transcript, and the transcript",
    "   * does not record which sentence was the identity question, so a",
    "   * denial whose words are not in `WRONG_NUMBER` (\"No.\", \"Nahi, main",
    "   * Sakshi nahi hoon\") was invisible here. Rule 4 below then read a",
    "   * later generic \"Haan\" at the commitment question as a",
    "   * registration, and the wrong person got a sheet row and a closed",
    "   * contact.",
    "   *",
    "   * ABSENT OR FALSE, EVERY LABEL THIS FUNCTION PRODUCES IS",
    "   * IDENTICAL. Non-campaign callers, re-scoring of stored rows, and",
    "   * every call whose gate was confirmed, unclear or never asked pass",
    "   * nothing and are unchanged.",
    "   */",
    "  readonly identityDenied?: boolean;",
    "}",
    "",
])
s = s.replace(anchor1, field, 1)

# ── 2. the rule ────────────────────────────────────────────────────
anchor2 = NL.join([
    "  const wrongNumbers = of(\"wrong_number\");",
    "  if (wrongNumbers.length > 0) {",
    "    return build({",
    "      ...shared,",
    "      outcomeType: \"wrong_number\",",
    "      succeeded: false,",
    "      primaryReason: \"wrong_person\",",
    "      confidence: \"medium\",",
    "      explanation: `The person indicated we reached the wrong number (\"${wrongNumbers[0]?.phrase}\").`,",
    "    });",
    "  }",
])
assert s.count(anchor2) == 1, ("anchor2", s.count(anchor2))

rule = NL.join([
    "  // ── 3a. The identity gate already asked, and was told no ────────",
    "  //",
    "  // Placed here, WITH the wrong-number rule and under the compliance",
    "  // rule, because that is what it is: the repository's existing name",
    "  // for \"not the person we were calling\" is `wrong_number` /",
    "  // `wrong_person` (`outcome-types.ts`), its contact-level meaning is",
    "  // already FINAL_NO (`disposition.ts`: \"this number does not reach",
    "  // the intended person\"), and this rule already outranks the",
    "  // commitment gate. No new outcome type, no new reason, no new",
    "  // disposition and no new retry policy — the verdict is simply made",
    "  // visible to the one function every consequence reads.",
    "  //",
    "  // IT OUTRANKS THE GATE AND NOTHING ELSE OUTRANKS IT BUT COMPLIANCE.",
    "  // `opt_out` stays first: somebody who says they are not Sakshi AND",
    "  // asks never to be called again is an opt-out, and a compliance",
    "  // signal a later rule could switch off would not be one.",
    "  //",
    "  // WHAT IT CANNOT DO. It cannot fire on an `unclear` gate — the",
    "  // pipeline re-asks those and gives up on the third, and neither",
    "  // path ever sets `denied`. It cannot fire on a confirmed gate. And",
    "  // it cannot be reached by a call that has no identity gate at all,",
    "  // which is every non-campaign session and every script that does",
    "  // not require a name.",
    "  if (input.identityDenied === true) {",
    "    return build({",
    "      ...shared,",
    "      outcomeType: \"wrong_number\",",
    "      succeeded: false,",
    "      primaryReason: \"wrong_person\",",
    "      confidence: \"high\",",
    "      explanation:",
    "        `The person said they are not the person we called, in answer to the question that asks ` +",
    "        `exactly that, so nothing said afterwards is read as their agreement.`,",
    "    });",
    "  }",
    "",
])
s = s.replace(anchor2, rule + anchor2, 1)

io.open(p, "w", encoding="utf-8", newline="").write(s)
print("ok")
