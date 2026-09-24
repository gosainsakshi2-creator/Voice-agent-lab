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
# M5 — the generic fallback greeting is not a campaign line
# ─────────────────────────────────────────────────────────────────
#
# One helper, read at the three existing call sites. It introduces no
# copy: it decides between the line that is already there and the
# behaviour the pipeline already has for a generation it cannot use.
sub(
    block([
        "  /** True if `responseId` was cancelled by a barge-in while in flight. */",
    ]),
    block([
        "  /**",
        "   * The generic fallback greeting, or nothing, for a reply the model",
        "   * produced but the pipeline refuses to speak (prompt echo — see",
        "   * `isContaminatedOutput`).",
        "   *",
        "   * WHY THIS IS A ROUTING DECISION AND NOT A NEW LINE. \"Hey! How can",
        "   * I help you today?\" is an INBOUND assistant's opening. On a",
        "   * campaign call it is wrong three times over: the agent has",
        "   * already introduced itself and said why it called, the campaign",
        "   * is outbound so there is nothing the caller rang up about, and it",
        "   * hands the floor to them in the middle of an approved script. It",
        "   * is reachable there — `contaminated` is evaluated on the",
        "   * streaming path, which is the path both configured providers",
        "   * take (audit M5).",
        "   *",
        "   * The campaign-aware behaviour for a generation that cannot be",
        "   * used ALREADY EXISTS and is one branch away: an empty generation",
        "   * is not spoken, not committed, and not replaced by a placeholder",
        "   * (see the `empty_response` branch in the main loop — \"no",
        "   * placeholder, no apology, no fallback line\"). A contaminated",
        "   * generation is the same thing: output the pipeline will not put",
        "   * in the agent's mouth. So on a campaign call it takes that path,",
        "   * and the caller's turn stays unanswered until the silence window",
        "   * or a held position picks the call back up.",
        "   *",
        "   * Every non-campaign session — the lab, the dashboard demo, the",
        "   * inbound scenarios the line was written for — keeps it verbatim.",
        "   * No new copy, no change to the pickup greeting, and nothing about",
        "   * `isContaminatedOutput` or the retry moves.",
        "   */",
        "  private contaminationFallbackFor(): string {",
        "    if (this.record.request.campaign !== undefined) return \"\";",
        "    return fallbackGreeting(this.record.memory.currentLanguage);",
        "  }",
        "",
        "  /** True if `responseId` was cancelled by a barge-in while in flight. */",
    ]),
)

# streaming path
sub(
    "      const fallback = fallbackGreeting(this.record.memory.currentLanguage);",
    "      const fallback = this.contaminationFallbackFor();",
)
# batch path, both branches
sub(
    block([
        "            console.warn(`[LLM:${sid}] Retry also contaminated — using fallback`);",
        "            spokenContent = fallbackGreeting(this.record.memory.currentLanguage);",
    ]),
    block([
        "            console.warn(`[LLM:${sid}] Retry also contaminated — using fallback`);",
        "            spokenContent = this.contaminationFallbackFor();",
    ]),
)
sub(
    block([
        "          console.warn(`[LLM:${sid}] Retry failed — using fallback`);",
        "          spokenContent = fallbackGreeting(this.record.memory.currentLanguage);",
    ]),
    block([
        "          console.warn(`[LLM:${sid}] Retry failed — using fallback`);",
        "          spokenContent = this.contaminationFallbackFor();",
    ]),
)

