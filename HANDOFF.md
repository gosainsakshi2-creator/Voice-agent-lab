# HANDOFF.md — Current State

> **Paste this whole file into a fresh Claude conversation to resume work.**
> It is deliberately short. Stable project truth lives in [MEMORY.md](MEMORY.md);
> this file only holds *what is happening right now*.

**Updated:** 2026-08-23
**Branch:** `campaign-layer-phase-0` — **working tree DIRTY, nothing committed this
conversation** (see §5). The previous conversation's eight files, listed as
uncommitted in the last revision of this file, **were committed** as `98b7060`
and `498662a` — §5 below now describes only the change made on 2026-08-23.
**Last commit:** `98b7060` — latency improve
**Dialing:** `CAMPAIGN_DIALING_ENABLED=true` — **real calls are live**

---

## 0. This conversation (2026-08-23) — FIX #1: automatic hang-up after a genuine agent closing

Scope was **only** this defect. Fix #2 (Hello/attention-check), latency and
pronunciation were not touched. The change is **uncommitted**. Typecheck is
clean and every suite below passes three times in a row at its exact prior
baseline. Nothing has been deployed and no call was placed.

### The reported production ending

```
AI:  "Take care, Sakshi."
     SPEAKING -> LISTENING
     (no agent_hangup:closing)
     ... line held open ...
     Vobiz endCall -> HTTP 404 — call not found
```

### Root cause — ONE defect, in the phrase predicate, not in the architecture

`endsWithClosing()` in [call-runner.ts](src/campaign/dispatch/call-runner.ts)
required the normalised assistant turn to **end exactly on** a table phrase:

```ts
if (normalised.endsWith(` ${phrase} `)) return true;
```

Real closings do not. This script is name-driven — `{{customer_name}}`,
`requiresName: true`, and the whole prompt stack addresses the person by name —
so the most natural place in the call to use the name is the goodbye. The
reported turn normalises to `" take care sakshi "`, which does **not** end on
`" take care "`. Guard 3 therefore failed, `agentClosedIn` returned `false` on
every 500ms watchdog tick, no `AGENT_CLOSED` verdict was produced, and the line
was held open to `maxSilenceSeconds` (20s) — by which point the person had
already put the phone down, so Vobiz answered `endCall` with a **404**.

Measured against the shipped function, before the fix:

```
false "Take care, Sakshi."               <- the production repro, verbatim
false "Sure. Have a good day, Sakshi."
false "Have a nice day, Sakshi!"
false "Thank you, have a great day ahead."
true  "Thanks for your time, take care."  <- the ONLY shape the suite tested
```

Every case in the existing `F1` test happened to stop precisely on a table
phrase, so `test:agent-hangup` was green while the shape production actually
produces closed nothing.

**Explicitly investigated and found NOT to be the cause** — the HANDOFF's own
prior hypothesis was wrong. `agentClosedIn` has **no requirement that the
USER's last turn be a sign-off**; guard 2 only requires that the person spoke at
some point in the call. The agent-led closing path was already correct:

