# Decision log

Append-only. Never delete an entry — supersede it with a newer one and link back.
Each entry: what was decided, why, and what it costs.

Format: `## [D-nn] Title — date`

---

## [D-01] The Dashboard may only call `VoiceSessionManager` — architecture pass

**Decision.** The UI depends on exactly one abstraction. `VoiceSessionManager`
depends on the four provider interfaces and the `ProviderRegistry`; the registry
is the only place that maps an id to a concrete vendor class.

**Why.** Swapping ElevenLabs for Cartesia in a benchmark run must be a *data*
change (a different `ProviderIdentifier`), not a code change. Open/closed at the
platform level.

**Cost.** Anything a vendor can do that the interface cannot express is invisible
to the platform until the interface is extended. See D-02.

---

## [D-02] Streaming was added as optional interface members, not a new interface

**Decision.** Each provider interface gained exactly one **additive, optional**
member: `transcribeStream?`, `generateCompletionStream?`, `synthesizeStream?`,
`openMediaStream?`. `DefaultVoiceSessionManager` feature-detects each at runtime.

**Why.** The original interfaces returned `Promise<FullResult>`, which cannot
express real-time STT/LLM/TTS, full duplex or barge-in. Rewriting the signatures
would have invalidated all eight concrete providers at once. Optional members
kept every existing implementation valid and let the manager fall back to
whole-turn request/response wherever a provider does not implement streaming.

**Cost.** Two code paths through the pipeline. Both were verified end-to-end
during Phase 1.

---

## [D-03] Extra transport methods live on the class, not the interface

**Decision.** `pushInboundAudio`, `onOutboundAudio` and `signalBargeIn` are
public on `DefaultVoiceSessionManager` but absent from `VoiceSessionManager`.

**Why.** Real-time audio needed a concrete place to plug in without changing the
public contract the Dashboard is typed against.

**Cost.** Anything that needs them must depend on the concrete class.

---

## [D-04] Concurrency default is 3, taken from the carrier — Phase 6

**Decision.** `CARRIER_MAX_CONCURRENT_CALLS = 3` is the default for the global
semaphore and every per-provider lane.

**Why.** 3 is Vobiz's **confirmed** ceiling. The previous defaults (15 global, 5
per lane) let the dispatcher hold five times the carrier's allowance open, with
nothing in the repo bringing it back down — so the ceiling was enforced only by
Vobiz tearing calls down. A carrier-side hangup on a live conversation is
indistinguishable at our end from any other random disconnect.

**Cost.** ~200 attempts/hour. A 2,000-call day is a full working day.

**Supersedes.** The earlier 15/5 defaults.

---

## [D-05] Load guardrails refuse a run rather than clamp it — Phase 6

**Decision.** `load-guardrails.ts`, checked at launch in `run-launcher.ts`,
**refuses** a run configured outside the safe envelope instead of silently
correcting it.

**Why.** Two silent holes existed: `CAMPAIGN_GLOBAL_CPS=0` meant *no rate limit*
(not "no calls"), so every call in the concurrency window would start in the same
instant; and `CAMPAIGN_GLOBAL_MAX_CONCURRENCY=0` silently never dialled. A clamp
would have hidden both. A refusal makes the operator fix the config.

**Cost.** A typo stops a run instead of degrading it. That is intended.

---

## [D-06] Caller-ID rotation is reported as a blocker, not implemented — Phase 6

**Decision.** Every call presents the single `VOBIZ_FROM_NUMBER`. Readiness check
8 BLOCKS any run whose ceiling exceeds `CAMPAIGN_MAX_CALLS_PER_DID` (500).

**Why.** Rotation cannot be written against an unknown pool. Picking numbers from
a list we have not confirmed we own would be worse than not rotating.

**Unblocked by (external):** the DID list on the Vobiz account, confirmation that
`from` may be set per call, and the per-DID daily limit. The code change is then
confined to `vobiz.provider.ts` plus an optional `from` on
`TelephonyCallParams` — the media layer is not involved.

---

## [D-07] Scripts are content-hashed and pinned to a campaign

**Decision.** `hashScript` hashes id + version + the system-prompt appendix + the
opening line. A campaign record stores the hash.

**Why.** A campaign record should prove *which words ran*, not merely which file
was pointed at. Editing a script's text changes its hash, which makes a running
campaign's snapshot detectably stale instead of silently drifting.

**Cost.** Editing a live script's wording invalidates the snapshot on purpose —
and see D-08.

---

## [D-08] Outcome classification is anchored to the script's exact gate wording

**Decision.** `COMMIT_ANCHORS` in `src/campaign/outcome/classifier.ts` holds the
literal phrasing of the commitment question per campaign type. A caller answer
only counts as FINAL_YES when it directly answers an anchor turn.

**Why.** "Yes" means nothing without knowing which question it answered. Anchoring
to the gate question is what separates a real commitment from politeness.

**Cost.** **Re-wording a script without updating the anchors silently kills
FINAL_YES** — and with it the sheet row and the auto-hangup. Always change both.

---

## [D-09] The first pilot is capped at 10 calls, and every control can only lower it

**Decision.** `CAMPAIGN_STAGE_MAX_CALLS` defaults to 10 and `pilot_stage` 0 is
10. `describeCallCeiling` takes the **smallest** of the env ceiling, the ladder
rung and any per-campaign ceiling. Raising the stage does not raise the env
ceiling.

**Why.** So a first real run cannot become a thousand calls by accident, and so
no single knob can widen the blast radius.

**Cost.** Advancing volume is deliberately a two-place change.

---

## [D-10] Context continuity lives in the repo — 2026-08-22

**Decision.** `CLAUDE.md` → `MEMORY.md` → `HANDOFF.md`, with `docs/` for
reference. `HANDOFF.md` is rewritten at the end of every conversation;
`MEMORY.md` changes only on structural change.

**Why.** Work spans many conversations. Without a committed handoff, each new
conversation re-derives the architecture and re-discovers the same traps.

**Cost.** One update step at the end of each session — `/handoff`.
