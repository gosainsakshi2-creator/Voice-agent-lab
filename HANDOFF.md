# HANDOFF.md — Current State

> **Paste this whole file into a fresh Claude conversation to resume work.**
> It is deliberately short. Stable project truth lives in [MEMORY.md](MEMORY.md);
> this file only holds *what is happening right now*.

**Updated:** 2026-08-24
**Branch:** `campaign-layer-phase-0` — **working tree DIRTY.** Uncommitted:
**FIX #8 (PHASE 3 turn release)** — 4 files: `turn-detection.ts`,
`conversation-pipeline.ts`, `turn-release-tests.ts`, `end-of-speech-tests.ts`.
Everything from Fix #3 through Fix #7a has since been committed
(`b6491ca`…`4424f1d`).
**Last commit:** `4424f1d` — #Fix 7a (turn-timing telemetry)
**Dialing:** `CAMPAIGN_DIALING_ENABLED=true` — **real calls are live**
**Latest pass:** **FIX #8 — endpoint evidence outranks punctuation
(Deepgram turn release, PHASE 3).** See the FIX #8 section immediately
below. The FIX #3 sections after it are the previous pass, kept as history.

---

## FIX 2 (2026-08-30) — HUMAN-LIKE SILENCE / NO-RESPONSE / HEARING RECOVERY

**Status: implemented, tested, green. UNCOMMITTED. Nothing dialed, nothing deployed.**
Built on top of Fix 1 (`e53e86d`, natural backchanneling), which is untouched.

**The two defects (real transcripts, 2026-08-30):**
1. A caller who said nothing after a block heard dead air until the campaign
   watchdog hung up 20s later (`CAMPAIGN_MAX_SILENCE_SECONDS`). The pipeline
   had no silence handling at all; the watchdog can only end a call.
2. A caller who said only "Hello?" after a FINISHED block went to the LLM
   (`handleAttentionCheck` only acted when a barge-in left an unheard
   remainder). 08:52 IST call: "Hello. Hello hello" → the LLM re-spoke the
   greeting. 14:32 IST call: post-block "Hello." → LLM improvised.

**Files changed (4 + 1 new):**
- `src/core/session/conversation-pipeline.ts` — the only production file.
- `src/campaign/tests/silence-recovery-tests.ts` — NEW, `npm run test:silence-recovery` (22 tests).
- `package.json` — the script entry.
- `src/campaign/tests/attention-check-tests.ts` — I2 re-pointed (see below).
- `src/campaign/tests/conversation-continuity-tests.ts` — TEST 5 "hi"/"hello" re-pointed.

**Production logic (all in conversation-pipeline.ts):**
- `SILENCE_RECOVERY_INTERVAL_MS = 3000`, `SILENCE_RECOVERY_MAX_PROMPTS = 2`.
- `waitForTurnDetectorEnd(loopSignal, silenceTimeoutMs?)` arms a timer on
  subscription (i.e. only after `drainPlayback` completed and the loop is
  idle in LISTENING). It fires only if `max(subscribedAt,
  lastConversationActivityAt)` is ≥3s old AND `callerHasTurnMaterial()` is
  false; otherwise re-arms. Any transcript text / caller energy / pending
  turn / released turn / loop abort cancels or re-arms it. Resolves
  `SILENCE_ELAPSED` instead of a turn.
- `acquireNextUserTurn` loops: expiry → `recoverFromSilence()`:
  prompt 1 "Hello, are you there?", prompt 2 "Hello, is anyone there?"
  (hi / hi-en variants), spoken via the EXISTING `speakAttentionUtterance`
  (THINKING → SPEAKING → drain, barge-in-safe, no LLM). Third expiry →
  `host.end()` — the SAME path the voicemail hangup uses →
  `manager.end()` → `telephony.endCall(call_uuid)`. Counter
  `silenceRecoveryPrompts` resets on every released turn.
- `handleAttentionCheck` no-remainder branch: after a block
  (`contextualReplyCommitted`), a strict hearing check (`isHearingCheck`:
  greetings/presence phrases only — "haan ji", "ji", "please" never
  qualify) gets the existing ack once, then ONE follow-up "I just want to
  make sure you can hear me. Did you catch what I was saying?"; the next
  contribution takes the normal path. Before any block, only an EMPHATIC
  check qualifies (`isEmphaticHearingCheck`: presence phrase or repeated
  greeting) so a single "Hi." after the opening line still goes to the LLM
  (the pitch) exactly as today; a confirmation then also goes to the LLM.
- `startSpeculation` (FIX #8) declines to pre-open a request for a turn
  the hearing branch will answer — same family as its existing
  `attentionEpisodeOpen` guard.
- Untouched: Fix 1 hunks (`replyFullyQueued`, `backchannelInFlight`
  decline), barge-in, `drainPlayback`, `synthesizeAndPlay`, Sarvam,
  Deepgram, turn detector, classifier, sheet, call-runner, Vobiz provider,
  bridges, metrics definitions. `git diff` contains no Fix 1 line.

**Timing:** block drains → LISTENING → 3.0s → prompt 1 (~1.2s) → LISTENING →
3.0s → prompt 2 → LISTENING → 3.0s → `end()`. ≈11s of caller silence to
hangup. Each prompt's SPEAKING→LISTENING re-arms the 20s watchdog, so the
two mechanisms cannot race. Campaign label for this ending is the
call-runner's existing `remote_hangup`/"conversation completed" (call-runner
deliberately not modified).

**Campaign safety:** a recovery prompt is a `?` assistant turn, so
`answersACommitQuestion` stops at it — "Yes" to "are you there?" is NOT a
FINAL_YES (tests K1/K2). "haan ji" to the gate still reaches the LLM and
classifies `confirmed_at_gate` (test N).

