import io
p = "src/campaign/dispatch/call-runner.ts"
s = io.open(p, encoding="utf-8", newline="").read()
NL = "\r\n"

def sub(old, new, count=1):
    global s
    assert s.count(old) == count, (old[:70], s.count(old))
    s = s.replace(old, new, count)

# ── 1. classifySafely signature + pass-through ─────────────────────
sub(
    NL.join([
        "  transcript: StoredTranscript | undefined;",
        "  scriptText?: string;",
        "}): OutcomeClassification | undefined {",
    ]),
    NL.join([
        "  transcript: StoredTranscript | undefined;",
        "  scriptText?: string;",
        "  /** The identity gate's verdict — see `ClassifyOutcomeInput.identityDenied`. */",
        "  identityDenied?: boolean;",
        "}): OutcomeClassification | undefined {",
    ]),
)
sub(
    NL.join([
        "      transcript: input.transcript?.turns ?? [],",
        "      failureReason: input.failureReason,",
        "      ...(input.scriptText !== undefined ? { scriptText: input.scriptText } : {}),",
    ]),
    NL.join([
        "      transcript: input.transcript?.turns ?? [],",
        "      failureReason: input.failureReason,",
        "      ...(input.identityDenied === true ? { identityDenied: true } : {}),",
        "      ...(input.scriptText !== undefined ? { scriptText: input.scriptText } : {}),",
    ]),
)

# ── 2. the watchdog reads it on every tick, and latches ────────────
sub(
    NL.join([
        "          // Read-only — see `liveRegistrationReadingSoFar`.",
        "          const live = liveRegistrationReadingSoFar(manager, sessionId as SessionId, campaign);",
    ]),
    NL.join([
        "          // Read-only — see `liveRegistrationReadingSoFar`.",
        "          //",
        "          // WHO PICKED UP, FIRST. The gate's verdict is read before the",
        "          // live reading that consumes it, and latched, so the early",
        "          // hangup and the stored outcome are produced from the same",
        "          // fact. Contained: a manager without the accessor, or a",
        "          // session that has gone, leaves it exactly as it was.",
        "          identityDenied = identityDenied || identityDeniedSoFar(manager, sessionId as SessionId);",
        "          const live = liveRegistrationReadingSoFar(",
        "            manager,",
        "            sessionId as SessionId,",
        "            campaign,",
        "            identityDenied,",
        "          );",
    ]),
)

# ── 3. and once more where the transcript is captured, so a denial
#       on the very last turn cannot be missed by the tick spacing.
sub(
    NL.join([
        "    transcript = captureTranscript(manager, sessionId);",
    ]),
    NL.join([
        "    transcript = captureTranscript(manager, sessionId);",
        "    // The same read as the watchdog's, taken once more at the same",
        "    // instant the transcript is: a denial on the very last turn of the",
        "    // call can land between two 500ms ticks, and the stored outcome",
        "    // must not depend on which. The manager keeps ended sessions in",
        "    // memory, so this reads state that already exists (see",
        "    // `captureTranscript` above). Latched, so it can only ever add the",
        "    // verdict, never withdraw one already seen.",
        "    identityDenied = identityDenied || identityDeniedSoFar(manager, sessionId as SessionId);",
    ]),
)

io.open(p, "w", encoding="utf-8", newline="").write(s)
print("ok")
