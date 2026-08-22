# Documentation index

Four files carry the working context. Everything else is reference.

| File | What it is | Update cadence |
|---|---|---|
| [../CLAUDE.md](../CLAUDE.md) | Entry point — tells Claude what to read and the rules of the repo | Rarely |
| [../MEMORY.md](../MEMORY.md) | Persistent project memory: overview, stack, architecture, constraints, conventions, do-not-touch list | Only when something **structural** changes |
| [../HANDOFF.md](../HANDOFF.md) | Current state: done / in progress / pending / decisions / files changed / issues / next steps | **End of every conversation** |
| [DECISIONS.md](DECISIONS.md) | Append-only log of decisions and their reasoning | When a decision is made |
| [RUNBOOK.md](RUNBOOK.md) | Commands, env vars, how to run and operate a campaign safely | When a command or limit changes |

## Reference

- [phases/PHASE1_VOICE_SESSION_MANAGER_NOTES.md](phases/PHASE1_VOICE_SESSION_MANAGER_NOTES.md)
  — the `VoiceSessionManager` implementation, the streaming interface conflict
  and how it was resolved, and verification notes.
- [phases/PHASE6_PRODUCTION_READINESS.md](phases/PHASE6_PRODUCTION_READINESS.md)
  — production configuration, the external-limits register, caller-ID risk, AMD
  limits, load safety, the pilot ladder and its gates, 2,000-call capacity.
- [../README.md](../README.md) — the original architecture write-up. Accurate on
  layering and design rationale; **stale** on scope (it predates the UI, the API
  routes and the campaign layer).

## Conventions for these docs

- `MEMORY.md` is truth that outlives a conversation. If it changes weekly, it
  belongs in `HANDOFF.md` instead.
- `HANDOFF.md` must stay short enough to paste into a fresh conversation. Push
  detail down into a phase doc and link to it.
- Never delete from `DECISIONS.md`. Supersede an entry with a new one and link
  back.