# ─────────────────────────────────────────────────────────────────
# M8 — non-qualifying speech must not grant progress
# ─────────────────────────────────────────────────────────────────
sub(
    block([
        "      // A bare \"haan ji\"/\"ji\"/\"Hi.\" — an answer or a pickup, not a",
        "      // hearing problem. The contextual path (and the classifier) see",
        "      // it exactly as today.",
        "      this.hearingLinesWithoutProgress = 0;",
        "      return false;",
    ]),
    block([
        "      // A bare \"haan ji\"/\"ji\"/\"Hi.\" — an answer or a pickup, not a",
        "      // hearing problem. The contextual path (and the classifier) see",
        "      // it exactly as today.",
        "      //",
        "      // ── AND IT IS NOT PROGRESS EITHER ────────────────────────────",
        "      //",
        "      // The counter used to be RESET here. The contract it keeps is",
        "      // stated at `MAX_HEARING_LINES_WITHOUT_PROGRESS`: it is reset",
        "      // \"by any turn that is not answered with a fixed line — i.e. by",
        "      // the caller contributing something meaningful\". Nothing",
        "      // meaningful reaches this line. Every turn that does was already",
        "      // taken by the real-contribution branch at the top of this",
        "      // method, which resets the counter and is untouched; what is",
        "      // left here is a turn `isCheck` accepted as a presence check and",
        "      // that merely failed to QUALIFY for an acknowledgement — a",
        "      // single bare \"Hello.\" out of a clear sky.",
        "      //",
        "      // Resetting on that let an alternating pattern run forever: one",
        "      // non-qualifying \"Hello.\" cleared the counter, the next",
        "      // qualifying check spent a line, and the cap was never reached",
        "      // (audit M8). Leaving it alone is the whole change — the",
        "      // counter is not incremented here either, because no fixed line",
        "      // is spoken on this path, and the cap and its value are",
        "      // untouched.",
        "      return false;",
    ]),
)

# ─────────────────────────────────────────────────────────────────
# M12 — an absorbed backchannel's late final is still absorbed
# ─────────────────────────────────────────────────────────────────
sub(
    block([
        "            continue;",
        "          }",
        "          this.backchannelInFlight = false;",
    ]),
    block([
        "            continue;",
        "          }",
        "          // ── THE SAME UTTERANCE, ONE EVENT LATER ────────────────────",
        "          //",
        "          // `spokeOverTheAssistant` is false the moment `drainPlayback`",
        "          // leaves SPEAKING — and a Deepgram final lands 0.4-1.7s after",
        "          // the words (`endpointing=400`, `utterance_end_ms=1000`), so",
        "          // the final of an \"okay\" absorbed as a backchannel routinely",
        "          // arrives AFTER the reply has finished playing. The branch",
        "          // above therefore did not see it, the line below cleared the",
        "          // one piece of state that remembered the absorption, and the",
        "          // utterance the pipeline had deliberately decided was NOT a",
        "          // contribution was fed to the turn detector — becoming a user",
        "          // turn, a language-model request and a signal the outcome",
        "          // classifier reads (audit M12).",
        "          //",
        "          // `backchannelInFlight` is that existing decision, and it is",
        "          // already scoped exactly right: it is set only by the branch",
        "          // above, only while the assistant was speaking, only for an",
        "          // utterance with no content of its own — and `enterSpeaking`",
        "          // clears it per reply so it can never carry into the next one.",
        "          // The only thing missing was reading it before it is thrown",
        "          // away.",
        "          //",
        "          // NARROW BY THE SAME VOCABULARY, NOT A NEW ONE. It absorbs",
        "          // the FINAL that closes that utterance, and only while the",
        "          // whole utterance is still nothing but an acknowledgement:",
        "          // `isBareAcknowledgement` is the same predicate the branch",
        "          // above used, over the same pending-plus-this-segment text.",
        "          // A caller who carries on — \"ok, but what is the price?\" —",
        "          // fails it on the segment that carries the content and is",
        "          // handled exactly as it is today. No timer, no threshold, no",
        "          // new state.",
        "          if (this.backchannelInFlight && segment.isFinal) {",
        "            const pending = this.record.turnDetector.getPendingTurnText();",
        "            const utterance =",
        "              pending.length > 0 ? `${pending} ${segment.text}` : segment.text;",
        "            if (isBareAcknowledgement(utterance)) {",
        "              this.backchannelInFlight = false;",
        "              this.record.liveUserTranscript = \"\";",
        "              // eslint-disable-next-line no-console",
        "              console.log(",
        "                `[TURN:${this.record.id}] absorbed backchannel's late final ignored (it was already judged not a contribution): \"${segment.text.trim()}\"`,",
        "              );",
        "              continue;",
        "            }",
        "          }",
        "          this.backchannelInFlight = false;",
    ]),
)

io.open(p, "w", encoding="utf-8", newline="").write(s)
print("M5 / M8 / M12 patch applied")
