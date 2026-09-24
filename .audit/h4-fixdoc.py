import io

p = "src/core/session/conversation-pipeline.ts"
s = io.open(p, encoding="utf-8", newline="").read()
NL = "\r\n"

# The block currently reads:
#   /** ...armScriptedClosing doc... */
#   /** ...identityDenied doc... */
#   identityDenied() {...}
#
#   armScriptedClosing(): void {
#
# Move the identityDenied doc+method ABOVE the armScriptedClosing doc, so
# each doc comment sits on its own method again.

start_marker = "  /**\r\n   * ADDITIVE, READ-ONLY. Did the person on this line say they are NOT"
end_marker = "  identityDenied(): boolean {\r\n    return this.identityState === \"denied\";\r\n  }\r\n\r\n"

i = s.index(start_marker)
j = s.index(end_marker) + len(end_marker)
block = s[i:j]
s = s[:i] + s[j:]

armdoc = "  /**\r\n   * ADDITIVE. The campaign layer has established that this call's"
k = s.index(armdoc)
s = s[:k] + block + s[k:]

io.open(p, "w", encoding="utf-8", newline="").write(s)
print("ok")
