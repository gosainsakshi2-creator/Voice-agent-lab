# Runbook

> **Real calls are live** — `CAMPAIGN_DIALING_ENABLED=true` in `.env.local`.
> Anything that starts a campaign will dial actual phone numbers.

## Commands

| Task | Command |
|---|---|
| Dev server (custom, with WS media bridges) | `npm run dev` |
| Production start | `npm run start` |
| Build | `npm run build` |
| Typecheck | `npm run typecheck` — if the result looks too clean, `npx tsc --noEmit --incremental false` |
| Run DB migrations | `npm run db:migrate` |
| Verify DB constraints | `npm run db:verify` |
| Production preflight | `npm run preflight:prod -- <campaignId>` |
| Post-run audit | `npm run campaign:audit -- <campaignId>` |

### Tests

Standalone `tsx` scripts, no framework. **Set `CAMPAIGN_DIALING_ENABLED=false`
before running them** — otherwise ~3 assertions fail for reasons unrelated to
your change.

```
npm run test:campaign        # phase 2
npm run test:phase3a … test:phase10
npm run test:turn-release
npm run test:continuity
npm run test:pronunciation
npm run test:speaking-watchdog
npm run test:barge-in
```

## Campaign API

| Action | Endpoint |
|---|---|
| Create / list | `POST|GET /api/campaigns` |
| Import contacts | `POST /api/campaigns/{id}/import` |
| Preflight | `GET /api/campaigns/{id}/preflight` |
| Production readiness | `GET /api/campaigns/{id}/production-readiness` |
| Start / pause / resume / stop | `POST /api/campaigns/{id}/{start\|pause\|resume\|stop}` |
| Set ladder rung | `POST /api/campaigns/{id}/stage` — body `{"stage": n}` |
| Progress / results / export | `GET /api/campaigns/{id}/{progress\|results\|export}` |

## Safe run procedure

1. `npm run db:verify`
2. `npm run preflight:prod -- <campaignId>` — must be clean
3. Confirm the ceiling: the effective cap is the **smallest** of
   `CAMPAIGN_STAGE_MAX_CALLS`, the `pilot_stage` rung, and any per-campaign
   ceiling. The start response says which one bound.
4. Start the run. Watch deployment logs for `[campaign-db]` errors and
   `pump burst capped` in the media bridge.
5. `npm run campaign:audit -- <campaignId>`
6. Check the gates in
   [phases/PHASE6_PRODUCTION_READINESS.md](phases/PHASE6_PRODUCTION_READINESS.md)
   §H before advancing a rung.

## Load ladder

| Rung | Calls | `pilot_stage` | `CAMPAIGN_STAGE_MAX_CALLS` |
|---|---|---|---|
| 1 | 10 | 0 | 10 |
| 2 | 50 | 1 | 50 |
| 3 | 100 | 2 | 100 |
| 4 | 500 | 3 | 500 — **only after carrier limits are confirmed** |
| 5 | 2,000+ | 4 | set explicitly, against measurements |

Never advance two rungs at once. Never advance on a red gate.

## Environment variables

All read through `src/providers/shared/env`. Never touch `process.env` directly.

**Never rewrite `.env.local` wholesale.** Multi-line values must be quoted or they
truncate at the first newline (this has already broken
`GOOGLE_SERVICE_ACCOUNT_JSON` once), and duplicate keys are last-win.

| Group | Keys |
|---|---|
| App | `APP_PUBLIC_BASE_URL`, `PORT`, `DATABASE_URL` |
| Kill switch / limits | `CAMPAIGN_DIALING_ENABLED`, `CAMPAIGN_STAGE_MAX_CALLS`, `CAMPAIGN_GLOBAL_MAX_CONCURRENCY`, `CAMPAIGN_GLOBAL_CPS`, `CAMPAIGN_CONCURRENCY_<PROVIDER>`, `CAMPAIGN_CPS_<PROVIDER>`, `CAMPAIGN_MAX_CALLS_PER_DID` |
| Call watchdogs | `CAMPAIGN_RING_TIMEOUT_SECONDS`, `CAMPAIGN_MAX_CALL_SECONDS`, `CAMPAIGN_MAX_SILENCE_SECONDS` |
| Retries | `CAMPAIGN_RETRY_MAX_ATTEMPTS`, `CAMPAIGN_RETRY_REGISTRATION_MAX_ATTEMPTS`, `CAMPAIGN_RETRY_*_DELAY_MINUTES`, `CAMPAIGN_RETRY_ON_*` |
| Import | `CAMPAIGN_CSV_MAX_BYTES`, `CAMPAIGN_CSV_MAX_ROWS`, `CAMPAIGN_DEFAULT_REGION` |
| Sheets | `CAMPAIGN_SHEET_SPREADSHEET_ID`, `CAMPAIGN_SHEET_TAB_NAME`, `GOOGLE_SERVICE_ACCOUNT_JSON` |
| Telephony | `VOBIZ_*`, `PLIVO_*` |
| STT / LLM | `DEEPGRAM_*`, `OPENAI_*`, `GEMMA_*` |
| TTS | `ELEVENLABS_*`, `CARTESIA_*`, `SARVAM_*`, `SMALLEST_AI_*` |

## When something goes wrong

| Symptom | Look at |
|---|---|
| Calls dropping mid-conversation | Concurrency above 3 → carrier teardown. Check the effective global/lane limits. |
| Run refused at launch | `load-guardrails.ts` — a limit is outside the envelope. Fix the config, do not widen the guardrail. |
| No FINAL_YES rows in the sheet | Script wording drifted from `COMMIT_ANCHORS` in `classifier.ts`. |
| Auth failure that looks like a bad key | A multi-line value in `.env.local` truncated. |
| Typecheck passes on broken code | Stale `tsconfig.tsbuildinfo` — `npx tsc --noEmit --incremental false`. |
| Voicemails counted as answered | Expected. There is no AMD. |
