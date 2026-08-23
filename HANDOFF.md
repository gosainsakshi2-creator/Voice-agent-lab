# HANDOFF.md — Current State

> **Paste this whole file into a fresh Claude conversation to resume work.**
> It is deliberately short. Stable project truth lives in [MEMORY.md](MEMORY.md);
> this file only holds *what is happening right now*.

**Updated:** 2026-08-22
**Branch:** `campaign-layer-phase-0` — **working tree DIRTY, nothing committed** (see §5)
**Last commit:** `6329f3e` — Fix greeting interruptions and speech pronunciation
**Dialing:** `CAMPAIGN_DIALING_ENABLED=true` — **real calls are live**

---

## 0. This conversation (2026-08-22) — two production defects, fixed

Both changes are **uncommitted**. Typecheck is clean and every suite below
passes three times in a row. Nothing has been deployed and no call was placed.

### ISSUE 1 — end-to-end voice latency

**Root cause (confirmed, one defect): Deepgram's end-of-speech claim was being
discarded, so every turn it happened on paid ~1.0–1.5s of avoidable wait.**

`speech_final: true` is set on whichever `Results` message Deepgram's endpointer
fires on. When it has already returned every word of the utterance in an earlier
`is_final` message, that message arrives with an **empty transcript** — the words
and the "they have stopped talking" claim come in **two separate messages**.

[deepgram.provider.ts](src/providers/speech-to-text/deepgram.provider.ts) filtered
on transcript text (`if (!alternative?.transcript?.trim()) return;`) and so
dropped the second message whole, `speech_final` included. `TranscriptSegment`
then carried `isSpeechFinal: false` for the entire turn, and
[turn-detection.ts](src/core/session/turn-detection.ts) correctly read that as a
**chunk boundary** — a claim about not revising words, never about the caller
having stopped. So a finished, fully punctuated sentence took the slow path:

| Stage | Cost |
|---|---|
| full adaptive silence window | 1100–1600ms |
| chunk-boundary grace (`CHUNK_BOUNDARY_GRACE_MS`) | 700ms |
| post-speech confirmation | 300–550ms |
| **total, after the words had already landed** | **2100–2850ms** |

instead of the single confirmation window (300–600ms) that the existing
`isCompleteThought()` fast path gives an endpointed turn. On top of Deepgram's
own delivery lag that is the production `stt-to-release ≈ 3880ms`.

**Exact change.** Carry the claim through as a *marker*, never as a transcript:

1. `TranscriptSegment` gains an optional `isEndOfSpeechMarker?: boolean`
   (additive only — no existing signature changed).
2. The Deepgram adapter emits that marker when a `Results` message has an empty
   transcript **and** `is_final && speech_final`. No recognition parameter was
   touched: this reads a field the socket was already delivering.
3. `AdaptiveTurnDetector.noteEndOfSpeech()` records `lastFinalWasEndpoint = true`
   and — **only** for the exact class `feed` already releases early (endpointed,
   interim-free, complete thought, and only while the long silence window is the
   one armed) — re-arms to one `CONFIRMATION_WINDOW_MS`. It never touches
   `pendingFinalText`, `lastFinalEndedAtMs`, `turnStartedAtMs` or
   `lastSegmentAtMs`, so the turn clock does not restart and `endedAtMs: 0` is
   never measured as an inter-final gap.
4. `ConversationPipeline.startContinuousStt` routes a marker to
   `noteEndOfSpeech()` and `continue`s — before the display preview, the
   recognition-lag metric, the STT stream clock, the backchannel gate and the
   near-end-energy corroboration gate.

**No threshold, window, grace or margin was changed.** Every other release class
— mid-thought, unpunctuated, filler, hold phrase, outstanding interim — keeps
exactly the timing it had. Measured saving on the affected turn: **≥900ms**,
asserted end to end through the real pipeline (`test:end-of-speech` B2).

**What was investigated and found NOT to be a bug** (deliberately unchanged):

- **`playback drain` of 4–10s is not dead air.** `drainPlayback` waits
  `outboundQueuedMs − elapsed`, and `outboundQueuedMs` is the true duration of
  the synthesized audio (`estimateAudioSeconds` over an honest `sampleRateHz`;
  the mu-law path emits exactly 8000 bytes/s and the pump sends 160 bytes per
  20ms, so it is real time). A 9.4s drain means the agent spoke for 9.4s. That
  is the direct, intended consequence of the v3 script's "a block is what you say
  in one turn" instruction. Shortening it is a **script/prompt** decision, not a
  pipeline one.
