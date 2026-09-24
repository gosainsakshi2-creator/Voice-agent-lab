import io

p = "src/core/session/conversation-pipeline.ts"
s = io.open(p, encoding="utf-8", newline="").read()
NL = "\r\n"

anchor = NL.join([
    " * A transcript that is NOT corroborated is treated exactly like a",
    " * backchannel: ignored, so the assistant finishes its sentence. This",
    " * cannot strand a soft-spoken caller, because the whole test only",
    " * applies while the assistant is SPEAKING — every segment that arrives",
    " * while it is LISTENING or THINKING feeds the turn detector completely",
    " * ungated, exactly as before.",
    " */",
])
assert s.count(anchor) == 1, s.count(anchor)

doc = NL.join([
    " * A transcript that is NOT corroborated is treated exactly like a",
    " * backchannel: ignored, so the assistant finishes its sentence. This",
    " * cannot strand a soft-spoken caller, because the whole test only",
    " * applies while the assistant is SPEAKING — every segment that arrives",
    " * while it is LISTENING or THINKING feeds the turn detector completely",
    " * ungated, exactly as before.",
    " *",
    " * ---------------- KNOWN AND ACCEPTED LIMITATION ----------------",
    " *",
    " * SOFT CALLER SPEECH OVER A PLAYING REPLY IS DISCARDED, and there is",
    " * no signal at this layer that can recover it without re-opening the",
    " * false interruption this gate exists to stop. Stated here rather",
    " * than left to be rediscovered:",
    " *",
    " *   WHAT HAPPENS. A caller who speaks QUIETLY over the assistant",
    " *   produces words from the STT and no loud near-end run from the",
    " *   transport, so `lastCallerEnergyAt` is stale, this returns false,",
    " *   and the segment is dropped without a barge-in and without",
    " *   reaching the turn detector. Their interruption is not acted on",
    " *   until the reply ends — at which point they are still talking and",
    " *   everything from there is their turn as usual, so nothing is lost",
    " *   permanently; what is lost is the interruption.",
    " *",
    " *   WHY IT IS NOT SIMPLY FIXED. Every candidate signal was checked",
    " *   against the question \"does this separate a quiet CALLER from a",
    " *   television, a second person in the room, or unrelated room",
    " *   speech?\", and none of them does:",
    " *",
    " *     - the transport's soft threshold (`speechThreshold` /",
    " *       `noteCallerSpeech`) is DELIBERATELY permissive — it is the",
    " *       liveness signal that stops the campaign watchdog hanging up",
    " *       on a soft-spoken caller — and `vad-segmenter.ts` says in as",
    " *       many words that it cannot tell the caller from the room.",
    " *       Admitting it here is the banned change with a different name.",
    " *     - `segment.confidence` is already the second filter here, and",
    " *       it measures the same acoustic quality the energy gate does:",
    " *       quiet near-end speech and distant background speech both",
    " *       score low, so it cannot separate them.",
    " *     - there is no per-speaker signal to fall back on. The leg",
    " *       carries ONE mixed mono channel (measured: `INBOUND",
    " *       (caller)=7116, distinctTrackValues=1`), and `TranscriptSegment`",
    " *       carries no speaker, channel or diarization field.",
    " *     - `isSelfEcho` below separates OUR audio from everything else,",
    " *       which is a different question and already answered.",
    " *",
    " *   WHAT WOULD BE WORSE. Feeding uncorroborated speech to the",
    " *   detector, or lowering either threshold, restores the reported",
    " *   \"a background voice interrupts it and it goes quiet\" behaviour —",
    " *   a television cutting the assistant off mid-sentence for nobody.",
    " *   A missed quiet interruption costs the rest of one reply; a false",
    " *   one costs the reply, the LLM/TTS stream, the whole outbound",
    " *   queue, and re-speaks the block the caller had already heard.",
    " *",
    " *   Read-only audit 2026-09-23 (H7). Closing this needs a signal",
    " *   that does not exist at this layer — near/far discrimination or",
    " *   speaker identity from the transport or the STT — not a rule",
    " *   here.",
    " */",
])

s = s.replace(anchor, doc, 1)
io.open(p, "w", encoding="utf-8", newline="").write(s)
print("ok")
