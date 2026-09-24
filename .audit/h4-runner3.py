import io
p = "src/campaign/dispatch/call-runner.ts"
s = io.open(p, encoding="utf-8", newline="").read()
NL = "\r\n"

def sub(old, new, count=1):
    global s
    assert s.count(old) == count, (old[:70], s.count(old))
    s = s.replace(old, new, count)

# ── 1. the contained accessor, next to its siblings ────────────────
sub(
    NL.join([
        "/** The same reading, against a live session, contained. */",
        "function liveRegistrationReadingSoFar(",
        "  manager: ManagerLike,",
        "  sessionId: SessionId,",
        "  campaign: CampaignRecord,",
        "): LiveRegistrationReading {",
        "  if (typeof manager.getTranscript !== \"function\") return NO_READING;",
        "  try {",
        "    return liveRegistrationReading(manager.getTranscript(sessionId), campaign.campaignType);",
        "  } catch {",
        "    return NO_READING;",
        "  }",
        "}",
    ]),
    NL.join([
        "/**",
        " * The identity gate's verdict, against a live session, contained the",
        " * same way `pipelineActivityAt` and `agentClosedSoFar` are: a manager",
        " * that does not expose it, or a session that has gone, reports",
        " * `false` — which is exactly the behaviour every call had before the",
        " * accessor existed.",
        " *",
        " * NEVER A HANGUP OF ITS OWN. The verdict is handed to",
        " * `classifyOutcome`, which already ranks \"not the person we were",
        " * calling\" above the commitment gate; what the call then does about",
        " * it is decided by the unchanged rules in `verdictFrom`.",
        " */",
        "function identityDeniedSoFar(manager: ManagerLike, sessionId: SessionId): boolean {",
        "  if (typeof manager.identityDenied !== \"function\") return false;",
        "  try {",
        "    return manager.identityDenied(sessionId) === true;",
        "  } catch {",
        "    return false;",
        "  }",
        "}",
        "",
        "/** The same reading, against a live session, contained. */",
        "function liveRegistrationReadingSoFar(",
        "  manager: ManagerLike,",
        "  sessionId: SessionId,",
        "  campaign: CampaignRecord,",
        "  identityDenied: boolean,",
        "): LiveRegistrationReading {",
        "  if (typeof manager.getTranscript !== \"function\") return NO_READING;",
        "  try {",
        "    return liveRegistrationReading(",
        "      manager.getTranscript(sessionId),",
        "      campaign.campaignType,",
        "      identityDenied,",
        "    );",
        "  } catch {",
        "    return NO_READING;",
        "  }",
        "}",
    ]),
)

io.open(p, "w", encoding="utf-8", newline="").write(s)
print("ok")