- **`audio-queued ≈ 2.4–2.6s` after turn release** decomposes as: LLM
  first token ~1.0s → ~0.3–0.5s for the stream to reach the first cut point
  (`MIN_FIRST_CHUNK_LENGTH` 40 chars **and** a sentence boundary) → **~1.1–1.3s
  of Cartesia batch synthesis** before a single byte is queued. The chunker
  thresholds are deliberately tuned against batch-TTS seams (see the long
  rationale in [sentence-chunker.ts](src/core/session/sentence-chunker.ts)) and
  were left alone. **The remaining single largest cost is that Cartesia has no
  `synthesizeStream` — see §3.6.**

### ISSUE 2 — the call does not hang up after the conversation ends

**Root cause: there was no end-of-call reading keyed on the AGENT having
closed.** The campaign watchdog's only agent-initiated ending is
`definitiveAnswerIn` in [call-runner.ts](src/campaign/dispatch/call-runner.ts),
which runs the real classifier over the live transcript and fires on a FINAL_YES
at the gate or an *unmistakable* FINAL_NO. Every other way a conversation ends —
the classifier's `unclear`, `affirmative_not_at_gate`, `callback_requested`,
`interested_not_confirmed` — produced no verdict, so nothing ended the call.
"Thanks for your time, take care." classifies as `affirmative_not_at_gate`, so
the line was held open until `maxSilenceSeconds` (20s), and a person offering one
more pleasantry re-armed it.

**Exact change — the existing path reused, not a new mechanism.** A second
read at the same watchdog decision point, checked **after**
`definitiveAnswerSoFar`, returning through the same `finalize(...)`:

- `agentClosedIn(turns)` — exported, pure, never throws. Four guards:
  1. the **last turn must be the agent's** — the pipeline commits an assistant
     turn only after `drainPlayback`, so this *is* the moment the closing
     finished playing, and a caller mid-utterance (whose partial
     `getTranscript` appends) blocks it;
  2. the **person must have said something** — an agent-only transcript is a
     machine or a dead line;
  3. the turn must **end on** a sign-off, not merely contain one, and be
     ≤12 words — this is what separates "Thanks for your time, take care."
     from "Just take care to join a few minutes early…";
  4. the turn must **ask nothing** (`?` on the raw text).
- New verdict `AGENT_CLOSED` → `finalize("COMPLETED", …, "observed",
  "agent_hangup:closing")`. `finalize` re-reads the finished transcript exactly
  as for any other completed call, so the outcome label, disposition, retry
  decision and registrations-sheet row are produced by **unchanged** code.

FINAL_YES / FINAL_NO are read **first** and still name their own hangup —
asserted in `test:agent-hangup` C1/C2, including a refusal whose closing line
*also* satisfies `agentClosedIn`.

---

## 1. What was completed before this conversation

| Commit | What landed |
|---|---|
| `6329f3e` | Greeting no longer self-interrupts; speech pronunciation fixes |
| `3d4bd16`, `03b1707`, `f43c5be` | Vobiz call recording; voicemail-detection scaffold; barge-in accuracy suite; VAD segmenter and both media bridges reworked |
| `a66b156` | Conversation continuity — stale replies no longer emitted after a barge-in |

Phase notes: [Phase 1](docs/phases/PHASE1_VOICE_SESSION_MANAGER_NOTES.md),
[Phase 6](docs/phases/PHASE6_PRODUCTION_READINESS.md). Phases 2–10 are the
campaign layer (see the `test:phase*` scripts in `package.json`).

---

## 2. In progress

- **Nothing is mid-edit, but the tree is dirty and uncommitted** (§5). Review,
  then commit — no commit was made by request.
- The live campaign is on the **pilot ladder at rung 1 (10 calls)** —
  `CAMPAIGN_STAGE_MAX_CALLS=10`.

---

## 3. Pending

| # | Item | Blocked on |
|---|---|---|
| 1 | Commit the two fixes in §0 and roll them to production | Review |
| 2 | Raise `CAMPAIGN_STAGE_MAX_CALLS` past 10 and advance the pilot ladder | Phase 6 §H gates green for the current rung |
| 3 | Caller-ID / DID rotation | **External:** the DID list from Vobiz + whether `from` can be set per call |
| 4 | AMD / voicemail detection | Design decision — minimal additive proposal in Phase 6 §E, not implemented |
| 5 | Auto-resume after a run stops | Not started; one of the two real blockers on 2,000-call days |
| 6 | **Streaming TTS for Cartesia** — the largest remaining latency item | Decision. See below |
| 7 | Reply LENGTH is what the 4–10s drain measures | Script/prompt decision, not code |