**Tests re-pointed (not weakened):** attention I2 asserted that a post-block
"Hello?" produced an LLM request — the OLD mechanism, which is the defect.
Now asserts: one ack, zero requests, block not re-spoken, next real turn
reaches the model. Continuity TEST 5 "hi"/"hello": same re-pointing (the
file's SECTION A note already documents this pattern for TEST 1); "okay"/
"haan" unchanged.

**Verification (final tree):** `tsc --noEmit --incremental false` clean.
silence-recovery 22/22 · barge-in 52/52 · speculative-llm 23/23 · attention
22/23 · continuity 41/41 · stt-clock 14/14 · turn-release 19/19 ·
end-of-speech 17/17 · sarvam-stream 28/29 · tts-streaming 21/21 ·
agent-hangup 23/23 · vobiz-call-control 10/10 · speaking-watchdog 6/6 ·
phase8 31/31 · phase9 20/20 · phase10 12/12.
**Pre-existing failures (identical on a pristine HEAD snapshot):**
attention B1 (ack constant has a trailing space since `cba9c0c`, test
constant does not); sarvam-stream C8 (`pace 1 must be in (1.0, 1.2]`).

**Real-call verification — NOT YET DONE.** Watch for: prompt cadence feeling
right on a live Vobiz leg; `[PIPELINE] caller silent for 3000ms — recovery
prompt 1/2`; `[PIPELINE] hearing check with nothing to resume`; the hangup
line `[Vobiz] endCall: call_uuid=…` after prompt 2.

---

## REMINDER v2 SCRIPT (2026-08-29) — ATTENDANCE CONFIRMATION FOR THE 30 AUG 11 AM WORKSHOP

**Status: implemented, tested, green. Uncommitted. Nothing dialed.** Three files:
NEW `src/campaign/script/scripts/reminder.v2.ts`; `script-registry.ts` (+import,
`REMINDER_V2` placed above `REMINDER_V1` → v2 is now the reminder default);
`phase8-sheet-tests.ts` (+7 tests, A1f–A1l). `reminder v1` and every
`registration.*` script are byte-identical (hashes verified unchanged via
`script-hash-report`). Classifier, sheet integration, call-runner untouched.
Gate is "Will you be joining us tomorrow at 11 AM?" — matches the existing
`COMMIT_ANCHORS.reminder` entry `"will you be joining"`. The unsure
clarification ("…likely to join, or should I leave your seat unconfirmed?")
deliberately carries no anchor, so a reply to it is never a FINAL_YES.
reminder v2 hash: `6593de603b2b…`.

**Classifier fix (same day, approved, minimal):** "not sure" contained the
affirmation token "sure" and was not in `AFFIRMATION_EXCEPTIONS`, so "Not sure."
/ "Maybe, not sure yet." right after the gate settled as `confirmed_at_gate` →
FINAL_YES → a sheet row, for BOTH campaign types. Fixed by adding exactly
`"not sure", "pata nahi", "nahi pata"` to `AFFIRMATION_EXCEPTIONS` in
`classifier.ts` (one 5-line hunk). Regression test phase8 A1m covers both gates
and proves a genuine "Sure, I'll be there." still confirms. Rules id unchanged.

## FIX #10 (2026-08-25) — SMALLEST AI: VENDOR-BAKED EDGE SILENCE BETWEEN SENTENCE CHUNKS

**Status: implemented, tested, green. Uncommitted. Nothing dialed.** Two files:
`smallest-ai.provider.ts` (an `EdgeSilenceTrimmer` applied only inside
`synthesizeStream`) and `smallest-ai-stream-tests.ts` (+5 tests, A14–A18).

**Root cause (measured live, 2 rounds, identical to the ms):** Smallest pads
every rendered clip with **80–300ms leading + 350–380ms trailing** digital
silence (RMS 0–8). One request per sentence chunk ⇒ **~430–680ms of dead air at
every sentence boundary**. Cartesia's edges are 0–90ms — same pipeline, no pause.
Queue starvation ruled out (each Smallest stream finishes ~2.4s before its audio
has played). `remove_extra_silence: true` is silently ignored by the stream
endpoint. Fix trims each edge to 50ms; internal pauses preserved byte-for-byte;
held silence capped at 600ms. Live after: lead=50/trail=50 on all three test
sentences. Watch `[TTS:smallest-ai] trimmed edge silence lead=…ms trail=…ms` on
the next call. Note: `tts-first-chunk` on this lane may read 0–70ms later — it
used to measure the arrival of the silent pad, not speech.

Pre-existing, unrelated: `test:sarvam-stream` C8 fails before and after
(`SARVAM_PACE` = 1, test wants (1.0, 1.2]).

## FIX #8 (2026-08-24) — TURN RELEASE, PHASE 3: THE ENDPOINT CLAIM WAS DISCARDED FOR UNPUNCTUATED TEXT

**Status: implemented, tested, green (3x, no flakes). Uncommitted. Nothing
dialed.**

### Root cause — `isCompleteThought()` required terminal punctuation, so both evidence fast paths threw the endpoint claim away on the commonest real-call turn shape

The live `stt-to-release` traces split cleanly in two: turns whose final was
punctuated released on the evidenced 150/250ms tier; turns whose final was NOT
punctuated (Deepgram `nova-3` in `multi` mode routinely declines to punctuate
Hinglish finals) discarded the `speech_final` / `UtteranceEnd` evidence at both
call sites — `feed`'s fast path and `noteEndOfSpeech` — and fell back to
inference:

```
speech_final, unpunctuated:   silence window 1100–1600ms + open-ended 550ms
                              ≈ 1.7–2.1s of self-inflicted wait
UtteranceEnd, unpunctuated:   marker arrived mid-window, noteEndOfSpeech
                              set lastFinalWasEndpoint and RETURNED —
                              remaining window + 550ms all still paid
text also trips looksIncomplete: + up to 2 × 800ms continuation graces
                              ≈ 2.7–3.9s (TURN#0 stt-to-release=5040ms)
```

The Deepgram connect parameters (`endpointing: 400`,
`utterance_end_ms: 1000` — the documented minimum) are NOT the cause and were
not touched.

### Exact change — `turn-detection.ts`, two gates and one new tier

1. New `isReleasableThought()` replaces `isCompleteThought()` at BOTH evidence
   call sites: non-empty, not `FILLER_ONLY`, not `HOLD_PHRASE_ONLY`, not
   `looksIncomplete`. The terminal-punctuation requirement is gone — the file
   already documents Deepgram's punctuation as a formatting decision, not a
   completion judgement; its absence is equally weak evidence. Everything that
   affirmatively reads unfinished still takes the full inference path.
2. New `EVIDENCED_CONFIRMATION_OPEN_MS = 300` — the tier an unpunctuated
   evidenced turn gets (punctuated tiers stay 150/250ms). With Deepgram's own
   400ms `endpointing` silence in front of it, release still requires ~700ms of
   observed quiet = `MIN_SILENCE_TIMEOUT_MS`, the file's own floor for a
   plausible end of turn. Any segment arriving inside the window still cancels
   the release (in-flight-speech check, unchanged).
3. `confirmationWindowMs`'s unpunctuated branch mirrors the punctuated one:
   evidenced → 300ms, no evidence → the inferred 550ms stands. (Only reachable
   via the chunk-boundary-grace collapse.)

**No silence window, grace, margin or Deepgram parameter changed.** Mid-thought
(`looksIncomplete`), filler, hold-phrase, outstanding-interim, chunk-boundary
(no evidence), backchannel and barge-in behaviour are all asserted unchanged.

### Also fixed — `conversation-pipeline.ts`: `sttLagMs` ignored the STT clock re-basing

The recognition-lag metric used raw `segment.endedAtMs`; after an STT socket
reconnect ("STT stream clock restarted" in the logs) that value restarts at
zero, so the lag inflated by the whole call duration, back-dated
`userSpeechEndedAtMs`, and printed nonsense `stt-to-release` figures (the
TURN#1=27733ms class). It now reads the re-based `sttStreamMsOf` value —
metrics only, no control flow; identical on a call that never reconnects.

### Tests — two expectations retired and replaced by the property they stood for (§0a.7 precedent)

- `test:turn-release` "an UNPUNCTUATED endpointed turn still gets the full
  silence window" → now asserts the evidenced 300ms tier, PLUS a new test that
  the same text with NO evidence keeps the full slow path (silence + chunk
  grace + 550ms). 14 → **19 tests**, green 3x.
- `test:end-of-speech` A2b likewise, and now asserts its own premise
  (no-evidence replay stays slow). **17 tests**, green 3x.

### Measured (real detector, wall clock, this machine)

| Class | Before | After |
|---|---|---|
| unpunctuated + `speech_final` on the words | ~1650ms | **~300ms** |
| unpunctuated + `UtteranceEnd` marker | ~1500ms | **~300ms** |
| wire-trace noisy line (stt-to-release) | 3604ms | **1745ms** |
| wire-trace background voice | 7558ms | **5693ms** (vendor lag stays visible) |
| wire-trace clean line | 1091ms | 1103ms — unchanged, as asserted |
| mid-thought / hold / filler / interim / no-evidence | unchanged | unchanged |

### Full regression — all green, nothing weakened

`npx tsc --noEmit --incremental false` clean. `test:turn-release` 19/0 (3x),
`test:end-of-speech` 17/0 (3x), `test:wire-trace` 19/0, `test:barge-in` 27/0,
`test:continuity` 28/0, `test:turn-timing-telemetry` 8/0, `test:tts-streaming`
21/0, `test:stt-clock` 10/0, `test:attention` 23/0, `test:agent-hangup` 23/0,
`test:speaking-watchdog` 6/0, `test:phase10` 12/0.

### Real-call verification — NOT YET DONE

On the next live call, watch the `[TIMING:…] TURN#N DELTAS` blocks:
`endpoint-to-release` should read ~150–300ms whenever `endpoint-evidence` shows
`(speech_final)` or `(utterance_end)`; multi-second values should only remain
on turns whose text genuinely trailed off (dangling conjunction, hold phrase).
After any "STT stream clock restarted" line, `stt-to-release` must stay sane.
What remains outside our control: Deepgram's own delivery lag (final +
`UtteranceEnd` arrive ~1.0–1.5s after last word on a noisy line; ~0.8s clean),
LLM first token, and TTS first audio.

**Rollback:** revert the two gate call sites to require
`TERMINAL_PUNCTUATION`, delete `EVIDENCED_CONFIRMATION_OPEN_MS` and the
`confirmationWindowMs` branch, and restore the raw-`endedAtMs` lag line.

- **PHASE A — Sarvam truncation: FIXED.** `test:sarvam-stream`, 17 tests, and
  the suite was verified to fail 4/17 against the pre-fix provider.
- **PHASE B — Smallest AI streaming: SHIPPED.** `test:smallest-stream`,
  24 tests. **-277 to -1076ms** of measured first audio on a third of all calls.
- **PHASE C — Sarvam handshake: CLOSED AS UNSAFE, no code changed.** Proven,
  not assumed: a reused socket gives **no** utterance boundary.

The read-only AUDIT that preceded this pass (further below) changed no code;
its two live findings are what this pass executed on, in the order it gave.
**All three campaign TTS lanes now stream.** Nothing was committed and nothing
was dialed.

---

## FIX #3 PHASE A (2026-08-23, fifth pass) — SARVAM PREMATURE TRUNCATION

**Status: implemented, tested, green. Uncommitted. Nothing dialed.** Scope was
**only** the Sarvam truncation defect. No latency work was done in this phase;
the handshake (Phase C) and Smallest AI (Phase B) were not touched. Cartesia's
SSE implementation (§0) is byte-identical.

### Root cause — the idle budget was calibrated BELOW the vendor's own delivery quantum

The AUDIT identified `widestFrameGapMs` starting at 0 as the cause. That is
**half** of it, and the half that was already known. Probing the live socket
frame by frame (18 runs, throwaway probes since deleted) found the other half,
which is what makes the failure reproducible:

**Sarvam does not send one frame per fixed slice of audio.** Frame sizes are
quantised multiples of 2200 bytes, and *which* multiple you get varies run to
run on identical text. At 8kHz PCM_16 — 16000 bytes/s, and the header confirms
8000Hz/16-bit/mono — that is:

```
2200 B = 138ms of audio      6600 B = 413ms of audio
4400 B = 275ms of audio      8800 B = 550ms of audio
```

Six runs of one 134-character sentence: **four of them were mostly 6600- and
8800-byte frames.**

```
run1  19 frames  4400B x9  6600B x8  8800B x1  2200B x1
run2  20 frames  4400B x9  6600B x9  8800B x1  2200B x1
run3  48 frames  2200B x48
run4  43 frames  2200B x43
run5  18 frames  4400B x9  6600B x8  8800B x1
run6  19 frames  4400B x9  6600B x8  8800B x1  2200B x1
```

So the vendor routinely hands over **413-550ms of audio per frame while
`MIN_IDLE_GAP_MS` granted it 300ms** to produce the next one. The safety
mechanism was smaller than the thing it was measuring. Any moment the vendor
generates at roughly real time — ordinary under load; socket-open alone measured
**255-1300ms** across the same runs — the gap exceeds 300ms and a healthy
utterance is declared finished.

**This closes the audit's report exactly.** Its worst run delivered
`frames=2, audio=0.82s` of a 5.97s sentence. Two 6600-byte frames is 13200
bytes is **0.825s**. The byte count matches the quantum to three digits: it was
never a short read, it was **two ordinary frames followed by one ordinary gap
that the budget was too small to survive.**

`widestFrameGapMs = 0` is the compounding half: it is 0 until two frames have
arrived, so `widest * 4` is 0 and the budget collapses to that too-small floor
precisely in the window where nothing about the cadence is yet known.

### Also established, and it rules out the obvious alternative fix

**There is no length to read and no marker to wait for.** The streaming WAV
header Sarvam opens with declares `0xFFFFFFFF` for **both** the RIFF chunk size
and the `data` subchunk size — verified on every one of the 18 runs:

```
headerHex 52494646 ffffffff 57415645 666d7420 ... 64617461 ffffffff
          RIFF     size=-1  WAVE     fmt              data     size=-1
```

and after the last audio frame there were **9.8-13.4 seconds of nothing, no
non-audio frame and no server close**. So the idle gap cannot be replaced by
reading a declared length or by waiting for an end marker. It can only be
sized correctly. That is what this phase does.

### Exact change — ONE production file, three layers, two of them widenings

**[sarvam.provider.ts](src/providers/text-to-speech/sarvam.provider.ts)** —
`synthesizeStream`'s idle budget only. `synthesize()`, the REST fallback, the
RIFF stripping, the parity guard, the abort path, the socket lifecycle,
`IDLE_GAP_SAFETY_FACTOR` (4) and `MIN_IDLE_GAP_MS` (300) are **all unchanged**.

1. **The adaptive term is not trusted until the cadence exists.** New
   `MIN_OBSERVED_GAPS_BEFORE_ADAPTING = 2`. Until two real inter-frame gaps have
   been measured, the budget is the configured `SARVAM_STREAM_IDLE_GAP_MS`
   ceiling — i.e. **the fixed 700ms this adapter used before the adaptive
   change**, the value with no truncation on record. A widening of the early
   window only, 300ms -> 700ms.

2. **A delivery-quantum floor, measured from this stream.** Never conclude the
   vendor stopped in less time than the audio it just delivered in one
   uninterrupted drain. Summed **per drain pass**, not per frame, because frames
   that arrive together and drain back to back are one delivery as far as
   cadence goes — and they measure as ~0ms gaps, which is exactly what made the
   adaptive term blind to them. A widening.

3. **A hard bound.** New `MAX_IDLE_GAP_MS = 1200` caps the whole budget,
   including the floor, so a large burst drained after transport backpressure
   cannot license a tail as long as the clip. ~2.2x the widest single delivery
   ever measured (550ms) and ~1.7x the pre-adaptive fixed wait. **The only
   narrowing, and it sits above both the configured ceiling and every delivery
   measured.**

   Whether that burst case is reachable at all depends on the transport, and the
   two bridges differ — checked rather than assumed: **Vobiz, the live campaign
   transport, applies NO outbound backpressure** (its outbound listener returns
   void; it queues every frame and paces the pump at real time), so the producer
   is never parked and the hard bound is never reached there. **Plivo** does
   apply it — `OUTBOUND_HIGH_WATER_FRAMES` 140 (2800ms) parks the producer,
   `OUTBOUND_LOW_WATER_FRAMES` 110 (2200ms) releases it — so it is the only path
   a large drained burst can come from, and there the queue still holds >=2200ms
   when the producer resumes, comfortably covering a 1200ms tail.

Plus **one diagnostic line** at the idle-gap break, printing the budget applied
against the delivery observed, so a premature termination is visible in a real
call instead of silent. Diagnostic only.

Because layers 1 and 2 are widenings, **this change cannot introduce a
truncation that did not already exist.**

### What it costs, and what it deliberately keeps

| Cadence observed | Tail before | Tail after |
|---|---|---|
| 138ms frames, tight gaps (the common case) | 300ms | **300ms — unchanged** |
| 550ms frames | 300ms | 550ms |
| clip ends inside the first two frames | 300ms | 700ms |
| one enormous frame / big burst after backpressure | 300ms | 1200ms (bounded) |

**The adaptive win is kept where it was actually won.** On the common cadence
the tail is still the 300ms floor — asserted, because the pipeline awaits this
generator once per sentence chunk and that tail is pure serialisation at every
chunk boundary. `A6` is the tripwire: it **fails** if someone "fixes"
truncation by reverting to a fixed 700ms wait.

### Tests added — `test:sarvam-stream`, 17 tests

`npx tsc --noEmit --incremental false` — **clean**.
**17 passed, 0 failed — 3x, no flakes.**

Driven against the **real `SarvamTextToSpeechProvider`, over a real WebSocket,
to a local fake Sarvam on 127.0.0.1** whose frame schedule each test writes.
Nothing contacts Sarvam, places a call, reads the database or touches Google.
The provider's socket handling, RIFF stripping, parity guard, abort path, REST
fallback and idle-gap arithmetic are all the shipped code — only the vendor on
the far end is local, which is what makes frame timing exact instead of flaky.

**The suite was verified to actually catch the defect.** Run against the
pre-fix provider (`git checkout` of the shipped file, then restored):

```
PRE-FIX:   13 passed, 4 failed   <- A1, A2, A3, A7 all fail
POST-FIX:  17 passed, 0 failed
```

An earlier draft of the suite passed against the pre-fix code, and the reason is
worth recording: the fake server stops sending the moment the provider closes
the socket — which is precisely what a truncating provider does — so comparing
against "what the server sent" shrank the expectation to match the truncation
and passed vacuously. Every delivery assertion now compares against
`expectedAudio()`, **the schedule's intent**, computed before the run.

| Test | What it asserts |
|---|---|
| `A1` | **the audit's exact failure**: two 413ms frames then a 450ms gap delivers the WHOLE utterance |
| `A2` | the `widestFrameGapMs = 0` window: a 600ms gap after frame 1 does not truncate |
| `A3` | sparse cadence throughout — 350ms gaps between every frame |
| `A7` | **established-but-tight** cadence (three 60ms gaps) then a 480ms gap: only the delivery-quantum floor can save this one, so it tests layer 2 in isolation |
| `A4` | a genuinely short utterance completes, and the wait is bounded by the ceiling — not the 6s start timeout, and not forever |
| `A5` | genuine completion then long silence with the socket held open: returns on the gap, delivers everything, final sentinel present |
| `A6` | **the latency tripwire** — the common cadence still returns on the ~300ms floor |
| `A8` | a 4-second single frame cannot license a 4-second tail |
| `C1` | the 44-byte streaming RIFF header is stripped, never played |
| `C2` | every chunk sample-aligned, sequenced from 0, PCM_16 at the configured rate |
| `C3` | an odd-length frame holds back its orphan byte instead of shifting every later sample |
| `C4` | barge-in mid-stream stops emission promptly and emits **no** final sentinel |
| `C5` | a vendor error AFTER audio started throws instead of truncating silently, and does **not** re-synthesize over queued audio |
| `C6` | a vendor error BEFORE any audio falls back to the blocking REST call |
| `C7` | a server that DOES close ends the stream on the close, paying no idle gap |
| `D1` | generated audio duration equals the audio actually delivered — the quantity a truncation used to under-report while the full text was recorded as spoken |
| `D2` | Sarvam TTS cost stays **non-zero** and character-billed; the duration argument cannot change it |

`A1`, `A2`, `A3` and `A7` each **assert their own premise**: they recompute the
SHIPPED budget rule over their own schedule and require that it *would* have
truncated. None of them can quietly stop reproducing the defect it exists for.

### Cost accounting — verified, no change needed

Sarvam is in `TTS_COST_PER_1K_CHARS_USD`, **not** in
`TTS_COST_PER_GENERATED_MINUTE_USD`. The pipeline's streaming branch already
passes `estimateTtsCost(id, text.length, generatedAudioSeconds)`, so the
character path is taken and the duration argument is simply unused — the
Cartesia problem (§0) cannot occur here. **`D2` is the regression test**, and it
asserts both halves: non-zero, and duration-independent. No pipeline change.

### Latency — measured, and NOT claimed to have improved

This phase is a correctness fix. Its effect on time-to-first-audio is **zero by
construction**: the budget is only consulted *after* the first frame has been
yielded, so nothing before first audio was touched. Sarvam's first-audio stays
at its measured **492ms p50 / 817ms p90**. What changed is the **tail**, per the
table above — and only in the cadences that were previously at risk.

Live socket measurements taken this pass, for Phase C's baseline:

```
socket open   255-1300ms  (median ~360ms)
first audio   505-1568ms
open -> first audio  ~250ms
```

### Protected systems verified unchanged

`git status` shows **one** production file added to the pass:
`sarvam.provider.ts`. `cartesia.provider.ts` (§0), `smallest-ai.provider.ts`,
`elevenlabs.provider.ts`, `conversation-pipeline.ts`, `sentence-chunker.ts`,
`turn-detection.ts`, both media bridges, `audio-codec.ts`, `vad-segmenter.ts`,
`call-runner.ts`, the cost estimator, the campaign scripts, the classifier and
every config and env file are **byte-identical**. No timing constant, threshold,
window, grace or margin outside Sarvam's idle budget was changed. No sleep was
added. No safety guard was removed. No existing test was changed, weakened or
deleted.

### Real-call verification — NOT YET DONE

Nothing was dialed. On the next live call on the Sarvam lane, watch:

1. `[TTS:sarvam] idle gap NNNms elapsed after N frames — treating utterance as
   complete (widestGap=… gaps=… delivery=…)` — the new diagnostic. `delivery`
   should read 138-550ms and `budget` should always exceed it.
2. **No truncated sentences.** The failure mode is a reply that stops
   mid-sentence while the transcript records it whole, so compare the recording
   against the committed assistant turn.
3. Frame counts in the double digits on multi-second replies — a `frames=2`
   line is the defect returning.
4. Chunk-boundary pauses no worse than before on the common cadence.

**Rollback is the three new constants and the budget expression** in
`synthesizeStream`; nothing else in the file moved.

---

## FIX #3 PHASE B (2026-08-23, fifth pass) — SMALLEST AI: BATCH -> SSE STREAMING

**Status: implemented, tested, green. Uncommitted. Nothing dialed.** Scope was
**only** the Smallest AI lane. Phase A's Sarvam change and Cartesia's SSE
implementation (§0) are untouched.

### Root cause — `arrayBuffer()` cannot yield a byte until the last byte lands

`synthesize()` goes through `postJsonForBinary`, which ends in
`await response.arrayBuffer()`. Time-to-first-audio is therefore the whole
render **plus the whole body transfer**. Production, 100 real turns:
**958ms p50 / 1928ms p90** — the slowest of the three campaign lanes, on a third
of every call.

### What the wire actually looks like — TRACED, not assumed

The brief warned against assuming a streaming response means the first event is
playable. It was traced instead:

```
POST https://waves-api.smallest.ai/api/v1/lightning-v3.1/stream
  content-type: text/event-stream      transfer-encoding: chunked

  event: audio
  data: {"audio":"<base64>","done":false,"status":"206"}
  ...
  data: {"status":"200","done":true}          <- NO `event:` line
```

Four findings, each of which changed the implementation:

1. **The host is different.** `SMALLEST_AI_BASE_URL` is `api.smallest.ai`, and
   that host answers **HTTP 404** for `/api/v1/lightning-v3.1/stream`. Only
   `waves-api.smallest.ai` serves it — a different host AND a different path
   root, so one base URL cannot express both. Hence a new optional
   `SMALLEST_AI_STREAM_BASE_URL` (default `https://waves-api.smallest.ai`).
   **No existing env var changed.**
2. **The payload is RAW PCM with NO container** — even though the request asks
   for `output_format: "wav"` and the batch endpoint honours that. So
   `decodeWav` must NOT be applied on this path and the sample rate comes from
   config. A defensive RIFF strip is kept anyway: a vendor that starts honouring
   `output_format` here would otherwise inject 44 header bytes into the caller's
   audio as if they were samples.
3. **There IS an explicit end-of-stream marker** (`done: true`), unlike Sarvam.
   Completion is read from it rather than inferred from an idle gap — so nothing
   like Phase A's defect is possible on this lane.
4. **Errors are not SSE events.** A bad voice id returns **HTTP 400** with
   `{"error":[{...,"message":"Invalid Voice ID"}]}` before the stream starts, so
   the status check is the whole error path.

Also verified: the endpoint **honours `speed`** (0.92 -> 46444 bytes, 1.4 ->
34322 bytes on identical text) and **`sample_rate`**, and every one of the
observed payloads across 8 utterances (9-40 events each, 48-5516 bytes) was
**even-length** — so no coalescing accumulator is needed, only a parity guard.

### Is it the same audio? — the question a single sample answers WRONGLY

Naive single-sample comparisons showed the stream anywhere from 5% LONGER to 9%
SHORTER than batch. Neither is real. **The vendor is non-deterministic in clip
length.** Four batch and four stream calls, one 110-character sentence:

```
BATCH   200428, 195684, 196548, 190112 bytes    spread 5.3%
STREAM  196208, 195770, 195770, 195684 bytes    spread 0.3%
mean stream / mean batch = 1.0008          (0.1%)
```

**Batch varies 5.3% against itself.** On means the two paths agree to 0.1%, and
the stream is the *more* consistent of the two. Two independent runs also
matched the batch WAV's `data` chunk EXACTLY (41574 = 41574, 132166 = 132166).

### Latency — measured through the real provider class, live account

| chars | batch first audio | stream first audio | saved |
|---|---|---|---|
| 16 | 982ms / 1142ms | 705ms / 730ms | 277 / 412ms |
| 80 | 1001ms / 1595ms | 538ms / 519ms | 463 / 1076ms |
| 110 | 1165ms / 1282ms | 579ms / 533ms | 586 / 749ms |

Two independent sessions per row. **Saved 277-1076ms**, and the streaming figure
does not grow with length the way batch's does.

### Exact change — ONE production file, plus one stale comment

**[smallest-ai.provider.ts](src/providers/text-to-speech/smallest-ai.provider.ts)
— `synthesizeStream` added (purely additive).** The optional interface member
per binding constraint §4.3; no existing signature changed, `synthesize()` still
present and still correct.

- A private `requestBody(task)` now feeds **both** paths, so voice, sample rate,
  output format and `speed: .92` cannot drift between them. `synthesize()`'s own
  values are byte-for-byte what they were. **This is asserted** (`A3` deep-equals
  the two request bodies), not asserted-by-comment — and the drift it prevents is
  real and present in this codebase: the ElevenLabs adapter's two paths send
  DIFFERENT `voiceSettings`.
- Discriminates on the `audio` FIELD, not the `event:` name, because the terminal
  record arrives with no `event:` line at all.
- **`done: true` breaks out of the record loop immediately** — including records
  already sitting in the same read. An earlier draft only re-tested `done` on the
  outer read loop, so audio the vendor emitted *after* the end marker was still
  played; `A4` caught it and is the regression test.
- `signal` is passed to `fetch`, so a barge-in aborts the HTTP request instead of
  leaving the vendor generating audio nobody will hear; a `finally` cancels the
  reader so an early `break` still releases the socket.
- A parity guard carries an odd trailing byte into the next event rather than
  shifting every later sample.
- Falls back to the blocking REST call **only when no audio has been emitted
  yet** — the pipeline's streaming branch merely logs what escapes this
  generator, so an unhandled failure would mean the agent says NOTHING for that
  sentence. Same reasoning and same shape as the Sarvam adapter.

**[conversation-pipeline.ts](src/core/session/conversation-pipeline.ts) — a
COMMENT only, no code.** The batch branch's comment claimed *"Cartesia, Sarvam
and Smallest AI ... ElevenLabs is the sole provider with `synthesizeStream`"*.
Every part of that was already stale and this change makes it wholly wrong: all
four configured providers now stream. The feature-detection code was always
correct — only the comment was not.

### Cost accounting — verified, and NO pipeline change was needed

Smallest AI is in `TTS_COST_PER_1K_CHARS_USD`, **not** in
`TTS_COST_PER_GENERATED_MINUTE_USD`. The streaming branch already passes
`estimateTtsCost(id, text.length, generatedAudioSeconds)`, so the character path
is taken and the duration argument is unused. **The Cartesia trap (§0) — where a
duration-billed vendor moving to streaming silently zeroed its cost — cannot
occur here**, and `C1` is the standing regression test for exactly that: cost
non-zero, and duration-independent. `C3` additionally asserts an interrupted
utterance bills only what it generated.

### Tests added — `test:smallest-stream`, 24 tests

`npx tsc --noEmit --incremental false` — **clean**.
**24 passed, 0 failed — 3x, no flakes.**

SECTION A drives the **real provider over real fetch/SSE** to a local fake
vendor on 127.0.0.1. SECTION B puts that **same real provider inside the real
`ConversationPipeline`** — which is strictly stronger than `test:tts-streaming`'s
coverage, because there the streaming provider is a fake modelling a shape,
whereas here it is the code that will actually run in production. The local
vendor serves BOTH endpoints from the SAME rendered clip, which is what makes
the batch/stream parity assertion exact rather than a comparison of two
independent vendor renders.

| Required case | Test |
|---|---|
| first streaming audio | `A1` — first audio arrives before the transfer is 60% done |
| multi-chunk streaming | `A2` — every byte, in order, exactly once; sequences from 0 |
| complete playback | `B1`, `B2` — the reply reconstructs EXACTLY, chunks included |
| cancellation | `A8` — emission stops, no final sentinel, no spurious fallback |
| barge-in during TTS | `B3` — superseded before any audio; never committed |
| barge-in during playback | `B4` — only the heard prefix committed, and it is a PREFIX |
| background voice | `B5` — no turn created, block still finishes |
| attention-check flow | `B6` — one acknowledgement, **zero** language-model requests |
| continuation / resume | `B7` — exact remainder resumed, no generation, nothing re-synthesized |
| agent closing | `B8` — last committed turn, back in LISTENING, real `agentClosedIn` true |
| TTS cost accounting | `C1` — non-zero and character-billed |
| generated audio duration | `C2` — equals the audio actually delivered |
| duration/bytes vs batch | `A13` — byte count, samples AND duration identical |
| voice params cannot drift | `A3` — the two request bodies deep-equal |
| end-of-stream marker | `A4` — `done:true` ends it; anything after is ignored |
| no marker at all | `A5` — still completes on the body ending |
| vendor error before audio | `A6` — REST fallback, never silence |
| vendor error after audio | `A7` — throws; does NOT re-synthesize over queued audio |
| sample alignment | `A9` — orphan byte carried; nothing lost or reordered |
| container defence | `A10` — a RIFF header is stripped, never played |
| protocol noise | `A11` — comments, keep-alives, blank and unknown records ignored |
| CRLF separators | `A12` — parses the same as LF |
| interrupted billing | `C3` — bills what was generated, not the whole clip |

---

## FIX #3 PHASE C (2026-08-23, fifth pass) — SARVAM HANDSHAKE: INVESTIGATED, DELIBERATELY NOT IMPLEMENTED

**Status: investigated to a conclusion. NO code was changed. This is a STOP,
not an omission** — the brief's own instruction: *"If there is NO deterministic,
reliable boundary mechanism: DO NOT pool the socket."* There is none, and it was
proven rather than assumed.

### 1. Can utterance A be distinguished from utterance B on one socket? — NO

Three utterances were sent down ONE socket, with a 9-second gap between them so
each was certainly finished — **the friendliest possible case for reuse.** Every
frame was logged with its leading bytes:

```
socket OPEN                    +479ms
utterance 1 (105 ch)  41 frames  5.50s   riffHeaders=1  nonAudio=0
utterance 2  (97 ch)  34 frames  4.81s   riffHeaders=0  nonAudio=0
utterance 3  (15 ch)   7 frames  1.10s   riffHeaders=0  nonAudio=0

total RIFF headers on the socket: 1   (utterances sent: 3)
total NON-AUDIO frames:           0
socket readyState at end:         1 (OPEN)
```

**Reuse works functionally — and is undetectable.** The RIFF header is sent
**once per socket, not once per utterance**, so it is not a boundary marker.
There is no start marker, no end marker, no non-audio frame of any kind, and no
server close. Every frame of utterance B is byte-shape-identical to every frame
of utterance A.

The ONLY thing separating them on a shared socket would be **the idle gap** —
the exact mechanism Phase A just proved is a heuristic calibrated below the
vendor's own delivery quantum. Building utterance attribution on it would make a
truncation into a **cross-utterance contamination**: audio from reply N played
as part of reply N+1. That is strictly worse than the defect Phase A fixed.

### 2. Two architectural facts that make pooling worse here than in general

- **The provider is a PROCESS-WIDE SINGLETON.** `bootstrapProviderRegistry`
  calls `registry.register(category, factory())` — the factory runs **once**, and
  `getRuntime()` stores one registry on `globalThis`. So all three concurrent
  calls share **one** `SarvamTextToSpeechProvider` instance. Any socket held on
  it is cross-session state by construction, which is the first thing the brief's
  safety list forbids.
- **There is no teardown hook to close a held socket in.**
  `TextToSpeechProvider` has exactly `descriptor`, `synthesize`,
  `synthesizeStream?` and `checkHealth` — and **no provider interface in the
  codebase has any lifecycle member at all.** A warm socket would have nowhere
  correct to be closed, so a dropped or ended call would leak it.

### 3. Where the handshake time actually goes — decomposed, 6 samples

The audit reported 242-311ms of setup. It decomposes as:

| Stage | median | share |
|---|---|---|
| DNS lookup | 2ms | 1% |
| TCP connect | 73ms | 22% |
| TLS handshake | 88ms | 27% |
| **HTTP upgrade (the vendor answering `101`)** | **169ms** | **52%** |
| **total socket open** | **326ms** | |

**The largest single component is the vendor answering the upgrade**, and that is
not client-optimizable by anything short of not opening a connection.

### 4. The one client-side lever, measured and rejected

TLS session resumption via a shared `https.Agent` (`keepAlive`,
`maxCachedSessions: 100`) — no connection reuse, no boundary hazard, so it would
have been safe:

```
fresh connection each time   median open 326ms
shared agent (TLS cache)     median open 313ms
delta                         13ms  (4%)
tlsSessionReused             true on 1 of 6 attempts
```

**13ms.** Not worth a change, and it does not touch the 169ms that dominates.
Recorded so nobody re-measures it.

### 5. The pre-open idea helps the wrong chunk

The audit's recommendation was to pre-open the NEXT socket during the current
utterance. Note what that can and cannot buy: the pipeline calls
`synthesizeStream` once per sentence chunk, so a socket warmed during chunk N
serves chunks N+1..M. **Chunk 1 — the one that sets time-to-first-audio — still
pays the full handshake**, unless a *standing* warm socket is maintained across
the LLM think time and turn detection, which is the genuinely unsafe version.
So the ~250-300ms would come off **mid-reply chunk boundaries, not off
time-to-first-audio**, which the brief names as what we primarily care about.

### 6. The safest alternative, specified — for a pass that is allowed to do it

Not implemented here, because it exceeds "the smallest scoped reuse mechanism"
and touches the session lifecycle, which is on the protected list:

1. Add an **optional** `disposeSession?(sessionId)` to `TextToSpeechProvider`
   (permitted — provider interfaces may only gain optional members, §4.3) and
   call it from the one place a session tears down.
2. Key warm sockets **by `sessionId`** (already on `SynthesisTaskRequest`), at
   most one per session, **never shared across sessions**.
3. Hand out only a **VIRGIN** socket — one on which no `config` and no `text`
   has ever been sent. Then no two utterances ever share a socket and the
   boundary problem cannot arise at all. This is the property that makes the idea
   sound; a socket that has already carried audio must never be reused.
4. Idle-expire warm sockets well inside the ~7s idle the vendor was observed to
   tolerate, and close on abort, on dispose and on process shutdown.

Until all four exist, the measured 250-300ms is **not worth the risk of playing
one caller's audio into another reply.** Sarvam is already the fastest lane in
production (492ms p50 / 817ms p90).

---

## FIX #3 PHASES A+B — FULL REGRESSION RESULTS

`npx tsc --noEmit --incremental false` — **clean** (run after every edit, and
with `--incremental false` because a stale `tsconfig.tsbuildinfo` can let
`npm run typecheck` pass on a file that does not parse).

Run with `CAMPAIGN_DIALING_ENABLED=false`, per the environment trap in §7.

| Suite | Result | Prior baseline |
|---|---|---|
| `test:sarvam-stream` | **17 passed**, 0 failed | new (PHASE A) |
| `test:smallest-stream` | **24 passed**, 0 failed | new (PHASE B) |
| `test:attention` | 23 passed, 0 failed | 23 — unchanged |
| `test:continuity` | 28 passed, 0 failed | 28 — unchanged |
| `test:barge-in` | 27 passed, 0 failed | 27 — unchanged |
| `test:pronunciation` | 21 passed, 0 failed | 21 — unchanged |
| `test:turn-release` | 14 passed, 0 failed | 14 — unchanged |
| `test:speaking-watchdog` | 6 passed, 0 failed | 6 — unchanged |
| `test:stt-clock` | 10 passed, 0 failed | 10 — unchanged |
| `test:end-of-speech` | 17 passed, 0 failed | 17 — unchanged |
| `test:agent-hangup` | 23 passed, 0 failed | 23 — unchanged |
| `test:tts-streaming` | 21 passed, 0 failed | 21 — unchanged |
| `test:phase8` / `test:phase9` / `test:phase10` | 19 / 20 / 12 passed, 0 failed | 19 / 20 / 12 — unchanged |

**No suite regressed. No expectation was retired, no assertion was weakened, and
no existing test was changed to accommodate either phase.** The only test file
edits in this pass are the two NEW suites.

### The critical pipeline suites, run 3x each — no flakes

```
test:attention        run1=23/0f  run2=23/0f  run3=23/0f
test:continuity       run1=28/0f  run2=28/0f  run3=28/0f
test:barge-in         run1=27/0f  run2=27/0f  run3=27/0f
test:end-of-speech    run1=17/0f  run2=17/0f  run3=17/0f
test:agent-hangup     run1=23/0f  run2=23/0f  run3=23/0f
test:tts-streaming    run1=21/0f  run2=21/0f  run3=21/0f
test:sarvam-stream    run1=17/0f  run2=17/0f  run3=17/0f
test:smallest-stream  run1=24/0f  run2=24/0f  run3=24/0f
```

### One PRE-EXISTING flake, identified and proven not ours

`test:phase9` `C1` ("a confirmed FINAL_YES ends the call instead of waiting out
the silence") fails intermittently. It was caught during PHASE A's regression run
and investigated before continuing, as the brief requires.

**It is not caused by this pass.** With `sarvam.provider.ts` reverted to its
shipped state (`git checkout`, then restored):

```
PRE-FIX  phase9 run x8:  2 failures  (runs 2 and 7)
WITH FIX phase9 run x6:  1 failure   (run 4)
```

The mechanism is clear: `C1` asserts `elapsedMs < 5_000` — a **wall-clock**
bound on a test that drives a real call loop against a real Postgres with a
500ms watchdog tick. And `phase9` never imports the Sarvam provider at all: its
only dynamic import is `script-registry`, and its fixture campaign is
`'{"cartesia":100}'`. **Left alone deliberately** — tightening or loosening a
timing assertion to make a run green is exactly what §4.2 forbids.

---

## FIX #3 — CONSOLIDATED PROVIDER COMPARISON (latency, cost, real-call watch list)

### Time-to-first-audio, per provider, before and after

Measured, not estimated. **"Before" for Cartesia and Smallest AI is the
production p50/p90 from `call_metrics.raw.turnLatencies` (392 real turns);
"after" is measured through the real provider class against the live vendor**,
so the two columns are not the same instrument — the vendor-probe figures include
this machine's RTT and are therefore pessimistic relative to the production
server. The *saving* transfers; the absolute "after" does not.

| Provider | Path before | Path after | First audio before | First audio after | Change |
|---|---|---|---|---|---|
| **Cartesia** | batch bytes | SSE (§0) | 827ms p50 / 1375ms p90 | 159-329ms, flat | **-470 to -1350ms** (§0, unchanged this pass) |
| **Sarvam** | WebSocket | WebSocket | 492ms p50 / 817ms p90 | **unchanged — 492 / 817** | **0ms by construction** (see below) |
| **Smallest AI** | batch `arrayBuffer()` | **SSE (PHASE B)** | 958ms p50 / 1928ms p90 | 519-730ms | **-277 to -1076ms measured** |
| **ElevenLabs** | `/stream` | `/stream` | 400-500ms, flat | **unchanged — not modified** | **0ms — `git diff` is empty for this file** |

**Sarvam's first audio is unchanged, deliberately and provably.** PHASE A is a
correctness fix: the idle budget is consulted **only after the first frame has
already been yielded**, so no code before first audio was touched. Claiming a
latency win there would be false. What PHASE A changes is the **tail**:

| Sarvam cadence | Tail before | Tail after |
|---|---|---|
| 138ms frames, tight gaps (the common case) | 300ms | **300ms — unchanged** |
| 550ms frames | 300ms | 550ms |
| clip ends inside the first two frames | 300ms | 700ms |
| big drained burst (Plivo backpressure only) | 300ms | 1200ms (bounded) |

So PHASE A **costs** up to 400ms of tail in the previously-unsafe cadences and
buys a caller hearing the whole sentence. PHASE C would have been the change
that reduced Sarvam's first audio; it is closed as unsafe.

### The seven stages, measured independently

As the brief asked, and NOT reported as one number:

| Stage | Cartesia | Sarvam | Smallest AI |
|---|---|---|---|
| 1. TTS request start | t=0 | t=0 | t=0 |
| 2. provider connection / setup | SDK, pooled HTTP | **326ms** socket open (DNS 2 / TCP 73 / TLS 88 / **upgrade 169**) | TLS+HTTP inside the fetch |
| 3. first provider byte | 159-329ms | ~250ms after open (vendor needs ~70-96ms) | 519-730ms |
| 4. first application byte | same event | same frame (after the 44-byte RIFF frame is dropped) | same event |
| 5. first audio queued | + `playAudioChunk` | + `playAudioChunk` | + `playAudioChunk` |
| 6. first playback | +100ms Vobiz pre-roll (5 frames) | same | same |
| 7. complete playback | real clip duration — **unchanged on every lane** | unchanged | unchanged |

**Total playback duration is NOT reported as latency anywhere in this pass.** No
reply was shortened and no audio was cut; stage 7 is identical before and after
on all three lanes, which is exactly what `A13`/`D1` assert.

### Cost accounting — audited for EVERY provider that changed

The trap this is guarding against is §0's: Cartesia is duration-billed, and
giving it a `synthesizeStream` would have silently zeroed its TTS cost, because
`estimateTtsCost` warns and returns 0 for a duration-billed vendor with no
duration. So every newly-streaming provider was checked against the rate tables.

| Provider | Billed on | In `TTS_COST_PER_GENERATED_MINUTE_USD`? | Streaming branch passes | Result | Regression test |
|---|---|---|---|---|---|
| Cartesia | generated audio minutes | **yes** | `text.length` **and** `generatedAudioSeconds` (§0's four-line fix) | correct, non-zero | `test:tts-streaming` `B4`, `C9` |
| Sarvam | characters | no | both; duration unused | **non-zero, unchanged** | `test:sarvam-stream` `D2` |
| Smallest AI | characters | no | both; duration unused | **non-zero, unchanged** | `test:smallest-stream` `C1`, `C3` |
| ElevenLabs | characters | no | both; duration unused | unchanged, not modified | — |

**No provider silently becomes zero-cost or zero-duration.** `cost-estimator.ts`
is byte-identical — no rate, table or formula was touched. `D2`/`C1` each assert
BOTH halves: cost > 0, and cost independent of the duration argument (which is
what proves the character path is the one being taken).

### Real-call verification — REQUIRED, and NOT YET DONE

Nothing was dialed in this pass. Per lane, on the next live calls:

**CARTESIA** (§0, still unverified live)
- `[TTS:cartesia] first audio chunk in NNNms` — expect 150-350ms, and crucially
  **not growing with reply length**.
- No chunk-boundary artifacts: no clicks, seams or truncated words. Only an ear
  can confirm this.

**SARVAM** (PHASE A)
- `[TTS:sarvam] idle gap NNNms elapsed after N frames — treating utterance as
  complete (widestGap=… gaps=… delivery=…)` — the new diagnostic. **`budget` must
  always exceed `delivery`.**
- **No truncated sentences.** The failure mode is a reply that stops mid-sentence
  while the transcript records it whole, so compare the recording against the
  committed assistant turn — not the transcript alone.
- Frame counts in the double digits on multi-second replies. A `frames=2` line is
  the defect returning.
- No cross-utterance contamination (nothing was pooled, so there should be none).

**SMALLEST AI** (PHASE B)
- `[TTS:smallest-ai] first audio chunk in NNNms` — expect **~300-730ms**, down
  from 958ms p50 / 1928ms p90.
- **No chopped words and no gaps between streamed chunks** — the vendor emits
  9-40 events per utterance and the parity guard has never had to fire in
  measurement, but only an ear confirms the seams.
- The `[TTS:smallest-ai] streaming failed before any audio … falling back` warning
  should **not** appear. If it does, the stream host or credentials are wrong and
  the lane is silently paying batch latency.

**ALL LANES**
- Barge-in still cuts promptly, and the transcript still commits only the heard
  prefix.
- Background voice still logs `uncorroborated speech ignored`.
- The Hello attention flow still acknowledges once and then RESUMES (§0a).
- Continuation still resumes the exact remainder.
- The agent closing still produces `hangup_reason = 'agent_hangup:closing'` (§0b).
- Call recording unaffected.
- **Per-call TTS cost non-zero on all three lanes**, and the
  `[COST] … no generated duration was supplied` warning must never appear.

**Rollback is one method per lane.** Delete `synthesizeStream` from
`smallest-ai.provider.ts` and that lane returns to batch; delete it from
`cartesia.provider.ts` and that lane returns to batch. PHASE A's rollback is the
three new constants and the budget expression in `sarvam.provider.ts`.

---

## AUDIT (2026-08-23, fourth pass) — TTS TIME-TO-FIRST-AUDIO, ALL PROVIDERS

**Read-only pass. No production code was changed, nothing was committed, and
the uncommitted Cartesia SSE implementation (§0) was not touched.** The scope of
Fix #3 was corrected from "optimize Cartesia" to "audit and reduce avoidable TTS
time-to-first-audio across every configured provider". Probes were throwaway and
have been deleted; the working tree is exactly as §5 describes it.

### What is actually configured, and what actually carries calls

Four providers are registered in
[bootstrap.ts](src/providers/registry/bootstrap.ts) and **all four have live
credentials**. Three are campaign lanes — `CAMPAIGN_TTS_PROVIDERS` in
[campaign-types.ts](src/campaign/domain/campaign-types.ts) deliberately excludes
ElevenLabs, which stays registered and is reachable through the benchmark presets
in [provider.config.ts](src/config/provider.config.ts).

The live `RUNNING` campaign splits evenly, and the assignment is **per contact at
import time**, so all three lanes are hot simultaneously:

```
campaign "wb"  RUNNING   cartesia 33.34% | sarvam 33.33% | smallest-ai 33.33%
contacts       assigned_provider:  cartesia 409 | sarvam 385 | smallest-ai 369
```

**Smallest AI carries a third of every production call.** §3.6 and §7 recorded it
as "not investigated"; it is now investigated, and it is the largest remaining
avoidable cost in the TTS stage.

### Which path each provider is really on

`synthesizeAndPlay` branches on the optional `synthesizeStream`. **Three of the
four implement it** — so the batch-branch comment in
[conversation-pipeline.ts](src/core/session/conversation-pipeline.ts) claiming
*"Cartesia, Sarvam and Smallest AI … ElevenLabs is the sole provider with
`synthesizeStream`"* is **stale in both halves**: Sarvam has had a committed
WebSocket implementation all along, and Cartesia now has one too. Only the
comment is wrong; the feature-detection code is correct. §0's own description
("used in production today by ElevenLabs and Sarvam") was right.

| Provider | Streams? | Endpoint actually used | Waits for the whole response? |
|---|---|---|---|
| Cartesia | **yes**, uncommitted | SSE `tts.generateSSE()` (was `tts.generate()` bytes) | no |
| Sarvam | **yes**, committed | WebSocket `/text-to-speech/ws` | no, but see the 300ms tail |
| Smallest AI | **NO** | REST `api.smallest.ai/waves/v1/tts` | **yes — `arrayBuffer()`** |
| ElevenLabs | yes, committed | `/v1/text-to-speech/{id}/stream` | no |

Smallest AI is the only lane still on `postJsonForBinary`, which ends in
`await response.arrayBuffer()` — it cannot yield a byte until the last byte of
the body has landed.

### Measured — production, 392 real turns

From `call_metrics.raw.turnLatencies`. Confirmed against
[conversation-pipeline.ts](src/core/session/conversation-pipeline.ts) that the
per-turn `tts` measurement **is** `ttsFirstChunkMs` — genuine time-to-first-audio
— while `ttsSynthesisMs` is the sum across the turn's chunks. These are real
calls, so Cartesia's figures are its **batch** path (the SSE change is
undeployed) and Sarvam's are its WebSocket path.

| Provider | turns | first-audio p50 | p90 | mean | mid-conversation p50 / p90 |
|---|---|---|---|---|---|
| cartesia (batch) | 144 | 827ms | 1375ms | 925ms | 936 / 1472 |
| sarvam (WS) | 148 | **492ms** | **817ms** | 590ms | **491 / 732** |
| smallest-ai (batch) | 100 | **958ms** | **1928ms** | 1153ms | **1021 / 2029** |

**Once Fix #3 deploys, Smallest AI becomes the slowest lane by a wide margin** —
roughly double Sarvam at p50 and nearly triple at p90.

### Measured — live vendors, both paths, same text

Median of two warm samples per cell, real first audio through the real provider
classes. The slope column is what separates a vendor floor from a
render-the-whole-clip endpoint.

| Lane | 34 ch | 76 ch | 125 ch | slope |
|---|---|---|---|---|
| cartesia **batch** (bytes) | 821 | 871 | 1295 | **5.2 ms/char** |
| cartesia **stream** (SSE, §0) | **176** | **293** | **329** | 1.7 ms/char |
| sarvam **batch** (REST) | 1433 | 1933 | 3030 | **17.5 ms/char** |
| sarvam **stream** (WS, live) | 664 | 507 | 618 | ~0 (flat) |
| smallest-ai **batch** (live path) | 756 | 919 | 1571 | **9.0 ms/char** |
| smallest-ai **stream** (v3.1 SSE) | **482** | **555** | **555** | 0.8 ms/char |
| elevenlabs batch (`convert`) | 513 | 402 | 489 | ~0 (flat) |
| elevenlabs stream (`stream`, live) | 678 | 513 | 404 | ~0 (flat) |

§0's Cartesia measurement **replicates**: 5.2 ms/char against its 5.9, and a flat
SSE path. Fix #3 is confirmed correct and is not revisited.

### Smallest AI HAS a streaming endpoint — §3.6's open question, answered

§7 said *"the same fix applies if that vendor exposes a streaming endpoint; not
investigated"*. It does expose one. The retired models answer with a
machine-readable migration path (`HTTP 410 MODEL_DEPRECATED`,
`recommended_endpoint: /api/v1/lightning-v3.1/get_speech`), and alongside it:

```
POST https://waves-api.smallest.ai/api/v1/lightning-v3.1/stream
  content-type: text/event-stream     transfer-encoding: chunked
  event: audio
  data: {"audio":"<base64 PCM>"}
```

Structurally the **same shape as Cartesia's SSE** — discrete base64 audio
payloads — so a `synthesizeStream` here is a near-copy of the pattern already
reviewed in `cartesia.provider.ts`, not a new mechanism.

Head to head on identical text, two samples each:

| chars | batch first-audio | v3.1 SSE first-audio | saved | audio duration batch / SSE | SSE events |
|---|---|---|---|---|---|
| 34 | 1129 / 697 | 795 / 346 | 334 / 351 | 2.28s / 2.28s | 15, **0 odd-length** |
| 76 | 1461 / 1128 | 627 / 361 | **834 / 767** | 3.64s / 3.65s | 23, **0 odd-length** |
| 125 | 2024 / 1679 | 295 / 300 | **1729 / 1379** | 7.07s / 7.07s | 44, **0 odd-length** |

**The audio duration is identical on both paths at every length**, which is the
strong evidence that voice, model, sample rate and `speed: .92` all carry over —
the same property `A2` asserts for Cartesia by deep-equalling the two request
bodies. Every event was even-length, as with Cartesia, so no coalescing
accumulator is needed (a parity guard still is).

A second, separable cost on this lane: `arrayBuffer()` waits out the **body
transfer** as well as the render. Observed first-byte → last-byte on the current
endpoint: 53ms, 219ms, 264ms, 578ms, 683ms and once **3204ms**. Even without
switching endpoints, reading the body progressively recovers that.

### Sarvam — the vendor is fast; our implementation is the bottleneck

Sarvam's WebSocket path is already the right architecture and is the fastest lane
in production. What remains is entirely ours:

**1. A fresh WebSocket handshake per sentence chunk — 78-83% of its first-audio.**
`synthesizeStream` calls `new WebSocket(...)` on every invocation, and the
pipeline invokes it once per chunk:

```
run   socket OPEN   first audio frame   handshake share
 1        311ms            391ms            80%
 2        242ms            309ms            78%
 3        303ms            367ms            83%
 4        287ms            363ms            79%
```

Sarvam needs only **~65-80ms after the socket is open** to deliver frame one.
That also resolves the contradiction inside the file itself — the "~85-100ms" in
the `synthesizeStream` header and the "500-750ms" in the idle-gap comment are the
same event measured from **socket-open** and from **request-start**. The first
number is true and is not what the pipeline pays.

**2. A ~300ms tail on every chunk, serial by construction.** The generator does
not return until the idle gap expires, and the chunk loop is
`await this.synthesizeAndPlay(...)` — so the next chunk's request cannot even
start until it does. Measured return-after-last-frame: **304, 335, 336ms** — the
`MIN_IDLE_GAP_MS` floor, every time. This is the residue of the fixed-700ms →
adaptive change already recorded in the file.

**3. The idle gap truncates real utterances — a live correctness defect.**
`widestFrameGapMs` is 0 until two frames have arrived, so the budget collapses to
the 300ms floor exactly when the least is known. Against REST ground truth:

```
125 chars, REST ground truth 5.97s
  run1  first= 664ms  frames=17  audio=6.05s (101%)
  run2  first=1059ms  frames=47  audio=6.46s (108%)
  run3  first= 859ms  frames= 2  audio=0.82s ( 14%)   <<< TRUNCATED
  run4  first=1140ms  frames=19  audio=6.74s (113%)
```

Reproduced **2 times in 11 runs**; the worst cut a 5.97s sentence to 0.82s. The
caller hears a fragment and the pipeline believes the utterance completed, so it
is committed to history as spoken in full. This is **committed code on 33% of
live calls**, not a consequence of anything in §0/§0a/§0b.

**The end-of-stream marker really is absent** — verified, so the idle gap cannot
simply be replaced: 49 audio frames, then **10.8 seconds of nothing**, no
non-audio frame and no server close. The existing comment is correct, and that is
also why a naively pooled socket is unsafe (see the recommendation).

### ElevenLabs — measured, and NOT a bottleneck

Not a campaign lane, but configured, so it was measured rather than assumed.
Already on the streaming endpoint, and flat at ~400-500ms. Its **100ms
application-side accumulator (`MIN_YIELD_BYTES` = 1600 bytes at 8kHz) costs
0-2ms**, because the SDK's very first HTTP chunk already exceeds the gate:

```
chars   raw SDK first byte   our first yield   accumulator cost
   34          714ms              395ms              2ms
  125          417ms              387ms              0ms
```

So the one place the code *does* buffer before yielding is **not** paying for it.
This is exactly the assumption the brief warned against making, and it does not
hold. No change is warranted. Two non-latency observations recorded for whoever
next opens that file: `signal` is never passed to the SDK (so a barge-in breaks
our loop but leaves the vendor request draining — Cartesia's new path does
abort), and `voiceSettings` **differ between `synthesize` (stability 0.5 /
similarity 0.9) and `synthesizeStream` (0.42 / 0.88 / speed 0.94)** — precisely
the drift that Cartesia's shared `requestBody()` was extracted to prevent.

### Serial vs overlapped — where the time actually goes

```
LLM first token -> chunker reaches a cut point -> TTS request -> vendor first audio
   -> our first yield -> playAudioChunk -> transport -> caller
```

- **Serial, all providers:** the chunk loop awaits `synthesizeAndPlay` per chunk,
  so chunk N+1's synthesis begins only after chunk N's generator returns.
  Cartesia's tail is ~2ms, so this is free there; Sarvam pays ~300ms per
  boundary; a batch provider pays its whole clip.
- **Already overlapped, correctly:** synthesis of chunk N+1 runs against chunk
  N's *playback*, because `playAudioChunk` hands audio to the transport and only
  parks on backpressure. §0c established this and it is unchanged.
- **Not overlapped, and deliberately not changed:** nothing speculative is
  started before the chunker produces a cut point. No parallelism was introduced
  by this audit.

### Provider-by-provider answers to the ten questions

| # | Cartesia | Sarvam | Smallest AI | ElevenLabs |
|---|---|---|---|---|
| 1 Streaming supported? | yes (SSE) | yes (WS) | **yes — v3.1 SSE, unused** | yes |
| 2 Endpoint in use | `generateSSE` (§0) | `/text-to-speech/ws` | `waves/v1/tts` (batch) | `/stream` |
| 3 Waits for full response? | no | no | **yes (`arrayBuffer`)** | no |
| 4 First audio (prod p50) | 827 → ~200 expected | 492 | **958** | n/a |
| 5 Full synthesis | 2093 p50 | 2079 p50 | 1827 p50 | n/a |
| 6 App-side buffering | none | none | none | 100ms gate, **costs 0-2ms** |
| 7 Unnecessary blocking | none | **300ms idle tail per chunk** | **whole render + body transfer** | none |
| 8 Vendor the bottleneck? | no, endpoint choice was | **no — ~70ms once connected** | **partly — 9.0 ms/char render** | yes, and it is fast |
| 9 Ours the bottleneck? | was, now fixed | **yes — handshake per chunk** | **yes — batch endpoint chosen** | no |
| 10 Safest change | **none, ship §0** | pre-open the next socket | add `synthesizeStream` | none |

### Ranking of what remains

| Rank | Item | Measured first-audio today | Potential | Risk |
|---|---|---|---|---|
| 1 | **Smallest AI batch endpoint** | 1021ms p50 / 2029ms p90, **33% of calls** | **-450 to -1400ms**, flat | **Medium** — new endpoint + new code path; needs an ear on voice quality |
| 2 | **Sarvam truncation** (correctness, not latency) | loses 86% of an utterance, ~18% of runs | removes a live defect | **Low-medium** — costs ~400ms back in the early-frame window |
| 3 | **Sarvam per-chunk handshake** | 242-311ms of every chunk | **-250 to -300ms** per chunk | **Medium** — touches socket lifecycle and abort |
| 4 | Sarvam 300ms idle tail | 300ms per chunk boundary | -300ms per boundary | **High** — same knob as #2; tightening it makes truncation worse |
| 5 | Smallest AI body-transfer wait | 53-3204ms observed | recovers the transfer window | Low, but subsumed by #1 |
| 6 | Cartesia | **done (§0)** | — | — |
| 7 | ElevenLabs | 400-500ms, flat | **nothing to win** | — |

### Smallest safe change, per provider — NOT IMPLEMENTED

**Cartesia — none.** §0 is measured, tested and correct. Ship it unchanged.

**Smallest AI — add `synthesizeStream`, exactly as Cartesia's was added.** The
optional interface member per §4.3, wrapping
`POST /api/v1/lightning-v3.1/stream`, discriminating on `event: audio`, keeping a
parity guard, passing `signal`, and building its body from **one shared private
`requestBody(task)`** so `voice_id`, `sample_rate` and `speed: .92` cannot drift
from `synthesize()` — the drift ElevenLabs demonstrates is real. `synthesize()`
stays as the untouched fallback, so **rollback is deleting one method**, as it is
for Cartesia. The pipeline needs **no change at all**: Smallest AI bills per
character, so the streaming branch's existing
`estimateTtsCost(id, text.length, generatedAudioSeconds)` is already right for it
— the duration argument that §0 had to add for Cartesia is simply unused here.
Confirm on a real call that the voice is indistinguishable and that per-call TTS
cost stays non-zero.

**Sarvam — two changes, in this order, and the first is not optional.**

1. **Do not adapt the idle gap until the cadence has actually been observed.**
   Require at least two measured inter-frame gaps before using
   `widestFrameGapMs * IDLE_GAP_SAFETY_FACTOR`, and use the configured
   `SARVAM_STREAM_IDLE_GAP_MS` ceiling (700ms) until then. Observed gaps once
   flowing are 86-171ms, so the adaptive budget stays 344-684ms and the tail
   saving is kept for every frame after the third; only the 1-2 frame window —
   the one that truncates — reverts to the old, safe 700ms. This costs ~400ms on
   a genuinely very short clip and removes the defect. It is a *widening*, so it
   cannot introduce a new truncation.
2. **Take the handshake off the critical path by pre-opening the NEXT socket
   while the current utterance is still streaming.** This keeps **one socket per
   utterance**, so frame attribution stays unambiguous — which matters precisely
   because the protocol has no end-of-utterance marker, making a genuinely
   shared/pooled socket unsafe. Recovers 242-311ms per chunk, which more than
   pays back change 1. Do not attempt this before 1 lands.

**ElevenLabs — none for latency.** Optionally, and separately from this thread,
pass `signal` into the SDK call and share one `voiceSettings` object between the
two methods; both are correctness/consistency, neither is latency.

### What was NOT touched

`sentence-chunker.ts`, `turn-detection.ts`, Deepgram, endpointing, barge-in,
interruption margins, background-voice handling, conversation continuity, the
Hello/attention flow (§0a), Fix #1 hang-up (§0b), the campaign scripts, LLM
configuration, Vobiz, both media bridges, the audio pump, the watchdogs,
voicemail and recording are **all byte-identical**. No provider configuration,
env var, model, voice or sample rate was changed — the probes read the shipped
config and did not alter it. No sleep, threshold, window or margin was added or
moved. Nothing was dialed and nothing was committed.

---

## 0. This conversation (2026-08-23, third pass) — FIX #3: end-to-end voice latency, time-to-first-audio

Scope was **only** conversational latency. Fix #1 (§0b) and Fix #2 (§0a) were
not touched — both re-verified green, and Fix #2's behaviours are now
additionally asserted on the new code path (see `C6`/`C7` below). The change is
**uncommitted**. Typecheck is clean and **every suite is green at its exact
prior baseline**. Nothing was deployed and no call was placed.

### Root cause — Cartesia's batch endpoint renders the WHOLE clip before returning byte one

`synthesizeAndPlay` has two branches, chosen by whether the TTS provider
implements the optional `synthesizeStream`.
[cartesia.provider.ts](src/providers/text-to-speech/cartesia.provider.ts)
implemented only `synthesize()`, so every campaign call on the Cartesia lane
took the **batch** branch — and `tts.generate()` posts to Cartesia's *bytes*
endpoint, which cannot return a single byte until the entire utterance has
rendered. Time-to-first-audio for a chunk therefore **equalled full synthesis
time for that chunk, and grew with its length**.

Measured against the live account (`sonic-3.5`, 16kHz, the shipped
`generation_config`), on the REAL first chunks this campaign's replies produce
— two samples each, warm connection:

| first chunk | `tts.generate()` (bytes) | `tts.generateSSE()` | saved | clip |
|---|---|---|---|---|
| 27 chars | 700ms | 230ms | **470ms** | 2880ms |
| 68 chars | 812ms | 163ms | **649ms** | 3760ms |
| 109 chars | 1120ms | 167ms | **953ms** | 6080ms |
| 140 chars | 1368ms | 159ms | **1209ms** | 8480ms |
| 146 chars | 1536ms | 184ms | **1352ms** | 8800ms |

The bytes endpoint costs **~5.9ms per character** on top of a ~540ms floor. The
SSE endpoint is **flat** — bounded by the first frame, not by the clip. Total
synthesis time and total byte count are the same on both paths (identical audio
duration per row), so this is latency bought for nothing.

**The delta is network-independent.** Both paths pay the same round trip, so it
cancels out of the difference. The absolute figures above include this machine's
RTT to Cartesia and are therefore *higher* than the production server's; the
**saving** transfers unchanged.

### Before / after latency

Production `TURN#3` / `TURN#4` decomposed. `audio-queued` is the first frame at
the transport; the caller hears it ~100ms later (the 5-frame Vobiz pre-roll).

| Stage | Before | After (expected) | Basis |
|---|---|---|---|
| turn-detected → llm-request | ~0ms | unchanged | sync string building |
| llm-request → **llm-first-token** | **~740ms** | unchanged | vendor floor, see "ruled out" |
| first token → first cut point | ~250ms | unchanged | measured 116–348ms on 6 real replies |
| **Cartesia synthesis → first byte** | **~400–1400ms** | **~160–230ms** | table above |
| **audio-queued (time-to-first-audio)** | **1383ms** | **~450–900ms** | |
| playback duration | 1664ms | **unchanged** | real audio; nothing shortened |

**Expected saving: ~470–1350ms, mean ~930ms** off time-to-first-audio — roughly
a third to a half of it. Total turn duration falls by the same amount. Playback
duration is untouched: no reply was shortened and no audio is cut.

### Explicitly investigated and ruled out — by MEASUREMENT, not assumption

- **LLM reasoning tokens.** `reasoning=0` on every probe. GPT-5.1 emits none at
  the default effort, so nothing invisible precedes the first content token.
  **No LLM configuration was changed.**
- **Prompt-cache miss.** `cached=13824 / prompt=14008` — **98.7% hit** on a
  16,014-token system prompt (master 54,727 chars + 8,677-char v3 appendix). The
  master prefix is identical across every call, so it stays warm. Not the cause.
- **`stream_options.include_usage`.** The extra usage chunk after
  `finish_reason` costs **3–13ms**. Negligible; left in place.
- **Chunk accumulation before TTS.** 116–348ms across six real replies, and it
  is genuine token-generation time, not buffering.
- **A real clause-scan defect in `sentence-chunker.ts` — found, measured, and
  deliberately NOT shipped.** `nextCutIndex` uses non-global
  `CLAUSE_BOUNDARY.exec(this.buffer)`, so it tests only the *first* clause
  boundary and abandons clause-cutting entirely if that one is under
  `MIN_FIRST_CLAUSE_LENGTH` (90) — the same defect `firstQualifyingSentenceEnd`
  already documents and fixes for sentence boundaries. A scan-forward fix was
  measured against 6 real replies: **0ms saved on all six**, because a
  qualifying *sentence* boundary always arrived first. Real, but worth nothing
  on this script. **The chunker is byte-identical.**
- **Vobiz pre-roll** (5 frames / 100ms, 120ms cap) — satisfied instantly by any
  real chunk. **`waitForOutboundReady`** — fires only on the call's first chunk
  (the greeting). **`withGracefulRetry`** — no pre-delay. **`drainPlayback`** —
  waits out real queued audio, as §0c established.
- **LLM↔TTS overlap.** Already correct for first audio: the chunker cuts at the
  first qualifying boundary and synthesis starts immediately. No speculative
  parallelism was introduced and no cancellation path was altered.

### Exact change — three files, and the pipeline change is four lines

**1. [cartesia.provider.ts](src/providers/text-to-speech/cartesia.provider.ts)
— `synthesizeStream` added (purely additive).**

The optional interface member, per the binding constraint in §4.3 — no existing
signature changed, `synthesize()` still present and still correct. Wraps
`tts.generateSSE()` from the installed SDK (`@cartesia/cartesia-js` 3.5.1).

- A private `requestBody(task)` now feeds **both** paths, so model, voice,
  `speed: 1.25`, `emotion: "neutral"`, `volume: 1.5`, language and raw
  `pcm_s16le` output cannot drift between them. **This is why voice quality is
  unchanged, and it is asserted** (`A2`) rather than asserted-by-comment.
  `synthesize()`'s own values are byte-for-byte what they were.
- Discriminates on `event.type === "chunk"`; `timestamps`,
  `phoneme_timestamps` and `done` are ignored, and `error` **throws** rather
  than silently truncating the utterance.
- `signal` is passed to the SDK, so a barge-in aborts the HTTP request instead
  of leaving Cartesia generating audio nobody will hear. A `finally` aborts
  `stream.controller` so an early `break` still releases the socket.
- **No coalescing accumulator.** ElevenLabs needs one because its SDK yields
  raw HTTP chunks that can be odd-length, which splits a PCM_16 sample and
  distorts everything after it. Cartesia's SSE events are discrete base64
  payloads: measured across two utterances (17 and 49 events, 10–200ms each),
  **every one was even-length**. Buffering would give back the latency this
  method exists to win, and sub-frame payloads are already the media bridge's
  job — its framer carries a 1..159-byte tail into the next chunk. A parity
  guard is kept anyway (`A5`) because the contract does not promise alignment
  and the failure mode is severe.

**2. [conversation-pipeline.ts](src/core/session/conversation-pipeline.ts) —
two changes, four lines of code.**

- **The cost regression this change would otherwise have caused.** The streaming
  branch called `estimateTtsCost(id, text.length)` with **no duration**. Cartesia
  is the *only* duration-billed provider in the table, and for those
  `estimateTtsCost` warns and **returns 0** — so giving Cartesia a
  `synthesizeStream` would have silently zeroed the TTS cost of every campaign
  call. The branch now accumulates `generatedAudioSeconds` per chunk and passes
  both units, exactly as the batch branch already does, and exactly as that
  branch's own comment instructed the first duration-billed vendor to arrive.
  Summing per chunk also means an utterance cut short by a barge-in bills for
  what was generated, not for the clip it would have become (`C9`).
- **`markTiming("tts-first-chunk")` added to the batch branch.** It existed
  **only** in the streaming branch, so on a batch provider the per-turn trace
  jumped straight from `llm-first-token` to `audio-queued` and the span between
  them was unattributable. **That gap is why the 635ms in the production logs
  had to be decomposed by probing the vendor instead of by reading a call.**
  Diagnostic only.

**Nothing else.** `sentence-chunker.ts`, `turn-detection.ts`, both media
bridges, `audio-codec.ts`, `vad-segmenter.ts`, the LLM provider, the STT
provider and every timing constant, threshold, window, grace and margin are
byte-identical. No sleep was added and no guard removed.

### Why the change is safe

1. **It moves Cartesia onto a pipeline branch that already exists** and is used
   in production today by ElevenLabs and Sarvam. No orchestration changed:
   `synthesizeAndPlay` already branches on `synthesizeStream`, and the
   barge-in / `interruptPlayback` / `cancelledHeardText` chain inside that
   branch is untouched.
2. **Heard-text accounting is arithmetically unchanged.**
   `spokenUtterances.push({ text, startsAtMs: this.outboundQueuedMs })` runs
   *before* either branch, so every utterance's `startsAtMs` is the same value
   it was, and `outboundQueuedMs` after a completed utterance is the same total
   (same audio). `heardSoFarText` / `unspokenTail` read only those two, so Fix
   #2 and continuity are unaffected — and `C4`/`C7` assert it on the new path.
3. **Mid-utterance barge-in becomes MORE accurate, not less.** Batch had already
   added the whole clip to `outboundQueuedMs` before a single frame was sent;
   streaming stops counting where it stopped generating. `drainPlayback` and
   `remainingSpeechMs` therefore stop claiming queued audio that was never sent.
4. **The real risk was coverage, and it is now covered.** Every other suite's
   fake TTS is batch-only — `conversation-continuity-tests.ts:214` says so:
   *"Batch-only, like Cartesia and Smallest AI — the production shape."* So
   **nothing in the suite exercised the streaming branch.** That, not the vendor
   call, was the danger in this change. `test:tts-streaming` SECTION C is the
   answer: the safety-critical behaviours re-asserted on the streaming branch.

### Tests added — `test:tts-streaming`, 21 tests

`npx tsc --noEmit --incremental false` — **clean**.
**21 passed, 0 failed — 3x, no flakes.**

The latency tests measure **real wall clock through the real pipeline** — from
the instant the language model is asked to the instant the first audio byte
reaches the transport, observed from an `outboundAudioListeners` hook. They do
not assert that a constant got smaller and do not read a number the pipeline
logged about itself. The two fake TTS providers model the two **endpoint shapes
measured above** (batch pays a per-character render before its single return;
streaming pays a flat first-frame delay), scaled down 10x so the suite runs in
seconds. The shapes are the measurement; the pipeline is real.

Measured across the three runs:

```
B1  BLOCK, same reply both ways:   batch 131-157ms  ->  stream 54-62ms   (saved 71-95ms)
B2  first chunk  41 chars:         batch 116-138ms      stream 39-58ms
    first chunk 172 chars:         batch 206-268ms      stream 42-62ms
    -> batch GREW 80-130ms with the chunk; streaming did NOT grow at all
```

| Required case | Test | What it asserts |
|---|---|---|
| 1. short normal response | `C1` | spoken once, in full, committed once, no duplicate speech |
| 2. long response | `C2` | every chunk in order, reconstructing the block **exactly** |
| 3. LLM streaming response | `B1`, `C2` | driven through the real streaming LLM path |
| 4. TTS response | `A1`–`A7` | the real Cartesia provider against a stubbed SDK — no network |
| 5. **first audio earlier than baseline** | `B1`, `B2` | measured wall clock, both branches, same reply |
| 6. **complete playback still finishes** | `B3` | **same audio bytes and same utterance texts** as batch; the reply reconstructs exactly |
| 7. barge-in during TTS | `C3` | superseded before any audio — the reply is never committed |
| 8. barge-in during playback | `C4` | only the heard prefix committed; the unheard tail is not put in the agent's mouth |
| 9. background voice | `C5` | uncorroborated `hello` → no turn, no reply, block finishes |
| 10. attention-check Hello | `C6` | one fixed acknowledgement, **zero** language-model requests |
| 11. confirmation / resume | `C7` | exact remainder resumed, no generation, nothing heard synthesized twice |
| 12. agent closing + hang-up | `C8` | closing is the last committed turn, session back in LISTENING, real `agentClosedIn` **true** |
| — voice quality unchanged | `A2` | SSE and bytes bodies **deep-equal**: model, voice, speed, emotion, volume, language, output format |
| — cost not zeroed | `B4` | Cartesia TTS cost > 0 on the streaming path |
| — cost not inflated | `C9` | an interrupted utterance bills only what it generated |
| — batch branch untouched | `C10` | a batch-only provider reaches the identical outcome |
| — vendor error surfaces | `A4` | an SSE `error` event throws instead of truncating silently |
| — sample alignment | `A5` | an odd-length event carries its orphan byte; nothing lost or reordered |
| — abort / early break | `A6`, `A7` | emission stops and the request is aborted, not just the loop exited |

**One test of my own failed first and was fixed rather than weakened.** `B2`
originally compared `SHORT` (41-char first chunk) against `BLOCK` and called the
latter "long" — but the chunker cuts `BLOCK` at its first sentence, so its first
chunk is **62 chars**, and 12ms of modelled difference sat inside scheduler
noise. The premise was wrong, not the code. `B2` now uses a single 172-character
sentence with no internal cut point (verified through the real `SentenceChunker`:
41 / 62 / 172) and **asserts its own premise** — the measured first-chunk length
— so it can never again be wrong about what it is comparing.

### Regression comparison — every existing suite at its exact prior baseline

| Suite | Result | Prior baseline |
|---|---|---|
| `test:tts-streaming` | **21 passed**, 0 failed — **3x** | new |
| `test:attention` | 23 passed, 0 failed — **3x** | 23 — unchanged |
| `test:continuity` | 28 passed, 0 failed — **3x** | 28 — unchanged |
| `test:barge-in` | 27 passed, 0 failed — **3x** | 27 — unchanged |
| `test:end-of-speech` | 17 passed, 0 failed — **3x** | 17 — unchanged |
| `test:agent-hangup` | 23 passed, 0 failed — **3x** | 23 — unchanged |
| `test:pronunciation` | 21 passed, 0 failed | 21 — unchanged |
| `test:turn-release` | 14 passed, 0 failed | 14 — unchanged |
| `test:speaking-watchdog` | 6 passed, 0 failed | 6 — unchanged |
| `test:stt-clock` | 10 passed, 0 failed | 10 — unchanged |
| `test:phase8` / `test:phase9` / `test:phase10` | 19 / 20 / 12 passed, 0 failed | 19 / 20 / 12 — unchanged |

**No suite regressed, no expectation was retired, no assertion was weakened and
no existing test was changed to accommodate this fix.**

### Protected systems verified unchanged

Not one file either suite covers was touched, and each suite is green at its
prior count:

Deepgram configuration and endpointing · `turn-detection.ts` **byte-identical**
(every threshold, silence and grace window) · `sentence-chunker.ts`
**byte-identical** (`MIN_FIRST_CHUNK_LENGTH`, `MIN_FIRST_CLAUSE_LENGTH`,
`MIN_CHUNK_LENGTH`, both forced-cut caps — despite a real defect being found in
it, see "ruled out") · barge-in / interruption logic and margins ·
background-voice detection (`interruptionCorroborated`,
`BARGE_IN_ENERGY_WINDOW_MS`, `BARGE_IN_MIN_CONFIDENCE`, `NEAR_END_SPEECH_*`) ·
RMS/VAD (`vad-segmenter.ts`) · **both Vobiz media bridges** (`PREROLL_FRAMES`,
`PREROLL_MAX_WAIT_MS`, `OUTBOUND_FRAME_MS`, `MAX_FRAMES_PER_TICK`) ·
`audio-codec.ts` · the LLM provider and its configuration · **Fix #1**
(`endsWithClosing`, `AGENT_CLOSINGS`, `agentClosedIn` — re-asserted live in
`C8`) · **Fix #2** (the attention path — re-asserted on the new branch in
`C6`/`C7`) · conversation continuity and heard-text accounting · stranded
remainder handling · FINAL_YES / FINAL_NO and `COMMIT_ANCHORS` · the campaign
scripts · the registration gate · Google Sheets · voicemail detection ·
recording · the watchdogs · concurrency · the dispatcher · retry logic.

**No timing constant, threshold, window, grace or margin was changed anywhere.
No sleep was added. No safety guard was removed. No assistant response was
shortened and no playback was cut.** TTS *provider configuration* is untouched
— the same env vars, model, voice and sample rate; only an additional endpoint
on the same vendor is now used.

### Real-call verification — NOT YET DONE

Nothing was dialed. The SSE path was exercised against the live Cartesia API
**out of process only** (a throwaway probe, since deleted), which confirmed
first-audio 149–376ms vs 1483–1913ms batch, zero odd-length events, and that an
abort stops emission after ~360ms instead of ~1500ms. It has **not** run inside
a real call. On the next live call, watch:

1. `[TTS:cartesia] first audio chunk in NNNms` — expect **150–350ms**, and
   crucially **not growing** with reply length.
2. `[TIMING:…] TURN#n tts-first-chunk +NNNms` — now emitted on **every**
   provider, so `llm-first-token → tts-first-chunk → audio-queued` finally
   decomposes in production.
3. `audio-queued` expected to land **~450–900ms** after `turn-detected`, down
   from ~1383ms.
4. **Voice quality identical** — same voice, no seams, no clicks at chunk
   boundaries, no truncated words. The bridge framer handles sub-frame
   payloads, but this is the one thing only a human ear can confirm.
5. **No duplicate speech and no repeated script** — the whole reply spoken once.
6. Barge-in still cuts promptly, and the transcript still commits only the heard
   prefix.
7. Hello attention flow, background-voice `uncorroborated speech ignored`, and
   `hangup_reason = 'agent_hangup:closing'` all behaving as in §0a / §0b.
8. Campaign cost per call **non-zero** for the Cartesia lane (the `[COST]`
   warning about a missing generated duration must never appear).

**Rollback is one line:** delete `synthesizeStream` from
`cartesia.provider.ts` and Cartesia returns to the batch branch. The two
pipeline lines are safe either way — the cost fix is correct for any streaming
provider, and the trace mark is diagnostic.

### Remaining latency bottlenecks, after this fix

1. **LLM first token, ~740ms — now the largest single stage by a wide margin
   (~60–70% of what remains).** Measured as a genuine vendor floor:
   `reasoning=0`, 98.7% prompt cache hit. The only remaining lever is the
   **16,014-token system prompt** (54,727-char master + 8,677-char appendix);
   even fully cached, a prefix that size has a real prefill cost. Shrinking it is
   a prompt-engineering decision with quality consequences, **not** a pipeline
   change, and was explicitly out of scope here.
2. **Chunk accumulation, ~250ms.** Genuine generation time. The clause-scan
   defect above is real but measured at 0ms of benefit on this script.
3. **Smallest AI is still batch-only** and still pays the full per-character
   render on its share of the campaign. The same fix applies if that vendor
   exposes a streaming endpoint; not investigated in this pass.
   **→ SUPERSEDED by the AUDIT section: it DOES expose one**
   (`/api/v1/lightning-v3.1/stream`, SSE), first audio is flat at ~300-555ms
   against 756-1571ms today, and the audio duration is identical on both paths.
   This is now the **largest** remaining TTS cost, not the third.
4. **Reply LENGTH is what the 4–10s playback measures.** Unchanged, and still a
   script/prompt decision (§3.7), not a pipeline one.

---

## 0a. Earlier this day (2026-08-23, second pass) — FIX #2: repeated caller "Hello" no longer restarts the script

Scope was **only** this defect. Fix #1 (§0b), latency and pronunciation were
not touched. The change is **uncommitted**. Typecheck is clean and **every
suite is green at its exact prior baseline**, including `test:continuity` at
28/28 — one obsolete expectation in its TEST 1 was retired and replaced by a
stricter statement of the same invariant (§0a.7). Nothing has been deployed and
no call was placed.

### The reported production behaviour

```
AI:      "Hi, I'm calling from FlexiFunnels..."
Caller:  "Hello?"          -> AI stops
Caller:  "Hello?"          -> AI regenerates from an earlier point
Caller:  "Hello?"          -> AI restarts: "Actually, I'm calling you because..."
```

### Reproduced first, through the real pipeline, before anything was changed

A throwaway probe drove the real `ConversationPipeline` (local fakes for the
four vendors only) to the exact production moment — a sentence into a block,
caller cuts in:

```
3 x "Hello?"  ->  4 LLM requests  ->  3 separately generated, separately spoken replies
discarded=" We have created Flexi Genie, ... from plain instructions."   <- never spoken, never recorded
```

Two control probes, run at the same time, confirmed the cases that were
**already correct and must stay that way**:

```
"Hello? What is this about?"   -> 2 requests, answered contextually       (unchanged)
background "hello" (conf 0.2)  -> "uncorroborated speech ignored", no turn (unchanged)
```

### Root cause — the script position is computed and then thrown away

The barge-in itself was never the defect. A "hello" over audio the caller is
hearing means the line may have gone bad, and it **must** interrupt; that
judgement is correct and is untouched. What was missing is everything after it.

There is **no attention-check turn class anywhere in the pipeline**. A bare
"Hello?" over playing audio therefore had exactly one path available: become an
ordinary user turn and be answered by a **fresh full language-model generation
over the campaign-script prompt**. Two consequences, and both are the report:

1. **The position is destroyed.** `strandedRemainder = unspokenTail(...)` is
   computed at [conversation-pipeline.ts](src/core/session/conversation-pipeline.ts)
   in the main loop and is a **local of one iteration**.
   `resumeAfterStrandedBargeIn` abandons the moment `callerHasTurnMaterial()`
   is true — and the "hello" **is** turn material — so the local goes out of
   scope and the unheard tail exists nowhere. Conversation memory holds only
   what the caller HEARD, by design, and the tail is a slice of an LLM reply,
   so it is not recoverable from the script either. The next request is then a
   full generation with no record of where the block stopped, and the likeliest
   completion is the block's own opening sentence.
   `conversation-policy.ts` already says *"never repeat a line they have
   already heard"*; that instruction cannot recover a position the pipeline
   deleted.

2. **Every repeat is a new turn and a new generation.** N hellos, N requests,
   N replies. No coalescing existed.

**Explicitly investigated and found NOT to be the cause** (measured, not
assumed) — of the eight candidates in the brief, the answer is **F + A, and
hence G**; B, C, D and E are all healthy:

- **B — interruption handling.** Correct. The barge-in is the right call.
- **C — response cancellation.** Correct. `cancelledResponseId` /
  `cancelledHeardText` behave exactly as designed.
- **D — conversation-history commit.** Already fixed in `a66b156`: the heard
  prefix **is** committed (continuity TEST 1/1b prove it). Not the defect.
- **E — heard-text accounting.** `heardSoFarText` / `unspokenTail` are correct.
  Their **output is discarded**; that is the whole of it.
- **A — turn classification.** No attention class exists; this is the missing
  half of F.
- **G — prompt/context construction.** A *consequence* of F, not an
  independent cause. Injecting "if the user says hello, continue" would be
  unsafe for exactly the reason the brief gives, and was not done.

### Exact change — the existing mechanisms, wired to a turn class

**One production file: [conversation-pipeline.ts](src/core/session/conversation-pipeline.ts).**
No new state machine, no second barge-in path, no timing constant, no
threshold, no sleep.

1. **`heldScriptRemainder`** — `strandedRemainder` promoted from a loop local
   to a field, set **only** when `resumeAfterStrandedBargeIn` declined to speak
   it, cleared by the first turn that is not an attention check. This is the
   one piece of state the fix adds, and it is genuinely irreducible: the value
   exists nowhere else once the local goes out of scope (see root cause 1).
2. **`attentionEpisodeOpen`** — one boolean, and the proof it cannot be derived
   from history is that **the acknowledgement can itself be barged in on**, so
   what is committed is a *truncated prefix* of it and no exact reading of the
   last assistant turn identifies an open episode. That is precisely the case
   (a second "hello" over the acknowledgement) the flag exists for.
3. **`isAttentionCheck(text)`** — exported pure predicate over a closed
   vocabulary, next to `BARE_GREETING_ONLY` in the same file. The **whole**
   utterance must be presence-check words, which is what keeps
   `"Hello? What is this about?"` on the normal path. Exported for the same
   reason `unspokenTail` is: the boundary is the entire safety case and a test
   must be able to assert both sides of it.
4. **`handleAttentionCheck(...)`** — read in the main loop **between the user
   turn being committed and the language model being called**. Three outcomes:
   *resume* the held remainder, *acknowledge* once, or *decline* (everything
   else, which then takes today's path untouched).
5. **`speakAttentionUtterance(...)`** — speaks one fixed line through the
   existing `beginAssistantResponse` / `speakFixedUtterance` /
   `isResponseCancelled` / `cancelledHeardText` chain, so a caller who talks
   over the acknowledgement is a barge-in like any other and **nothing they did
   not hear is put into the assistant's mouth**.
6. **`resumeAfterStrandedBargeIn` now returns `boolean`** — private method,
   purely additive: every guard and every decision inside it is byte-for-byte
   what it already was. `false` is the signal that the remainder is still an
   unspoken position and may be held.

**Bounded to the one case it is for.** The acknowledgement is only ever given
when a cancelled reply left an unheard remainder. With nothing held — a "hello"
at turn 0, a "hello" after a block finished — every utterance takes the
contextual path it takes today. That is also why the voicemail window is
unaffected: `metrics.recordTurn` has advanced `turnIndex` past 0 before this
can run.

**The RESUME branch is bounded without a counter.** Each resume speaks a strict
suffix of what was held and re-holds only what is still unheard, so each round
is strictly shorter. A caller who keeps interrupting hears the block *advance*,
never repeat.

### Behaviour, before and after (probe output, verbatim)

```
BEFORE                                   AFTER
hello #1 -> LLM reply                    hello #1 -> "Hello, can you hear me? "  (no LLM)
hello #2 -> LLM reply                    hello #2 -> "We have created Flexi Genie, ..."   (no LLM, exact resume)
hello #3 -> LLM reply                    hello #3 -> contextual reply, full history shown
4 LLM requests                           2 LLM requests
```

### Deliberate, documented limits (degraded, never wrong)

- **A barge-in during a RESUMED remainder credits the whole remainder as
  heard.** `speakFixedUtterance` queues a fixed utterance in one
  `synthesizeAndPlay` call, so `spokenUtterances` has one entry for it, and
  `heardSoFarText`'s documented rule is that the utterance still playing counts
  as heard. So a *third* hello during the resume finds nothing left to hold and
  falls to the contextual path — with the full history in front of the model.
  Making it granular means changing how a fixed utterance is queued, which is
  playback/TTS territory this pass is forbidden to touch. Pre-existing:
  `resumeAfterStrandedBargeIn` has always committed its remainder whole.
- **An attention check with nothing held takes the normal path.** "Are you
  there?" into dead air while the agent is LISTENING is not covered — there is
  no position to resume from. This is today's behaviour, not a regression, and
  asserted in `I2` so the limit is visible.
- **A hello before a single frame has played is still absorbed entirely** by
  the existing `isBackchannel` window (`outboundPlaybackStartedAt === 0`) and
  never reaches this code. Unchanged, and it is the better outcome.
- **The acknowledgement contains a question mark**, so
  `answersACommitQuestion`'s look-back stops on it. That is the correct
  reading — a "yes" right after "can you hear me?" is answering *that* — and
  it is not reachable at the gate anyway: if the gate question was fully heard
  the remainder is empty and no acknowledgement is given. When the gate
  question was cut off, the resume re-speaks it, and the caller's "yes" then
  lands directly after an assistant turn containing the anchor.

### 0.7 The obsolete `test:continuity` TEST 1 assertion — RESOLVED

**Status: resolved. `test:continuity` is back to 28 passed / 0 failed, and the
invariant it protects is now asserted more strictly than before.** The design
of Fix #2 was accepted; only the obsolete expectation was retired. **No
production code was changed to make this pass.**

#### What was obsolete, and why it was an expectation about the MECHANISM

TEST 1 originally asserted that a mid-block "hello" **produced a
language-model request**, and then inspected that request's history:

```ts
// removed
await h.waitFor("the reply after the interruption", () => h.requests.length >= 2);
```

That was the correct shape of the **first** remedy for this defect (`a66b156`).
The model was going to be asked either way, so the only thing that could be
fixed was WHAT IT WAS TOLD — which is why the file's own header says it asserts
"the fix at the only place it can be asserted honestly: what the model is
TOLD".

Fix #2 removes the question. A bare attention check is answered from the script
position the pipeline already computed, so it spends **no generation at all** —
strictly stronger than showing the model the right history, because a
generation that never happens cannot restate a line. "Hello must produce a
request" and "hello must not reach the model" cannot both hold; the first is a
statement about the old mechanism, not about continuity.

#### What replaced it — the property, not the mechanism

TEST 1 still owns the invariant and now asserts all six parts of it:

| Property | Assertion |
|---|---|
| heard assistant content stays in history | `spoken[1]` starts with the block's first sentence (**unchanged**) |
| the hello is answered, briefly | `spoken[2]` contains "can you hear me" (**new**) |
| **no unnecessary generation** | `requests.length` is **unchanged** across the hello (**new — the inverse of the retired assertion**) |
| the unheard remainder is not lost | after "Yes, I can hear you.", `spoken[3]` starts at `"We have created Flexi Genie"` (**new**) |
| the resumed portion is preserved exactly | `heard + resumed === BLOCK_B`, whitespace-normalised — nothing lost, nothing doubled (**new**) |
| resuming spends no generation either | `requests.length` still unchanged (**new**) |
| the next substantive turn still gets a reply | one — and exactly one — generation for the whole episode (**new**) |
| **that request receives the correct context** | its history contains the opening, the heard block **and** the resumed part (**the ORIGINAL assertions, unweakened, plus the resumed part**) |
| already-heard content is never regenerated | the opening and the block's first sentence are each synthesized **exactly once** for the whole call (**new**) |

#### Exact test change — one file, additive apart from the retired wait

```
M  src/campaign/tests/conversation-continuity-tests.ts   +119/-5
```

Removed, in full — nothing else:

```
-    await h.waitForReplies(2);
-    // THE REGRESSION. The next request the model receives must contain
-    // both — otherwise it has no way to know it already said them, and
-    // starts the script again.
-    await h.waitFor("the reply after the interruption", () => h.requests.length >= 2);
```

`waitForReplies(2)` became `waitForReplies(3)` for a mechanical reason worth
recording: the part of the block that PLAYED is itself the second assistant
turn, committed before the acknowledgement is prepared, so waiting for two
returned early and the caller's next line merged into the same turn. Three is
opening + heard block + acknowledgement.

Both original assertions — `shown.includes(OPENING)` and
`shown.some(startsWith("Actually, I am calling you"))` — are **retained
verbatim**, now read from the request the substantive turn produces. A third,
`shown.some(startsWith("We have created Flexi Genie"))`, was added.

A ~35-line note above SECTION A records the same reasoning in the test file
itself, so the next reader does not have to come here for it.

**No coverage was deleted.** Supporting coverage, all green and all untouched:
continuity **TEST 1b** (only the played part is committed) and **TEST 2** (a
contextual question does not rewind the script), and `test:attention`
**C1/C3/C4/H1/H2**.

### Files changed

```
M  src/core/session/conversation-pipeline.ts      tables + 2 fields + 2 methods +
                                                  main-loop hook + hold site;
                                                  resumeAfterStrandedBargeIn -> boolean
A  src/campaign/tests/attention-check-tests.ts     23 tests, sections A-I
M  package.json                                    + "test:attention" script
```

**Exactly one production file.** `turn-detection.ts` is byte-identical.

### Test results

`npx tsc --noEmit --incremental false` — **clean**.

| Suite | Result | Prior baseline |
|---|---|---|
| `test:attention` | **23 passed**, 0 failed — **3x, no flakes** | new |
| `test:continuity` | 28 passed, 0 failed — **3x** | 28 — count unchanged; TEST 1 re-pointed, see §0a.7 |
| `test:barge-in` | 27 passed, 0 failed | 27 — unchanged |
| `test:pronunciation` | 21 passed, 0 failed | 21 — unchanged |
| `test:turn-release` | 14 passed, 0 failed | 14 — unchanged |
| `test:speaking-watchdog` | 6 passed, 0 failed | 6 — unchanged |
| `test:stt-clock` | 10 passed, 0 failed | 10 — unchanged |
| `test:end-of-speech` | 17 passed, 0 failed | 17 — unchanged |
| `test:agent-hangup` | 23 passed, 0 failed | 23 — unchanged |
| `test:phase8` / `test:phase9` / `test:phase10` | 19 / 20 / 12 passed, 0 failed | 19 / 20 / 12 — unchanged |

**What each required case is asserted by:**

| Case | Test | What it asserts |
|---|---|---|
| A. single "Hello?" during speech | `B1`, `B2` | one fixed acknowledgement, ≤60 chars, **zero** language-model requests |
| B. Hello -> Hello -> Hello | `B3`, `B4`, `C3` | the acknowledgement is spoken **exactly once**; the opening and the block's first sentence are each spoken exactly once |
| C. Hello then confirmation | `C1`, `C2`, `C4` | "Yes, I can hear you." and a bare "Haan" both resume at the exact stopping point, with no language-model request; the model is later shown all three parts |
| D. Hello + real question | `D1`, `D2`, `A2` | answered contextually, no acknowledgement, and the stale position is released |
| E. background "hello" | `E1`, `E2` | no attention response, **no turn created**, and the block finishes |
| F. backchannel "okay" | `F1`, `A3` | still absorbed: no turn, no acknowledgement, block finishes |
| G. meaningful interruption | `G1`, `G2` | normal barge-in, model answers, only the heard part committed |
| H. already-heard text | `H1`, `H2` | nothing heard is synthesized twice; heard prefix + resume reconstruct the block **exactly**, nothing lost or doubled |
| I. one response per episode | `B3` | acknowledgement count is exactly 1 |
| J. normal conversation after | `I1`, `I2` | the next real question is answered normally and the session returns to LISTENING |
| — vocabulary tripwire | `A1`-`A4` | 17 attention forms match; 12 content-bearing forms and 8 backchannels do not |

**Protected systems verified unchanged** — no file touched, and the suite that
covers each is green at its prior count:

Deepgram configuration and endpointing · turn-detection thresholds, silence and
grace windows · `turn-detection.ts` **byte-identical** (`isBareAcknowledgement`,
`ACKNOWLEDGEMENT_TOKENS`, `FILLER_ONLY`, every constant) · barge-in /
interruption logic and margins · background-voice handling
(`interruptionCorroborated`, `BARGE_IN_ENERGY_WINDOW_MS`,
`BARGE_IN_MIN_CONFIDENCE`) · RMS/VAD (`vad-segmenter.ts`) · both Vobiz media
bridges · `audio-codec.ts` · TTS provider and Cartesia configuration · LLM
configuration · the campaign scripts and `COMMIT_ANCHORS` · voicemail detection
· recording · call-ending / `agentClosedIn` / `endsWithClosing` (**Fix #1
untouched**) · FINAL_YES / FINAL_NO · the registration gate · Google Sheets ·
the watchdogs · concurrency · the dispatcher · retry logic · the §0b
end-of-speech latency change.

Not one timing constant was changed, no sleep was added, and no latency or
pronunciation work was done in this pass.

### Real-call verification — NOT YET DONE

Nothing was dialed. On the next live call, watch for:

1. `[PIPELINE:…] attention check — acknowledging once:` appearing **at most
   once** per episode.
2. `[PIPELINE:…] attention check answered — RESUMING from where the reply
   stopped:` on the following "hello" or confirmation, and the caller hearing
   the block **continue**, not restart.
3. The opening line appearing exactly once in the call transcript.
4. Background voices still producing `uncorroborated speech ignored`.
5. `hangup_reason` and FINAL_YES behaving exactly as in §0b.

---

## 0b. Earlier this day (2026-08-23) — FIX #1: automatic hang-up after a genuine agent closing

Scope was **only** this defect. Fix #2 (Hello/attention-check), latency and
pronunciation were not touched. The change is **uncommitted**. Typecheck is
clean and every suite below passes three times in a row at its exact prior
baseline. Nothing has been deployed and no call was placed.

> **COMMITTED as `5dee8aa` ("Hangup fix").** The text below still says the
> change is uncommitted; that was true when it was written and is not any more.

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

## 0c. Previous conversation (2026-08-22) — two production defects, now COMMITTED as `498662a` / `98b7060`

Both changes have since been **committed**. Kept here because §0a above
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

- **Nothing is mid-edit.** The files in §5 are Fix #3 (all three lanes) and
  Fix #2 (Hello / attention check), all uncommitted — review, then commit. No
  commit was made, by request. Fix #1 is already in `5dee8aa`.
- **Fix #3 PHASE A is done (Sarvam truncation).** A live correctness defect on a
  third of all calls is closed: the idle budget was calibrated BELOW the vendor's
  own 413-550ms delivery quantum. `test:sarvam-stream`, 17 tests, and the suite
  was verified to FAIL 4/17 against the pre-fix provider.
- **Fix #3 PHASE B is done (Smallest AI streaming).** The largest remaining
  avoidable TTS cost is removed: **277-1076ms** of measured first audio on a
  third of all calls. `test:smallest-stream`, 24 tests.
- **Fix #3 PHASE C is closed as NOT SAFE TO IMPLEMENT**, with the evidence in
  its own section: a reused Sarvam socket emits **one RIFF header for three
  utterances and zero non-audio frames**, so utterance A and utterance B are
  indistinguishable on it; the provider is a **process-wide singleton** shared by
  all three concurrent calls; and **no provider interface has any teardown
  hook**. The one safe client-side lever (TLS session resumption) measured
  **13ms**.
- **Fix #3 is implemented, tested and complete (§0).** Cartesia now streams its
  synthesis (`synthesizeStream` via the SSE endpoint), which is the largest
  measured time-to-first-audio contributor: **~470-1350ms, mean ~930ms**. The
  pipeline change is four lines — one of them fixing a cost-accounting
  regression the change would otherwise have introduced. Not yet validated on a
  real call; the eight watch items are at the end of §0.
- **Fix #2 is implemented, tested and complete (§0a).** Its one conflict with an
  obsolete `test:continuity` expectation was resolved by retiring that
  expectation and asserting the underlying invariant instead (§0a.7) — no
  production change was made for it. Not yet validated on a real call. Its
  behaviour is additionally asserted on Fix #3's new code path (`C6`/`C7`).
- The live campaign is on the **pilot ladder at rung 1 (10 calls)** —
  `CAMPAIGN_STAGE_MAX_CALLS=10`.

---

## 3. Pending

| # | Item | Blocked on |
|---|---|---|
| 1 | Commit the three fixes (§0 Fix #3, §0a Fix #2; §0b Fix #1 already in `5dee8aa`) and roll them to production | Review |
| 2 | Raise `CAMPAIGN_STAGE_MAX_CALLS` past 10 and advance the pilot ladder | Phase 6 §H gates green for the current rung |
| 3 | Caller-ID / DID rotation | **External:** the DID list from Vobiz + whether `from` can be set per call |
| 4 | AMD / voicemail detection | Design decision — minimal additive proposal in Phase 6 §E, not implemented |
| 5 | Auto-resume after a run stops | Not started; one of the two real blockers on 2,000-call days |
| 6 | ~~Streaming TTS for Cartesia~~ — **DONE, see §0 (Fix #3)** | — |
| 7 | Reply LENGTH is what the 4–10s drain measures | Script/prompt decision, not code |
| 8 | ~~Streaming TTS for Smallest AI~~ — **DONE, see PHASE B** | — |
| 9 | ~~Sarvam idle-gap truncation~~ — **DONE, see PHASE A** | — |
| 10 | **Sarvam per-chunk WebSocket handshake** — 242-326ms | **CLOSED as unsafe, see PHASE C.** Reopening it requires the four preconditions listed there, starting with an optional `disposeSession?()` on the TTS interface |
| 11 | **Real-call verification of all three TTS lanes** | Nothing — the watch lists are at the end of §0, PHASE A and PHASE B |

**§3.6 is now DONE — see §0 (Fix #3).** `synthesizeStream` was added to
[cartesia.provider.ts](src/providers/text-to-speech/cartesia.provider.ts) as a
purely additive optional interface member, wrapping the SDK's `tts.generateSSE()`.
The saving was measured against the live account rather than estimated:
**470-1350ms, mean ~930ms**, because the bytes endpoint costs ~5.9ms per
character of transcript while the SSE endpoint is flat at ~160-230ms. Voice
quality is unchanged and asserted so — both paths now build their request from
one shared `requestBody`, so model, voice, speed, emotion, volume, language and
output format cannot drift. The largest remaining latency item is now **LLM first
token (~740ms)**, which measured as a genuine vendor floor (`reasoning=0`, 98.7%
prompt cache hit); the only lever left there is the 16,014-token system prompt,
which is a prompt-engineering decision, not a pipeline one. See §0.

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
   non-continuation tail** (`endsWithClosing`, §0b). Widening either half of that
   rule — the tail cap or `CLOSING_CONTINUATION_WORDS` — is what re-opens the
   false positive that hangs up on a live conversation. `test:agent-hangup`
   `G3`/`G4` are the tripwires; do not relax them to make a change pass.

---

## 5. Files changed, still UNCOMMITTED

**Fix #3 PHASE A + PHASE B (Sarvam truncation, Smallest AI streaming) — THIS pass:**

```
M  src/providers/text-to-speech/sarvam.provider.ts      PHASE A: the idle budget only.
                                                        + MIN_OBSERVED_GAPS_BEFORE_ADAPTING,
                                                        + MAX_IDLE_GAP_MS, + a delivery-quantum
                                                        floor measured per drain pass, + one
                                                        diagnostic log line. synthesize(), the
                                                        REST fallback, RIFF stripping, the parity
                                                        guard, the abort path, the socket
                                                        lifecycle, IDLE_GAP_SAFETY_FACTOR and
                                                        MIN_IDLE_GAP_MS are all UNCHANGED.
M  src/providers/text-to-speech/smallest-ai.provider.ts PHASE B: + synthesizeStream (SSE, additive)
                                                        + private requestBody() shared by both
                                                        paths so voice/rate/format/speed cannot
                                                        drift + audioFromRecord() + streamBaseUrl
                                                        config. synthesize() unchanged in behaviour
                                                        (now builds its body from requestBody).
M  src/core/session/conversation-pipeline.ts            PHASE B: ONE COMMENT corrected in the batch
                                                        branch (it named the wrong providers as
                                                        batch-only). ZERO lines of code.
A  src/campaign/tests/sarvam-stream-tests.ts            17 tests, sections A-D
A  src/campaign/tests/smallest-ai-stream-tests.ts       24 tests, sections A-C
M  package.json                                         + "test:sarvam-stream", "test:smallest-stream"
```

**Two production files, and the pipeline change is a comment.** `elevenlabs.provider.ts`
is byte-identical (`git diff` is empty for it) — it was measured and deliberately
left alone. `cartesia.provider.ts` carries only §0's earlier work and was not
touched this pass. `sentence-chunker.ts`, `turn-detection.ts`, both media
bridges, `audio-codec.ts`, `vad-segmenter.ts`, `call-runner.ts`, the cost
estimator, the classifier, the campaign scripts and every config, env and
migration file are byte-identical. No existing test was changed.

**One new OPTIONAL env var**, with a default that matches the measured vendor
host, so nothing has to be set for this to work:

```
SMALLEST_AI_STREAM_BASE_URL   default https://waves-api.smallest.ai
```

**Fix #3 — Cartesia SSE (§0), EARLIER pass:**

```
M  src/providers/text-to-speech/cartesia.provider.ts   + synthesizeStream (SSE, additive);
                                                       + private requestBody() shared by
                                                       both paths so generation params
                                                       cannot drift. synthesize() unchanged.
M  src/core/session/conversation-pipeline.ts           streaming branch: accumulate
                                                       generatedAudioSeconds and pass it to
                                                       estimateTtsCost (fixes a silent
                                                       zeroing of Cartesia TTS cost);
                                                       batch branch: markTiming("tts-first-chunk")
                                                       trace parity.  FOUR lines of code.
A  src/campaign/tests/tts-streaming-latency-tests.ts   21 tests, sections A-C
M  package.json                                        + "test:tts-streaming" script
```

**Four lines of production code in the pipeline.** `sentence-chunker.ts`,
`turn-detection.ts`, both media bridges, `audio-codec.ts`, `vad-segmenter.ts`
and both other TTS providers are byte-identical. No config, env or migration
file was modified, and no existing test was changed.

**Fix #2 — Hello / attention check (§0a), previous pass:**

```
M  src/core/session/conversation-pipeline.ts    attention-check tables, isAttentionCheck
                                                (exported), heldScriptRemainder,
                                                attentionEpisodeOpen, handleAttentionCheck,
                                                speakAttentionUtterance, the main-loop hook,
                                                the hold site, and
                                                resumeAfterStrandedBargeIn -> boolean
A  src/campaign/tests/attention-check-tests.ts  23 tests, sections A-I
M  package.json                                 + "test:attention" script
```

**Exactly one production file.** `turn-detection.ts` is byte-identical. No
config, env or migration file was modified. The only existing test touched is
`conversation-continuity-tests.ts` TEST 1, where **one obsolete assertion was
retired and the invariant it stood for is now asserted in nine parts** — see
§0a.7 for the full before/after. No coverage was deleted and no assertion was
weakened.

```
M  src/campaign/tests/conversation-continuity-tests.ts   +119/-5   TEST 1 re-pointed (§0a.7)
```

**Fix #1 — agent hang-up (§0b) — COMMITTED as `5dee8aa`, no longer pending:**

```
src/campaign/dispatch/call-runner.ts       endsWithClosing: bounded trailing tail
                                           + CLOSING_CONTINUATION_WORDS
src/campaign/tests/agent-hangup-tests.ts   section G (5 tests) + A4/A5
```

The eight files listed here in an earlier revision are also **committed**
(`498662a`, `98b7060`).

---

## 6. Test results — Fix #1 (agent hang-up)

> Fix #2's results, including the one regression, are in **§0**. The table
> below is the Fix #1 pass and is the baseline Fix #2 was measured against.

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
existing manual-hangup behaviour · the Hello / attention-check behaviour
(which Fix #2, §0a, has since changed — that list is the state as of the
Fix #1 pass).

Not one timing constant was changed, and no latency or pronunciation work was
done in this pass.

---

## 7. Current errors / known issues

**Open product blockers**

- **Single caller ID for every call.** Runs above 500 calls per DID are BLOCKED
  by readiness check 8.
- **No AMD.** A voicemail is scored as a normal answered call.
- **No auto-resume.** A stopped run must be restarted by hand.

**Remaining latency, after the §0 (Fix #3) and §0b fixes**

- **LLM first token, ~740ms — now the largest single stage, ~60-70% of what
  remains.** Measured as a genuine vendor floor: `reasoning=0` (GPT-5.1 emits no
  reasoning tokens at the default effort) and a 98.7% prompt cache hit
  (`cached=13824 / prompt=14008`). The only lever left is the **16,014-token
  system prompt** (54,727-char master + 8,677-char v3 appendix) — a
  prompt-engineering decision with quality consequences, not a pipeline change.
- ~250ms of chunk accumulation before the first TTS request. Genuine token
  generation, not buffering.
- **Cartesia batch synthesis is FIXED (§0).** It was 400-1400ms on the first
  chunk of every turn, scaling at ~5.9ms per character; the SSE endpoint is flat
  at ~160-230ms.
- ~~**Smallest AI is still batch-only**~~ — **FIXED, see PHASE B.**
  `synthesizeStream` now wraps `/api/v1/lightning-v3.1/stream`; measured
  **-277 to -1076ms** of first audio, with duration and byte count matching batch
  to 0.1% on means. Note the endpoint is on a **different host**
  (`waves-api.smallest.ai`); `api.smallest.ai` returns 404 for it.
- ~~**Sarvam's adaptive idle gap truncates utterances**~~ — **FIXED, see
  PHASE A.** Root cause was deeper than the AUDIT recorded: the 300ms floor sat
  **below the vendor's own 413-550ms delivery quantum**, and the audit's
  `frames=2, audio=0.82s` is exactly two 6600-byte frames. The budget now has a
  warm-up, a delivery-quantum floor measured from the stream, and a 1200ms hard
  bound.
- **Sarvam's per-chunk WebSocket handshake (326ms median) is NOT fixed and is
  closed as unsafe — see PHASE C.** A reused socket emits **one RIFF header for
  three utterances and zero non-audio frames**, so there is no way to tell
  utterance A from utterance B on it; the provider is a **process-wide singleton**
  shared by all three concurrent calls; and **no provider interface has a
  teardown hook**. 52% of the handshake (169ms) is the vendor answering the
  upgrade, which is not client-optimizable, and TLS session resumption measured
  **13ms**. Reopening this needs the four preconditions in that section.
- A real clause-scan defect in `sentence-chunker.ts` (`CLAUSE_BOUNDARY.exec`
  tests only the FIRST clause boundary, so clause-cutting is abandoned whenever
  that one is under 90 chars) was found, measured at **0ms of benefit** on six
  real replies, and deliberately **not** shipped. See §0.
- The 4–10s "playback drain" is the agent genuinely speaking; it is a reply-length
  question (§3.7), not a pipeline one.
- The §0b fix helps **only** on turns where Deepgram splits the words and the
  endpoint across two messages. A turn where `speech_final` already rode on the
  words was on the fast path before and is unchanged.

**Known limits of the Hello / attention-check fix (§0a)** — all deliberate

- **A barge-in during a RESUMED remainder credits the whole remainder as
  heard**, so a third "hello" during the resume finds nothing left to hold and
  falls to the contextual path (with the full history shown). A fixed utterance
  is queued in one `synthesizeAndPlay` call, so `spokenUtterances` has one entry
  for it; making it granular is playback/TTS territory this pass could not
  touch. Pre-existing — `resumeAfterStrandedBargeIn` has always committed its
  remainder whole.
- **An attention check with nothing held takes the normal path.** "Are you
  there?" into dead air while the agent is LISTENING has no position to resume
  from. Today's behaviour, not a regression; asserted in `I2`.
- **A re-worded acknowledgement is pipeline text, not script text** —
  `attentionAcknowledgementFor` is in `conversation-pipeline.ts` alongside
  `fallbackGreeting`, so it does NOT change a script hash or `COMMIT_ANCHORS`.
- **Widening `ATTENTION_PRESENCE_PHRASES` or `ATTENTION_FILLER` is what
  re-opens the false positive** that would route a real question through the
  attention path. `test:attention` `A1`-`A4` are the tripwires; do not relax
  them to make a change pass.
- **`test:continuity` TEST 1 now asserts the property, not the mechanism.** Its
  old "a hello must produce an LLM request" expectation was obsolete the moment
  the attention path stopped consulting the model; it was retired and replaced,
  not weakened. See §0a.7.

**Known limits of the hang-up fix (§0b)** — all deliberate

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
2. **Review and commit §5** — the Fix #3 files and the Fix #2 files.
   `git status && git diff` first. Fix #1 is already committed (`5dee8aa`).
   - For **Fix #3**, the whole production change is
     `cartesia.provider.ts` plus **four lines** in `conversation-pipeline.ts`.
     The one thing to look at closely is the cost line: the streaming branch now
     passes `generatedAudioSeconds` to `estimateTtsCost`, without which Cartesia
     (the only duration-billed provider) would have had its TTS cost silently
     zeroed on every call.
   - For **Fix #2**, read §0a.7 before reviewing the
     `conversation-continuity-tests.ts` diff: one obsolete expectation was
     deliberately retired there, and the reasoning is recorded both in §0a.7 and
     in a note above SECTION A of the test file itself.
3. **Validate ALL THREE fixes on a real call.**
   - **Fix #3** — the eight watch items at the end of §0. In short:
     `[TTS:cartesia] first audio chunk in NNNms` should read **150-350ms and not
     grow with reply length**; `audio-queued` should land **~450-900ms** after
     `turn-detected`, down from ~1383ms; and the two things only a human can
     confirm are that **the voice sounds identical** (no seams or clicks at
     chunk boundaries, no truncated words) and that **nothing is spoken twice**.
     Also confirm the per-call TTS cost is non-zero for the Cartesia lane — a
     `[COST] … no generated duration was supplied` warning means the cost fix
     regressed. **Rollback is one line:** delete `synthesizeStream` from
     `cartesia.provider.ts`.
   - **Fix #2** — the five watch items at the end of §0a.
   - **Fix #1** — a call the agent closes with the person's NAME in the goodbye
     (`"Take care, <name>."`) must now record
     `hangup_reason = 'agent_hangup:closing'` where it previously recorded
     `watchdog:max_silence`, and the caller must hear the whole closing first.
     A Vobiz `endCall` 404 on such a call means the fix did not fire and the
     carrier had already torn the line down — re-read §0b.
   - Also still watch `[TIMING:…] stt-to-release=` for the §0b latency change,
     and `tts-first-chunk`, which Fix #3 made visible on every provider.
4. Then decide the next thread. **PHASES A, B and C have now closed the TTS
   thread.** All three campaign lanes stream, the Sarvam correctness defect is
   fixed, and the only remaining TTS item (Sarvam's handshake) is closed as
   unsafe with the evidence recorded. What is left is NOT a TTS change:
   - **LLM first token (~740ms) is now by far the largest single stage.** A
     genuine vendor floor (`reasoning=0`, 98.7% prompt cache hit); the only lever
     is the 16,014-token system prompt — a prompt-engineering decision with
     quality consequences, not a pipeline change.
   - **Reply LENGTH is what the 4-10s playback measures** (§3.7) — a script
     decision.
   - The non-latency threads are unchanged: **pilot ladder (§3.2)**, **DID
     rotation (§3.3, needs Vobiz info first)** and **auto-resume (§3.5)**.

   The superseded reading below is kept only for the reasoning it records:
   - **First: Sarvam's idle-gap truncation (§3.9).** This is a live correctness
     defect in committed code on a third of all calls — a caller hearing 14% of
     a sentence — and it outranks every latency item here. The fix is a
     *widening*, so it cannot introduce a new truncation.
   - **Then: Smallest AI streaming (§3.8).** The single largest remaining
     avoidable TTS cost: **1021ms p50 / 2029ms p90** of first audio on a third
     of all calls, against a flat ~300-555ms on an endpoint that already exists
     and returns byte-identical-duration audio. The change is the same additive
     shape as Cartesia's, and the pipeline needs no change at all.
   - **Then: Sarvam's per-chunk handshake (§3.10)**, worth 242-311ms per chunk.
   - **LLM first token (~740ms)** remains a genuine vendor floor (`reasoning=0`,
     98.7% prompt cache hit); the only lever is the 16,014-token system prompt,
     a prompt decision with quality consequences, not a pipeline change.
   - The non-latency threads are unchanged: **pilot ladder (§3.2)**, **DID
     rotation (§3.3, needs Vobiz info first)** and **auto-resume (§3.5)**.
   Fixes #1, #2 and #3 are all done; the audit added no code.
5. Before any run that dials: `npm run preflight:prod -- <campaignId>` and
   `npm run db:verify`. After: `npm run campaign:audit -- <campaignId>`.
6. At the end of the conversation, run `/handoff` so the next session starts from
   the real state.

---

*Update this file at the end of every conversation. Update
[MEMORY.md](MEMORY.md) only when something structural changes.*
