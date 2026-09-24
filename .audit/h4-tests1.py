import io
p = "src/campaign/tests/identity-gate-tests.ts"
s = io.open(p, encoding="utf-8", newline="").read()
NL = "\r\n"


def sub(old, new, count=1):
    global s
    assert s.count(old) == count, (old[:70], s.count(old))
    s = s.replace(old, new, count)


sub(
    "): Promise<{ spoken: string[]; llmRequests: number; lastUserSentToLlm: string | undefined }> {",
    NL.join([
        "): Promise<{",
        "  spoken: string[];",
        "  llmRequests: number;",
        "  lastUserSentToLlm: string | undefined;",
        "  /** The identity gate's own verdict at the end of the call — see section F. */",
        "  identityDenied: boolean;",
        "}> {",
    ]),
)

sub(
    NL.join([
        "    return {",
        "      spoken: [...h.synthesized],",
        "      llmRequests: h.requests.length,",
        "      lastUserSentToLlm: lastUser?.content.split(\"\\n\").pop(),",
        "    };",
    ]),
    NL.join([
        "    return {",
        "      spoken: [...h.synthesized],",
        "      llmRequests: h.requests.length,",
        "      lastUserSentToLlm: lastUser?.content.split(\"\\n\").pop(),",
        "      identityDenied: h.pipeline.identityDenied(),",
        "    };",
    ]),
)

io.open(p, "w", encoding="utf-8", newline="").write(s)
print("ok")