**§3.6 in detail.** Time-to-first-audio after turn release is ~2.4–2.6s, of which
**~1.1–1.3s is Cartesia's batch `synthesize()` round trip** — the whole first
chunk must be generated before one byte can be queued. ElevenLabs and Sarvam
already implement the optional `synthesizeStream`; Cartesia does not, so it takes
the batch branch in `synthesizeAndPlay`. Adding `synthesizeStream` to
[cartesia.provider.ts](src/providers/text-to-speech/cartesia.provider.ts) is
purely additive (an optional interface member, which the binding constraint in
§4.3 explicitly permits) and the pipeline already branches on its presence, so no
orchestration changes. Expected saving ~0.8–1.0s per turn. **NOT done in this
pass** — it cannot be verified without live Cartesia credentials and a real call,
and "TTS provider configuration" is a protected system.

---

## 4. Important decisions carried forward

Binding constraints are in [MEMORY.md §4](MEMORY.md) and
[docs/DECISIONS.md](docs/DECISIONS.md). The four that most often catch people:

1. **Concurrency stays at 3.** Vobiz's confirmed ceiling; above it the carrier
   tears down live conversations.
2. **Load guardrails refuse a run, they do not clamp it.** Never widen a limit to
   make something pass.
3. **Provider interfaces only ever gain optional members.** Never change an
   existing signature. (`TranscriptSegment.isEndOfSpeechMarker` in §0 follows
   this; so would §3.6.)
4. **Re-wording a script requires updating `COMMIT_ANCHORS`** in
   [classifier.ts](src/campaign/outcome/classifier.ts), or FINAL_YES detection
   dies silently. The same now applies to `AGENT_CLOSINGS` in
   [call-runner.ts](src/campaign/dispatch/call-runner.ts): a re-worded closing
   line that is not in that table means the call is not hung up, and falls back
   to the silence window — degraded, never wrong.

---

## 5. Files changed this conversation (ALL UNCOMMITTED)

```
M  src/types/provider.types.ts                        +23  optional isEndOfSpeechMarker
M  src/providers/speech-to-text/deepgram.provider.ts  +39/-1  forward the standalone endpoint
M  src/core/session/turn-detection.ts                 +42  noteEndOfSpeech()
M  src/core/session/conversation-pipeline.ts          +21  route the marker, and nothing else
M  src/campaign/dispatch/call-runner.ts              +145  agentClosedIn + AGENT_CLOSED verdict
M  package.json                                        +2  two new test scripts
A  src/campaign/tests/end-of-speech-tests.ts               17 tests
A  src/campaign/tests/agent-hangup-tests.ts                16 tests
```

Nothing else under `src/` was touched. No config, env, script, migration or
docs file was modified.

---

## 6. Test results

`npx tsc --noEmit --incremental false` — **clean** (before and after).

Every suite run **3×**, all green, no flakes:

| Suite | Result |
|---|---|
| `test:end-of-speech` **(new)** | 17 passed, 0 failed |
| `test:agent-hangup` **(new)** | 16 passed, 0 failed |
| `test:barge-in` | 27 passed, 0 failed |
| `test:continuity` | 28 passed, 0 failed |
| `test:pronunciation` | 21 passed, 0 failed |
| `test:turn-release` | 14 passed, 0 failed |
| `test:speaking-watchdog` | 6 passed, 0 failed |
| `test:stt-clock` | 10 passed, 0 failed |
| `test:phase8` / `test:phase9` / `test:phase10` | 19 / 20 / 12 passed, 0 failed |

**What the two new suites actually assert**

`test:end-of-speech`
- A1/A1c/A1d — the marker releases an endpointed complete thought on the
  confirmation window; **≥900ms saved**, measured against the same turn without it.
- A1b — the defect itself, measured: no marker ⇒ silence + chunk grace + confirmation.
- A2–A2f — **what must not get faster**: mid-thought, unpunctuated, outstanding
  interim, filler, hold phrase, and a confirmation window already running.
