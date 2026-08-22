# HANDOFF.md — Current State

> **Paste this whole file into a fresh Claude conversation to resume work.**
> It is deliberately short. Stable project truth lives in [MEMORY.md](MEMORY.md);
> this file only holds *what is happening right now*.

**Updated:** 2026-08-22
**Branch:** `campaign-layer-phase-0` (working tree clean at handoff)
**Last commit:** `6329f3e` — Fix greeting interruptions and speech pronunciation
**Dialing:** `CAMPAIGN_DIALING_ENABLED=true` — **real calls are live**

---

## 1. What was completed

**Recently, per git history (latest first):**

| Commit | What landed |
|---|---|
| `6329f3e` | Greeting no longer self-interrupts; speech pronunciation fixes (`conversation-pipeline.ts`, `language-detector.ts`, `speech-pronunciation.ts`) |
| `3d4bd16`, `03b1707`, `f43c5be` | Vobiz call recording; voicemail-detection scaffold; large barge-in accuracy test suite (932 lines); VAD segmenter and both media bridges reworked |
| `a66b156` | Conversation continuity — stale replies no longer emitted after a barge-in |

**Phase work already delivered and documented:**

- Phase 1 — `VoiceSessionManager` orchestration, streaming pipeline, barge-in →
  [docs/phases/PHASE1_VOICE_SESSION_MANAGER_NOTES.md](docs/phases/PHASE1_VOICE_SESSION_MANAGER_NOTES.md)
- Phases 2–10 — campaign layer: import, dispatch, retries, outcomes, sheet sync,
  disconnect handling (see the `test:phase*` scripts in `package.json`)
- Phase 6 — production readiness, external-limits register, load ladder →
  [docs/phases/PHASE6_PRODUCTION_READINESS.md](docs/phases/PHASE6_PRODUCTION_READINESS.md)

**This conversation (2026-08-22):** set up the context-continuity system —
`HANDOFF.md`, `MEMORY.md`, `CLAUDE.md`, `docs/README.md`, `docs/DECISIONS.md`,
`docs/RUNBOOK.md`, `.claude/commands/handoff.md`. Moved the two existing phase
notes into `docs/phases/` with their content unchanged.

---

## 2. In progress

- Nothing is mid-edit. The tree is clean and everything is committed.
- The live campaign is sitting on the **pilot ladder at rung 1 (10 calls)** —
  `CAMPAIGN_STAGE_MAX_CALLS=10`. Advancing rungs is the open operational thread.

---

## 3. Pending

| # | Item | Blocked on |
|---|---|---|
| 1 | Raise `CAMPAIGN_STAGE_MAX_CALLS` past 10 and advance the pilot ladder | Phase 6 §H gates green for the current rung |
| 2 | Caller-ID / DID rotation | **External:** the DID list from Vobiz + whether `from` can be set per call |
| 3 | AMD / voicemail detection | Design decision — a minimal additive proposal is written up in Phase 6 §E but not implemented |
| 4 | Auto-resume after a run stops | Not started; one of the two real blockers on 2,000-call days |
| 5 | `README.md` describes only the original architecture pass ("no UI, no API routes") — now stale | Low priority; a note pointing at the docs has been added at the top |

---

## 4. Important decisions carried forward

Binding constraints are in [MEMORY.md §4](MEMORY.md) and
[docs/DECISIONS.md](docs/DECISIONS.md). The four that most often catch people:

1. **Concurrency stays at 3.** That is Vobiz's confirmed ceiling; above it the
   carrier tears down live conversations.
2. **Load guardrails refuse a run, they do not clamp it.** Never widen a limit to
   make something pass.
3. **Provider interfaces only ever gain optional members.** Never change an
   existing signature.
4. **Re-wording a script requires updating `COMMIT_ANCHORS`** in
   `src/campaign/outcome/classifier.ts`, or FINAL_YES detection dies silently.

---

## 5. Files changed this conversation

```
A  HANDOFF.md
A  MEMORY.md
A  CLAUDE.md
A  docs/README.md
A  docs/DECISIONS.md
A  docs/RUNBOOK.md
A  .claude/commands/handoff.md
R  PHASE1_VOICE_SESSION_MANAGER_NOTES.md  -> docs/phases/PHASE1_VOICE_SESSION_MANAGER_NOTES.md
R  docs/PHASE6_PRODUCTION_READINESS.md    -> docs/phases/PHASE6_PRODUCTION_READINESS.md
M  README.md   (pointer note prepended; existing content untouched)
```

No source file under `src/` was touched.

---

## 6. Current errors / known issues

**Open product blockers**

- **Single caller ID for every call.** 2,000 calls/day all originate from one
  number. Runs above 500 calls per DID are BLOCKED by readiness check 8.
- **No AMD.** A voicemail is scored as a normal answered call and usually lands
  as `no_engagement` or `unclear`.
- **No auto-resume.** A stopped run must be restarted by hand.

**Environment traps (not bugs in your change)**

- Campaign tests fail ~3 assertions while `CAMPAIGN_DIALING_ENABLED=true`. Turn
  it off for the test run.
- `npm run typecheck` can pass on a file that does not parse — stale
  `tsconfig.tsbuildinfo`. Use `npx tsc --noEmit --incremental false` to be sure.
- `.env.local` multi-line values truncate silently; duplicate keys are last-win.

---

## 7. Exact next steps

1. Read [MEMORY.md](MEMORY.md), then this file. Do not re-derive the
   architecture — it is already written down.
2. Decide which thread to pick up: **pilot ladder (§3.1)**, **DID rotation
   (§3.2, needs Vobiz info first)**, or **auto-resume (§3.4)**.
3. Before touching anything, confirm the tree state:
   `git status && git log --oneline -5`
4. Before any run that dials: `npm run preflight:prod -- <campaignId>` and
   `npm run db:verify`. After the run: `npm run campaign:audit -- <campaignId>`.
5. At the end of the conversation, run `/handoff` (or ask Claude to update
   `HANDOFF.md`) so the next session starts from the real state.

---

*Update this file at the end of every conversation. Update
[MEMORY.md](MEMORY.md) only when something structural changes.*
