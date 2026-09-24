import io

p = "src/core/session/conversation-pipeline.ts"
s = io.open(p, encoding="utf-8", newline="").read()
NL = "\r\n"


def sub(old, new, count=1):
    global s
    assert s.count(old) == count, (old[:80], s.count(old))
    s = s.replace(old, new, count)


def block(lines):
    return NL.join(lines)


# ─────────────────────────────────────────────────────────────────
# 1. M2 + M4 — the remainder comes from what was actually QUEUED
# ─────────────────────────────────────────────────────────────────
sub(
    "  private cancelledHeardText = \"\";",
    block([
        "  private cancelledHeardText = \"\";",
        "  /**",
        "   * ...and the COMPLEMENT of it, frozen at the same instant: the",
        "   * utterances of this reply that were queued but NOT heard.",
        "   *",
        "   * WHY IT IS RECORDED RATHER THAN DERIVED. The stranded remainder",
        "   * used to be computed as `unspokenTail(assistantText, heard)` —",
        "   * a text match between two strings the formatter produced in two",
        "   * different groupings, and that match is not reliable:",
        "   *",
        "   *   `assistantText` is `toSpokenText(<whole reply>)`, the",
        "   *   formatter run ONCE over everything. What actually played is",
        "   *   `toSpokenText(<sentence>)` per sentence. `formatForSpeech` is",
        "   *   ANCHORED AT THE START of the text it is given, so a sentence",
        "   *   that opens with a discourse filler or a hesitation is",
        "   *   rewritten when it is formatted on its own and left alone when",
        "   *   it is formatted in the middle of the whole reply. The heard",
        "   *   prefix then stops matching at that sentence and",
        "   *   `unspokenTail` returns \"\" — indistinguishable from \"it was",
        "   *   all heard\". Measured 2026-09-23 against the real helpers: a",
        "   *   three-sentence reply whose MIDDLE sentence opens with \"So,\"",
        "   *   or \"Um,\" loses its third sentence entirely, and on the",
        "   *   approved scripts that third sentence is the commitment",
        "   *   question (audit M4).",
        "   *",
        "   * Reading the queued utterances instead removes the comparison",
        "   * altogether: `heardSoFarText` and this are the two halves of ONE",
        "   * list, split at the play head, so they cannot disagree about",
        "   * formatting because they are the same strings.",
        "   *",
        "   * IT ALSO CLOSES M2. Supersession happens only while",
        "   * `speakingSignal === undefined` — before a single sentence has",
        "   * been handed to TTS — so a superseded reply has NO queued",
        "   * utterances and this is \"\". A reply the caller never heard a",
        "   * word of therefore holds no position and can never be spoken",
        "   * back to them as recovery content (audit M2). Under the text",
        "   * match it was the whole reply, and `recoverFromSilence` and the",
        "   * attention RESUME branch would speak it.",
        "   */",
        "  private cancelledUnheardText = \"\";",
    ]),
)

sub(
    block([
        "    this.spokenUtterances = [];",
        "    this.cancelledHeardText = \"\";",
        "    return this.currentResponseId;",
    ]),
    block([
        "    this.spokenUtterances = [];",
        "    this.cancelledHeardText = \"\";",
        "    this.cancelledUnheardText = \"\";",
        "    return this.currentResponseId;",
    ]),
)

sub(
    block([
        "    this.cancelledHeardText = this.heardSoFarText();",
        "    // DIAGNOSTIC ONLY — see `pendingBargeInTrigger`. Stamped at the one",
    ]),
    block([
        "    this.cancelledHeardText = this.heardSoFarText();",
        "    // ...and the rest of it, frozen from the same list at the same",
        "    // instant, so the two halves describe one play head. See",
        "    // `cancelledUnheardText`.",
        "    this.cancelledUnheardText = this.unheardSpokenTail();",
        "    // DIAGNOSTIC ONLY — see `pendingBargeInTrigger`. Stamped at the one",
    ]),
)

# The helper itself, directly after `heardSoFarText`.
sub(
    block([
        "      .map((utterance) => utterance.text)",
        "      .join(\" \")",
        "      .trim();",
        "  }",
    ]),
    block([
        "      .map((utterance) => utterance.text)",
        "      .join(\" \")",
        "      .trim();",
        "  }",
        "",
        "  /**",
        "   * The other side of the play head: the utterances of this reply",
        "   * that were queued and NOT heard, in the exact wording they were",
        "   * queued in.",
        "   *",
        "   * The complement of `heardSoFarText` over the same list, under the",
        "   * negation of the same predicate — so every utterance is in",
        "   * exactly one of the two, and the pair cannot disagree. Playback is",
        "   * sequential, so the heard ones are a prefix and these are the",
        "   * suffix; the sentence the caller was cut off in the middle of",
        "   * counts as unheard and is replayed whole, which is the behaviour",
        "   * `heardSoFarText`'s own round-down already chose.",
        "   *",
        "   * Read-only over state that already exists. No new counter, no new",
        "   * threshold, no second accounting model — see `cancelledUnheardText`",
        "   * for what it replaced and why.",
        "   */",
        "  private unheardSpokenTail(): string {",
        "    if (this.spokenUtterances.length === 0) return \"\";",
        "    const playedMs = this.playedSoFarMs();",
        "    const heardInFull = (utterance: { startsAtMs: number; endsAtMs: number; complete: boolean }) =>",
        "      this.outboundPlaybackStartedAt !== 0 &&",
        "      utterance.complete &&",
        "      utterance.endsAtMs > utterance.startsAtMs &&",
        "      utterance.endsAtMs <= playedMs;",
        "    return this.spokenUtterances",
        "      .filter((utterance) => !heardInFull(utterance))",
        "      .map((utterance) => utterance.text)",
        "      .join(\" \")",
        "      .trim();",
        "  }",
    ]),
)

# The commit site: use the frozen tail instead of the text match.
sub(
    "          strandedRemainder = unspokenTail(result.assistantText, heard);",
    block([
        "          // THE PART THAT WAS QUEUED AND NOT HEARD, from the same list",
        "          // `heard` came from — never a text match between two",
        "          // differently-formatted representations. See",
        "          // `cancelledUnheardText` for the two defects that closes",
        "          // (audit M2 and M4).",
        "          strandedRemainder = this.cancelledUnheardText;",
    ]),
)

# Voicemail: a machine is owed nothing.
sub(
    block([
        "    this.cancelledResponseId = this.currentResponseId;",
        "    this.cancelledHeardText = \"\";",
        "    this.record.bargeIn.triggerBargeIn();",
    ]),
    block([
        "    this.cancelledResponseId = this.currentResponseId;",
        "    this.cancelledHeardText = \"\";",
        "    // A machine is owed no remainder either: nothing of this reply is",
        "    // held for a resume that will never happen. See",
        "    // `cancelledUnheardText`.",
        "    this.cancelledUnheardText = \"\";",
        "    this.record.bargeIn.triggerBargeIn();",
    ]),
)

io.open(p, "w", encoding="utf-8", newline="").write(s)
print("pipeline M2/M4 patch applied")
