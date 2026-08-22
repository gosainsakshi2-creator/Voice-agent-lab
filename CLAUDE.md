# CLAUDE.md

Context entry point for this repository. Claude loads this file automatically.

## Read these first, in this order

1. **[MEMORY.md](MEMORY.md)** — persistent project memory: overview, stack,
   architecture, locked constraints, conventions, and what must not change.
2. **[HANDOFF.md](HANDOFF.md)** — the state of play right now: done, in progress,
   pending, next steps.

Then only if the task needs it:

- **[docs/RUNBOOK.md](docs/RUNBOOK.md)** — commands, env vars, operating a campaign.
- **[docs/DECISIONS.md](docs/DECISIONS.md)** — why things are the way they are.
- **[docs/phases/](docs/phases/)** — deep dives from each build phase.

## Rules for working here

- **Real calls are live** (`CAMPAIGN_DIALING_ENABLED=true`). Never run anything
  that can dial without saying so first.
- **Never raise a load limit to make something pass.** `load-guardrails.ts`
  refusing a run is the feature, not a bug.
- **Never change an existing provider-interface signature.** Append optional
  members only.
- **Do not touch the voice/media layer** (`src/server/*-media-bridge.ts`,
  `audio-codec.ts`, `vad-segmenter.ts`, barge-in / turn detection) for
  campaign-layer work.
- **Do not rewrite `.env.local`.** It holds live credentials and breaks silently.
- Follow the conventions in [MEMORY.md §5](MEMORY.md) — ESM, named exports,
  barrel files, env only via `providers/shared/env`, a "why" comment at the top
  of every non-trivial file.

## Ending a conversation

Update [HANDOFF.md](HANDOFF.md) with the latest state — run `/handoff`.
Update [MEMORY.md](MEMORY.md) **only** if something structural changed.
