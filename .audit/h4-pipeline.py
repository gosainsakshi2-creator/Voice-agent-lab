import io
p = "src/core/session/conversation-pipeline.ts"
s = io.open(p, encoding="utf-8", newline="").read()

anchor = "  armScriptedClosing(): void {\r\n    if (this.scriptedClosingArmed) return;"
assert s.count(anchor) == 1, s.count(anchor)

new_lines = [
    "  /**",
    "   * ADDITIVE, READ-ONLY. Did the person on this line say they are NOT",
    "   * the person we called?",
    "   *",
    "   * Reports the identity gate's own `denied` verdict — the state",
    "   * `handleIdentityGate` already sets from `classifyIdentityAnswer`",
    "   * and never leaves — and nothing else. No new state, no new counter,",
    "   * no timer, no threshold: one existing field, projected.",
    "   *",
    "   * IT EXISTS BECAUSE THE GATE'S VERDICT STOPPED AT THE GATE. Shutting",
    "   * the gate keeps the IDENTITY question from being reopened, and that",
    "   * is all it ever did. Everything the campaign does with a finished",
    "   * call — the stored outcome, the contact disposition, the retry",
    "   * decision, the registrations sheet and the early hangup — is read",
    "   * back out of the TRANSCRIPT by `classifyOutcome`, which cannot see",
    "   * this verdict and whose own wrong-number table is deliberately",
    "   * narrower than the identity classifier's denials. So a denial the",
    "   * gate understood perfectly (\"No.\", \"Nahi, main Sakshi nahi hoon\")",
    "   * followed by a later generic \"Haan\" at the commitment question",
    "   * settled `confirmed_at_gate` / FINAL_YES — a sheet row, a closed",
    "   * contact and an early hangup, for somebody who had just said they",
    "   * were not the person (reproduced through the real classifier,",
    "   * 2026-09-23).",
    "   *",
    "   * Read by the campaign layer through the manager, contained at the",
    "   * call site exactly as `lastActivityAt` and `getTranscript` are, so a",
    "   * manager or a session without it behaves exactly as before. The",
    "   * pipeline decides nothing downstream with it — it only reports what",
    "   * its own gate already concluded.",
    "   */",
    "  identityDenied(): boolean {",
    "    return this.identityState === \"denied\";",
    "  }",
    "",
    "  armScriptedClosing(): void {",
    "    if (this.scriptedClosingArmed) return;",
]
s = s.replace(anchor, "\r\n".join(new_lines), 1)
io.open(p, "w", encoding="utf-8", newline="").write(s)
print("ok")