- `ConversationPipeline.runThinkingAndSpeaking` awaits `drainPlayback` and only
  then calls `memory.recordAssistantTurn`
  ([conversation-pipeline.ts:895](src/core/session/conversation-pipeline.ts#L895)),
  so the assistant turn appearing last **is** the moment the closing audio
  finished playing;
- `record.liveUserTranscript` is cleared when a user turn is committed
  ([conversation-pipeline.ts:852](src/core/session/conversation-pipeline.ts#L852))
  and on both ignored-speech branches, so no stale partial sits after the
  closing and blocks guard 1;
- the watchdog reads `agentClosedSoFar` on every tick, after
  `definitiveAnswerSoFar` ([call-runner.ts:414](src/campaign/dispatch/call-runner.ts#L414)).

### Exact change — one function, no new mechanism

`endsWithClosing` now allows a **bounded trailing tail** after the sign-off:

1. `lastIndexOf` instead of `endsWith`, so a turn that uses a closing phrase
   twice is measured on the **last** occurrence.
2. Tail of length 0 → a closing, exactly as before.
3. Tail of **at most `AGENT_CLOSING_MAX_TRAILING_WORDS` = 2** words → a closing,
   **only if** none of those words is in `CLOSING_CONTINUATION_WORDS`.

`CLOSING_CONTINUATION_WORDS` is a closed word class — conjunctions,
subordinators, prepositions, articles, determiners, pronouns, auxiliaries, and
the Hinglish/Devanagari connectors (`aur`, `ke`, `ko`, `से`, …). A vocative or a
trailing adverb ends a sentence; a function word carries it on. That is the
distinction guard 3 was reaching for:

```
"Take care, Sakshi."                  tail ["sakshi"]        -> a closing
"Thank you, have a great day ahead."  tail ["ahead"]         -> a closing
"Have a great day at work, and I…"    tail ["at", …]         -> NOT a closing
"Just take care to join early…"       tail ["to", …]         -> NOT a closing
```

`ji` is deliberately **absent** from the list (it is a honorific vocative, not a
connector), so `"Apna dhyan rakhiye, Sakshi ji."` closes.

**Nothing else changed.** `AGENT_CLOSINGS` is byte-identical.
`AGENT_CLOSING_MAX_WORDS` stays at 12. The four guards in `agentClosedIn`, the
`AGENT_CLOSED` verdict, the watchdog ordering, `finalize`, and every timing
constant, threshold, window and grace are untouched. No second hang-up path was
created — the fix restores the existing one.

### Deliberate, documented limits (degraded, never wrong)

- A closing longer than **12 words** still does not close, e.g. `"No problem at
  all, Sakshi. Thanks for your time and take care, Sakshi."` (13). The cap was
  not the reported defect and was left alone rather than widened.
- `"Take care of yourself."` does not close — `of` is a continuation word. This
  is asserted in `G3` so the trade-off is visible rather than accidental.
- A re-worded closing outside `AGENT_CLOSINGS` still falls back to the silence
  window. See §4.4.

## 0b. Previous conversation (2026-08-22) — two production defects, now COMMITTED as `498662a` / `98b7060`

Both changes have since been **committed**. Kept here because §0 above
modifies the `agentClosedIn` reading that ISSUE 2 introduced; nothing else in
this section changed.

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

- **Nothing is mid-edit.** The two files in §5 are the 2026-08-23 hang-up fix
  and are uncommitted — review, then commit. No commit was made, by request.
- **Fix #2 (Hello / attention-check) was NOT touched** and is still open.
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
   existing signature. (`TranscriptSegment.isEndOfSpeechMarker` in §0b follows
   this; so would §3.6.)
4. **Re-wording a script requires updating `COMMIT_ANCHORS`** in
   [classifier.ts](src/campaign/outcome/classifier.ts), or FINAL_YES detection
   dies silently. The same now applies to `AGENT_CLOSINGS` in
   [call-runner.ts](src/campaign/dispatch/call-runner.ts): a re-worded closing
   line that is not in that table means the call is not hung up, and falls back
   to the silence window — degraded, never wrong.
5. **A closing is matched on the phrase table PLUS at most a two-word
   non-continuation tail** (`endsWithClosing`, §0). Widening either half of that
   rule — the tail cap or `CLOSING_CONTINUATION_WORDS` — is what re-opens the
   false positive that hangs up on a live conversation. `test:agent-hangup`
   `G3`/`G4` are the tripwires; do not relax them to make a change pass.

---

## 5. Files changed this conversation (2026-08-23) — ALL UNCOMMITTED

```
M  src/campaign/dispatch/call-runner.ts       +96/-9   endsWithClosing: bounded trailing
                                                       tail + CLOSING_CONTINUATION_WORDS
                                                       (and guard 3's doc comment)
M  src/campaign/tests/agent-hangup-tests.ts   +150     section G (5 tests) + A4/A5
```

**Exactly two files.** No other file under `src/` was touched. No config, env,
script, migration, package.json or docs file was modified, and no test was
changed or removed — section G and A4/A5 are additions.

The eight files listed here in the previous revision are **committed**
(`498662a`, `98b7060`) and are no longer pending review.

---

## 6. Test results (2026-08-23)

`npx tsc --noEmit --incremental false` — **clean** (before and after).

Every suite run **3×**, all green, no flakes, and **every existing suite is at
its exact prior baseline** — no count moved except `test:agent-hangup`, which
gained the 7 new tests:

| Suite | Result | Prior baseline |
|---|---|---|
| `test:agent-hangup` | **23 passed**, 0 failed | 16 (+7 new) |
| `test:end-of-speech` | 17 passed, 0 failed | 17 — unchanged |
| `test:barge-in` | 27 passed, 0 failed | 27 — unchanged |
| `test:continuity` | 28 passed, 0 failed | 28 — unchanged |
| `test:pronunciation` | 21 passed, 0 failed | 21 — unchanged |
| `test:turn-release` | 14 passed, 0 failed | 14 — unchanged |
| `test:speaking-watchdog` | 6 passed, 0 failed | 6 — unchanged |
| `test:stt-clock` | 10 passed, 0 failed | 10 — unchanged |
| `test:phase8` / `test:phase9` / `test:phase10` | 19 / 20 / 12 passed, 0 failed | 19 / 20 / 12 — unchanged |

**Tests added — and which required safety case each one is.**

| Case | Test | What it asserts |
|---|---|---|
| A. genuine agent closing → hang-up | `A4` (live, through `runCall`) | `"Take care, Sakshi."` verbatim → `hangup_reason = 'agent_hangup:closing'`, `end()` called once |
| B. closing audio must finish first | `A5` (live) | `end()` never in SPEAKING; ended in LISTENING; reply spoke for 2× the window; hangup timestamp ≥ the commit timestamp; and within one 500ms tick, not a silence window |
| C. "take care" mid-conversation → NO hang-up | `G3`, `G4`, and the unchanged `F2`, `B1` | a ≤2-word tail containing a continuation word, a 3-word tail, and the long mid-sentence forms all stay up; `B1` still ends on `watchdog:max_silence` for the full window |
| D. FINAL_YES unchanged | `C1` (unchanged) | still `agent_hangup:final_yes`, read before the closing check |
| E. FINAL_NO unchanged | `C2` (unchanged) | a refusal whose closing line **also** satisfies `agentClosedIn` still names `final_no` — the ordering assertion |
| F. manual hang-up unchanged | `D1` (unchanged) | far end drops → `remote_hangup`, and the watchdog does not `end()` a session that ended itself |
| G. voicemail unchanged | `E1`, `E2` (unchanged) | a machine, and an agent-only transcript ending in a sign-off, both still end on the silence window |
| H. barge-in unchanged | `test:barge-in` 27/27, `test:continuity` 28/28 | no file either suite covers was touched |

New section G, in full:

- `G1` — the reported production closings close: `"Take care, Sakshi."`,
  `"Take care, Priya!"`, `"Sure. Have a good day, Sakshi."`,
  `"Have a nice day, Sakshi!"`, `"Thank you, have a great day ahead."`,
  `"No problem at all. Thanks for your time, Sakshi."`, `"Alright, goodbye Priya."`,
  `"Theek hai, apna dhyan rakhiye ji."`, `"Apna dhyan rakhiye, Sakshi ji."`
- `G2` — the tail was the ONLY thing blocking it: the same turn as a question,
  with a talking caller after it, and in an agent-only transcript, all still
  return `false`. The other three guards are provably unchanged.
- `G3` — a ≤2-word tail that CONTINUES the sentence is not a closing:
  `"Have a great day at work."`, `"Take care of yourself."`,
  `"Take care and rest."`, `"Thanks for your time on this."`,
  `"See you soon with Priya."`, `"Have a good day if possible."`,
  `"Bye is premature."`, `"Take care ke baad."`
- `G4` — a 3-word tail is not a closing, and F2's mid-conversation forms are
  re-asserted through the new reading so a future widening of the tail cap
  trips here.
- `G5` — a turn using a closing phrase mid-sentence **and** at its end still
  closes (the `lastIndexOf` behaviour).

**Protected systems verified unchanged** — no file touched, and the suite that
covers each is green at its prior count:

Deepgram configuration and endpointing · turn-detection thresholds, silence and
grace windows · barge-in / interruption logic · background-voice handling
(`NEAR_END_SPEECH_*`, `interruptionCorroborated`) · RMS/VAD (`vad-segmenter.ts`)
· both Vobiz media bridges · `audio-codec.ts` · TTS provider and Cartesia
configuration · LLM configuration · the campaign scripts and `COMMIT_ANCHORS` ·
conversation memory / continuity · FINAL_YES / FINAL_NO classification · the
registration gate · Google Sheets · voicemail detection · recording · the
silence and duration watchdogs · concurrency · the dispatcher · retry logic ·
existing manual-hangup behaviour · the Hello / attention-check behaviour.

Not one timing constant was changed, and no latency or pronunciation work was
done in this pass.

---

## 7. Current errors / known issues

**Open product blockers**

- **Single caller ID for every call.** Runs above 500 calls per DID are BLOCKED
  by readiness check 8.
- **No AMD.** A voicemail is scored as a normal answered call.
- **No auto-resume.** A stopped run must be restarted by hand.

**Remaining latency, after the §0b fix**

- ~1.1–1.3s of Cartesia batch synthesis on the first chunk of every turn (§3.6).
- The 4–10s "playback drain" is the agent genuinely speaking; it is a reply-length
  question (§3.7), not a pipeline one.
- The §0b fix helps **only** on turns where Deepgram splits the words and the
  endpoint across two messages. A turn where `speech_final` already rode on the
  words was on the fast path before and is unchanged.

**Known limits of the 2026-08-23 hang-up fix (§0)** — all deliberate

- A genuine closing longer than **12 words** (`AGENT_CLOSING_MAX_WORDS`) still
  falls back to the silence window, e.g. `"No problem at all, Sakshi. Thanks for
  your time and take care, Sakshi."` (13 words). The cap was not the reported
  defect and was left alone rather than widened.
- `"Take care of yourself."` does not close — `of` is a continuation word.
  Asserted in `G3`, so the trade-off is visible rather than accidental.
- A closing worded outside `AGENT_CLOSINGS` still does not close. See §4.4.
- All three degrade to `watchdog:max_silence`, which is the pre-fix behaviour —
  never to a hangup on a live conversation.

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
3. **Validate the hang-up fix on a real call.** The one thing to watch: a call
   the agent closes with the person's NAME in the goodbye
   (`"Take care, <name>."`) must now record
   `hangup_reason = 'agent_hangup:closing'` where it previously recorded
   `watchdog:max_silence`, and the caller must hear the whole closing first.
   A Vobiz `endCall` 404 on such a call means the fix did not fire and the
   carrier had already torn the line down — re-read §0.
   Also still watch `[TIMING:…] stt-to-release=` for the §0b latency change.
4. Then decide the next thread: **Fix #2 (Hello / attention-check)** is still
   open and untouched; **Cartesia streaming TTS (§3.6)** is the largest
   remaining latency item; **pilot ladder (§3.2)**, **DID rotation (§3.3, needs
   Vobiz info first)** and **auto-resume (§3.5)** are the others.
5. Before any run that dials: `npm run preflight:prod -- <campaignId>` and
   `npm run db:verify`. After: `npm run campaign:audit -- <campaignId>`.
6. At the end of the conversation, run `/handoff` so the next session starts from
   the real state.

---

*Update this file at the end of every conversation. Update
[MEMORY.md](MEMORY.md) only when something structural changes.*
