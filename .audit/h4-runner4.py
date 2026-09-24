import io
p = "src/campaign/dispatch/call-runner.ts"
s = io.open(p, encoding="utf-8", newline="").read()
NL = "\r\n"

def sub(old, new, count=1):
    global s
    assert s.count(old) == count, (old[:70], s.count(old))
    s = s.replace(old, new, count)

# ── 1. definitiveAnswerIn keeps its signature and gains the optional
#       verdict, defaulted so every existing caller is byte-identical.
sub(
    NL.join([
        "export function definitiveAnswerIn(",
        "  turns: readonly ConversationTurn[],",
        "  campaignType: string,",
        "): \"FINAL_YES\" | \"FINAL_NO\" | undefined {",
        "  return liveRegistrationReading(turns, campaignType).verdict;",
        "}",
    ]),
    NL.join([
        "export function definitiveAnswerIn(",
        "  turns: readonly ConversationTurn[],",
        "  campaignType: string,",
        "  /**",
        "   * ADDITIVE, OPTIONAL — the identity gate's own verdict. Omitted",
        "   * (every existing caller, and every call whose gate confirmed,",
        "   * stayed unclear or was never asked) this reads exactly as it",
        "   * always has.",
        "   */",
        "  identityDenied = false,",
        "): \"FINAL_YES\" | \"FINAL_NO\" | undefined {",
        "  return liveRegistrationReading(turns, campaignType, identityDenied).verdict;",
        "}",
    ]),
)

# ── 2. liveRegistrationReading threads it into the one classifier call
sub(
    NL.join([
        "export function liveRegistrationReading(",
        "  turns: readonly ConversationTurn[],",
        "  campaignType: string,",
        "): LiveRegistrationReading {",
        "  if (turns.length === 0) return NO_READING;",
        "",
        "  const stored = toStoredTranscript(turns);",
        "  const classification = classifyOutcome({",
        "    campaignType,",
        "    // The conversation is over as far as this reading is concerned: the",
        "    // same two values `finalize` passes for a completed call.",
        "    status: \"COMPLETED\",",
        "    failureClass: \"COMPLETED\",",
        "    answered: true,",
        "    transcript: stored.turns,",
        "  });",
    ]),
    NL.join([
        "export function liveRegistrationReading(",
        "  turns: readonly ConversationTurn[],",
        "  campaignType: string,",
        "  /**",
        "   * ADDITIVE, OPTIONAL — see `definitiveAnswerIn`. Handed to the",
        "   * classifier so the LIVE reading and the reading `finalize` takes",
        "   * from the finished transcript are made from the same facts; a call",
        "   * must not hang up on a registration it will then be stored as not",
        "   * having.",
        "   */",
        "  identityDenied = false,",
        "): LiveRegistrationReading {",
        "  if (turns.length === 0) return NO_READING;",
        "",
        "  const stored = toStoredTranscript(turns);",
        "  const classification = classifyOutcome({",
        "    campaignType,",
        "    // The conversation is over as far as this reading is concerned: the",
        "    // same two values `finalize` passes for a completed call.",
        "    status: \"COMPLETED\",",
        "    failureClass: \"COMPLETED\",",
        "    answered: true,",
        "    transcript: stored.turns,",
        "    ...(identityDenied ? { identityDenied: true } : {}),",
        "  });",
    ]),
)

io.open(p, "w", encoding="utf-8", newline="").write(s)
print("ok")