- A3/A3b — a marker with nothing held is inert, and never moves the adaptive threshold.
- B1–B5 — through the **real pipeline**: the marker never becomes a turn, never
  triggers a barge-in (a 5-marker storm mid-reply), never discards playback, never
  reaches the display preview, and never splits one utterance into two turns.
  Normal TTS playback still completes and the whole block is still committed.

`test:agent-hangup`
- F1–F6 — the phrase table and the four guards, with no DB: sign-offs close,
  mid-conversation "take care" does not, a question never closes, a bare courtesy
  never closes, a talking caller blocks it, an agent-only transcript never closes.
- A1–A3 — the reported production ending now hangs up as `agent_hangup:closing`,
  `end()` is never called in SPEAKING, the hangup is **after** the closing was
  committed, and within one watchdog tick rather than a silence window later.
- B1/B2 — mid-conversation closing phrase, and a closing followed by a question:
  both still end on `watchdog:max_silence`.
- C1/C2 — FINAL_YES and FINAL_NO unchanged, **including** a refusal whose closing
  line also satisfies `agentClosedIn` (the ordering assertion).
- D1 — a remote/manual hangup still ends as `remote_hangup`, and the watchdog does
  not call `end()` on a session that ended itself.
- E1/E2 — voicemail untouched: a machine, and an agent-only transcript ending in a
  sign-off, both still end on the silence window.

**Protected systems verified unchanged** — no file touched, and the suite that
covers each is green:

Deepgram request parameters (`endpointing`, `interim_results`, `smart_format`,
`model`, `language`) · every turn-detection threshold, window and grace ·
barge-in/interruption thresholds · background-voice corroboration
(`NEAR_END_SPEECH_*`, `interruptionCorroborated`) · both media bridges ·
`vad-segmenter.ts` · `audio-codec.ts` · TTS provider configuration · LLM
configuration · campaign scripts and `COMMIT_ANCHORS` · conversation
memory/continuity · FINAL_YES / FINAL_NO classification · Google Sheets ·
voicemail detection · recording · the silence/duration watchdogs · concurrency ·
the dispatcher and retry planner.

---

## 7. Current errors / known issues

**Open product blockers**

- **Single caller ID for every call.** Runs above 500 calls per DID are BLOCKED
  by readiness check 8.
- **No AMD.** A voicemail is scored as a normal answered call.
- **No auto-resume.** A stopped run must be restarted by hand.

**Remaining latency, after the §0 fix**

- ~1.1–1.3s of Cartesia batch synthesis on the first chunk of every turn (§3.6).
- The 4–10s "playback drain" is the agent genuinely speaking; it is a reply-length
  question (§3.7), not a pipeline one.
- The §0 fix helps **only** on turns where Deepgram splits the words and the
  endpoint across two messages. A turn where `speech_final` already rode on the
  words was on the fast path before and is unchanged.

**Environment traps (not bugs in your change)**

- Campaign tests fail ~3 assertions while `CAMPAIGN_DIALING_ENABLED=true`. Turn
  it off for the test run.
- `npm run typecheck` can pass on a file that does not parse — stale
  `tsconfig.tsbuildinfo`. Use `npx tsc --noEmit --incremental false`.
- `.env.local` multi-line values truncate silently; duplicate keys are last-win.
- `test:agent-hangup` and `test:speaking-watchdog` need `DATABASE_URL`; the first
  skips its live sections without one, the second skips entirely.

---

## 8. Exact next steps

1. Read [MEMORY.md](MEMORY.md), then this file. Do not re-derive the
   architecture — it is already written down.
2. **Review and commit §5.** `git status && git diff` first; nothing is committed.
3. Validate on a real call: watch for `[TIMING:…] stt-to-release=` (expect it to
   drop by ~1s where Deepgram splits the endpoint) and for
   `hangup_reason = 'agent_hangup:closing'` on calls that used to end on
   `watchdog:max_silence`.
4. Then decide the next thread: **Cartesia streaming TTS (§3.6)** is the largest
   remaining latency item; **pilot ladder (§3.2)**, **DID rotation (§3.3, needs
   Vobiz info first)** and **auto-resume (§3.5)** are the others.
5. Before any run that dials: `npm run preflight:prod -- <campaignId>` and
   `npm run db:verify`. After: `npm run campaign:audit -- <campaignId>`.
6. At the end of the conversation, run `/handoff` so the next session starts from
   the real state.

---

*Update this file at the end of every conversation. Update
[MEMORY.md](MEMORY.md) only when something structural changes.*
