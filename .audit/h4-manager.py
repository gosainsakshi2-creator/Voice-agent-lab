import io
p = "src/core/session/voice-session-manager.impl.ts"
s = io.open(p, encoding="utf-8", newline="").read()

anchor = """  armScriptedClosing(sessionId: SessionId): boolean {
    const pipeline = this.pipelines.get(sessionId);
    if (!pipeline) return false;
    pipeline.armScriptedClosing();
    return true;
  }
"""
assert s.count(anchor) == 1, s.count(anchor)

new = anchor + """
  /**
   * ADDITIVE, NOT PART OF `VoiceSessionManager`. Read-only companion to
   * `getTranscript` above: did the identity gate conclude that the
   * person on this line is NOT the person we called?
   *
   * Exposes state that already exists — `ConversationPipeline`'s own
   * `denied` gate verdict — so the campaign layer can stop a call whose
   * identity was denied from being read back out of the transcript as a
   * registration. It writes nothing, speaks nothing and changes nothing
   * about STT, turn detection, barge-in or playback.
   *
   * A session with no pipeline (not yet connected, or already gone)
   * reports `false`, which is exactly the behaviour every caller had
   * before this accessor existed.
   */
  identityDenied(sessionId: SessionId): boolean {
    const pipeline = this.pipelines.get(sessionId);
    if (!pipeline) return false;
    return pipeline.identityDenied();
  }
"""
s = s.replace(anchor, new, 1)
io.open(p, "w", encoding="utf-8", newline="").write(s)
print("ok")
