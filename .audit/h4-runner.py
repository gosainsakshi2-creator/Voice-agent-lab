import io
p = "src/campaign/dispatch/call-runner.ts"
s = io.open(p, encoding="utf-8", newline="").read()
NL = "\r\n"

def sub(old, new, count=1):
    global s
    assert s.count(old) == count, (old[:60], s.count(old))
    s = s.replace(old, new, count)

# ── 1. ManagerLike: the optional accessor ──────────────────────────
sub(
    NL.join([
        "  armScriptedClosing?(sessionId: SessionId): unknown;",
        "}",
    ]),
    NL.join([
        "  armScriptedClosing?(sessionId: SessionId): unknown;",
        "  /**",
        "   * OPTIONAL, and read-only. The identity gate's own verdict: the",
        "   * person on the line said they are NOT the person we called.",
        "   * `DefaultVoiceSessionManager` exposes it from the state the",
        "   * pipeline's gate already holds. Optional, and guarded at the call",
        "   * site, so a manager without it behaves exactly as before — it",
        "   * loses the denial, not the call.",
        "   */",
        "  identityDenied?(sessionId: SessionId): boolean;",
        "}",
    ]),
)

# ── 2. the latch, beside `answered` and `transcript` ───────────────
sub(
    NL.join([
        "  let answered = false;",
        "  let transcript: StoredTranscript | undefined;",
    ]),
    NL.join([
        "  let answered = false;",
        "  let transcript: StoredTranscript | undefined;",
        "  /**",
        "   * The identity gate said this is not the person we called.",
        "   *",
        "   * A LATCH, because the gate itself is one: `handleIdentityGate`",
        "   * sets `denied` and never leaves it, so once this is true it stays",
        "   * true even if the session is disposed of before `finalize` reads",
        "   * it. Read by `finalize` — which is why, like `answered` and",
        "   * `transcript`, it lives out here rather than inside the try block",
        "   * — and by the watchdog's live reading, so the label the call hangs",
        "   * up on and the label it is stored with cannot disagree.",
        "   */",
        "  let identityDenied = false;",
    ]),
)

# ── 3. finalize passes it to the classifier ────────────────────────
sub(
    NL.join([
        "      answered,",
        "      transcript,",
        "      // The approved script, so the classifier can also record whether",
        "      // the AGENT stayed on it. Diagnostic only: it changes no label,",
        "      // no disposition and no retry.",
        "      scriptText: script.systemPromptAppendix,",
        "    });",
    ]),
    NL.join([
        "      answered,",
        "      transcript,",
        "      // WHO PICKED UP. The gate's own verdict, carried into the one",
        "      // function every campaign consequence reads — see",
        "      // `ClassifyOutcomeInput.identityDenied`. `false` (the value on",
        "      // every call whose gate confirmed, stayed unclear, or was never",
        "      // asked) changes nothing.",
        "      identityDenied,",
        "      // The approved script, so the classifier can also record whether",
        "      // the AGENT stayed on it. Diagnostic only: it changes no label,",
        "      // no disposition and no retry.",
        "      scriptText: script.systemPromptAppendix,",
        "    });",
    ]),
)

io.open(p, "w", encoding="utf-8", newline="").write(s)
print("ok")
