# Phase 6 — Production readiness and external limits

Everything in this document is either **read out of the repository** or marked
**NEEDS EXTERNAL CONFIRMATION**. There is no third category. Where a number
belongs to a vendor rather than to us, it is not guessed here.

Run the checks rather than reading this document alone:

```bash
npm run preflight:prod                      # deployment-wide, 25 required checks
npm run preflight:prod -- <campaignId>      # plus the four campaign-scoped ones
npm run db:verify                           # proves the DB guarantees against the real DB
npm run campaign:audit -- <campaignId>      # after every rung of the ladder
```

`GET /api/production-readiness` and `GET /api/campaigns/{id}/production-readiness`
return the same report as JSON. All of it is read-only: it contacts no vendor,
places no call, and **never sets `CAMPAIGN_DIALING_ENABLED`**.

---

## A. Current production configuration (as inspected)

| Setting | Env var | Value in force | Notes |
|---|---|---|---|
| Dialing kill switch | `CAMPAIGN_DIALING_ENABLED` | **false** | Not set in `.env.local`; default off |
| Global concurrency | `CAMPAIGN_GLOBAL_MAX_CONCURRENCY` | 15 live calls | Default |
| Per-lane concurrency | `CAMPAIGN_CONCURRENCY_{CARTESIA,SARVAM,SMALLEST_AI}` | 5 each | Default; lanes total 15 |
| Global CPS | `CAMPAIGN_GLOBAL_CPS` | 3 / s | Default |
| Per-lane CPS | `CAMPAIGN_CPS_*` | 1 / s each | Default; lanes total 3 |
| Ring timeout | `CAMPAIGN_RING_TIMEOUT_SECONDS` | 35 s | Produces the **inferred** `NO_ANSWER` |
| Max call duration | `CAMPAIGN_MAX_CALL_SECONDS` | 180 s | Watchdog, via the existing public `end()` |
| Max silence | `CAMPAIGN_MAX_SILENCE_SECONDS` | 20 s | Watchdog |
| Calls per run | `CAMPAIGN_STAGE_MAX_CALLS` | **10** | Pilot ceiling |
| Pilot ladder | `campaigns.pilot_stage` | stage 0 → 10 | `PILOT_LADDER = [10, 50, 100, 500, null]` |
| Retries | `CAMPAIGN_RETRY_MAX_ATTEMPTS` | 3 | Same provider always; enforced by the DB |
| Retry delays | no-answer / busy / temporary | 30 min / 10 min / 1,4,16 min | |
| Claim batch | `CAMPAIGN_CLAIM_BATCH_SIZE` | 5 | `FOR UPDATE SKIP LOCKED` |
| Lane poll | `CAMPAIGN_POLL_INTERVAL_MS` | 1000 ms | |
| Dispatcher lock | `CAMPAIGN_LOCK_STALE_SECONDS` | 90 s | 15 s heartbeat |
| DB pool | `DATABASE_POOL_MAX` | 10 | See the warning in section I |
| Public base URL | `APP_PUBLIC_BASE_URL` | `https://voice-agent-lab.onrender.com` | Render deployment, not a tunnel |
| Vobiz answer URL | `VOBIZ_ANSWER_URL` | `…/api/voice/vobiz/answer` | Matches the deployment |
| Vobiz API base | `VOBIZ_API_BASE_URL` | `https://api.vobiz.ai` | |
| Caller ID | `VOBIZ_FROM_NUMBER` | one E.164 number | **No rotation exists** — section D |
| STT / LLM | `DEEPGRAM_MODEL` / `OPENAI_MODEL` | `nova-3` / `gpt-5.1` | |
| TTS | Cartesia `sonic-3.5`, Sarvam `bulbul:v3`, Smallest AI | 16 kHz each | Voice IDs unchanged |
| DB schema | `schema_migrations` | `001_init`, `002_campaign_controls` applied, checksums match | PostgreSQL 17.6 |

### New in Phase 6 (additive only)

| Setting | Env var | Default | Purpose |
|---|---|---|---|
| Calling window | `CAMPAIGN_CALLING_WINDOW_START` / `_END` | `10:00` / `20:00` | Hours a run may dial in |
| Calling window zone | `CAMPAIGN_CALLING_WINDOW_TIMEZONE` | `Asia/Kolkata` | IANA zone |
| Calling window days | `CAMPAIGN_CALLING_WINDOW_DAYS` | `0,1,2,3,4,5,6` | 0 = Sunday |
| Calling window enforcement | `CAMPAIGN_CALLING_WINDOW_ENFORCED` | `true` | `false` is a visible decision |
| Window poll | `CAMPAIGN_WINDOW_POLL_MS` | 30000 | How often a running campaign re-checks |
| Absolute concurrency ceiling | `CAMPAIGN_ABSOLUTE_MAX_CONCURRENCY` | 60 | Run refused above it |
| Absolute CPS ceiling | `CAMPAIGN_ABSOLUTE_MAX_CPS` | 20 | Run refused above it |
| Absolute calls per run | `CAMPAIGN_ABSOLUTE_MAX_CALLS_PER_RUN` | 25000 | Run refused above it |
| Absolute call seconds | `CAMPAIGN_ABSOLUTE_MAX_CALL_SECONDS` | 900 | Run refused above it |
| Absolute retry attempts | `CAMPAIGN_ABSOLUTE_MAX_RETRY_ATTEMPTS` | 5 | Run refused above it |
| Per-DID call budget | `CAMPAIGN_MAX_CALLS_PER_DID` | 500 | Readiness check 8 blocks above it |

**The calling window did not exist before Phase 6.** Nothing stopped a run
starting at 03:00. It is now checked at launch (the run is refused) and polled
while running (the run is paused, never stopped, and never auto-resumed).

---

## B. What the readiness check reports

25 required checks plus four extras, each PASS / BLOCKED / WARN / SKIPPED:

1 `DATABASE_URL` · 2 DB connectivity · 3 migration state (versions **and**
checksums) · 4 `APP_PUBLIC_BASE_URL` · 5 HTTPS (rejects http, localhost, dev
tunnels, and a base URL carrying a path) · 6 `CAMPAIGN_DIALING_ENABLED` ·
7 Vobiz configuration (**including that `VOBIZ_ANSWER_URL` matches this
deployment's origin**) · 8 caller ID (E.164 + per-DID budget) · 9 campaign
telephony provider · 10 Cartesia · 11 Sarvam · 12 Smallest AI · 13 Deepgram ·
14 OpenAI · 15 calling window · 16 concurrency · 17 CPS · 18 max call duration ·
19 max silence · 20 retry policy · 21 CSV/contact readiness · 22 script
readiness · 23 provider allocation · 24 provider-lock integrity (both triggers
present, zero cross-provider attempts, no unknown provider) · 25 uniqueness and
idempotency constraints present.

Extras: 26 call ceiling and pilot ladder · 27 ring/claim/poll/lock ·
28 external limits confirmed · 29 call-status observability.

Checks 10–14 use the **existing registry bootstrap** to ask whether each
provider *would* register from this environment. `checkHealth` is never called,
so no vendor is contacted.

Current verdict on this deployment: **BLOCKED on check 6 only** — dialing is
off, which is correct until the pilot. Everything else passes or warns.

---

## C. External limits — the register

Full machine-readable register: `src/campaign/external-limits.ts`.
15 of 29 entries need external confirmation; 13 of those gate scaling past the
pilot rungs.

### Vobiz

| Limit | Status |
|---|---|
| API surface used (POST Call, DELETE Call, GET /auth/me) | **FROM REPOSITORY** |
| Configured caller ID | **FROM REPOSITORY** (one number, no rotation) |
| Max simultaneous calls / channels | **NEEDS EXTERNAL CONFIRMATION** — gates scale |
| Permitted CPS | **NEEDS EXTERNAL CONFIRMATION** — gates scale |
| Per-DID daily limits / spam-flag thresholds | **NEEDS EXTERNAL CONFIRMATION** — gates scale |
| Multiple DIDs available, rotation permitted | **NEEDS EXTERNAL CONFIRMATION** — gates scale |
| AMD / voicemail detection | **NEEDS EXTERNAL CONFIRMATION** — gates scale |
| Status callback + hangup cause | **NEEDS EXTERNAL CONFIRMATION** — gates scale |
| CDR / billing API | **NEEDS EXTERNAL CONFIRMATION** |
| Outbound campaign restrictions (hours, consent, KYC) | **NEEDS EXTERNAL CONFIRMATION** — gates scale |
| Contracted per-minute rate | **NEEDS EXTERNAL CONFIRMATION** (estimator uses a stated placeholder) |

### Deepgram

| Limit | Status |
|---|---|
| Model in use (`nova-3`) | **FROM REPOSITORY** |
| Streaming sockets we will open = peak global concurrency (**15** today) | **FROM REPOSITORY** |
| Account concurrent-stream limit | **NEEDS EXTERNAL CONFIRMATION** — gates scale |
| Request rate limit / monthly minutes | **NEEDS EXTERNAL CONFIRMATION** — gates scale |
| Price applied by our estimator | **FROM REPOSITORY** (`$0.0058` per audio minute) |

### OpenAI

| Limit | Status |
|---|---|
| Model in use (`gpt-5.1`) | **FROM REPOSITORY** |
| One streaming completion per conversation turn | **FROM REPOSITORY** |
| RPM / TPM / concurrency for that model on this tier | **NEEDS EXTERNAL CONFIRMATION** — gates scale |
| Price applied by our estimator | **FROM REPOSITORY** (`$1.25` /1M in, `$10` /1M out) |

A 429 mid-conversation is dead air on a live call, and `classifyError` maps it to
`TEMPORARY` — which schedules a **retry**, i.e. a second real call to the same
person because of a rate limit. This is why the OpenAI limit gates scale.

### Cartesia / Sarvam / Smallest AI

| Vendor | Concurrency & rate limits | Price applied by our estimator |
|---|---|---|
| Cartesia | **NEEDS EXTERNAL CONFIRMATION** — gates scale | `$0.05` per minute of **generated audio** |
| Sarvam | **NEEDS EXTERNAL CONFIRMATION** — gates scale | `$0.034091` per 1,000 characters (₹3/1k at a fixed INR/USD divisor of 88 in `cost-estimator.ts`) |
| Smallest AI | **NEEDS EXTERNAL CONFIRMATION** — gates scale | `$0.0175` per 1,000 characters |

Every price above is produced by **calling the estimator's own exported
functions** with unit inputs, so the register cannot drift from what the cost
figures in the results report actually use. Cartesia is billed on duration and
the other two on characters, so their per-call costs are not comparable
per-character.

---

## D. Caller-ID / DID risk — **PRODUCTION BLOCKER for volume**

What the code does today (`src/providers/telephony/vobiz.provider.ts`):

* `VOBIZ_FROM_NUMBER` is read once at construction and sent verbatim as the
  `from` field of every `POST /Call/`. There is no normalisation, no pool, no
  per-call override, and no rotation. `TelephonyCallParams` has no `from` field
  for a caller to set.
* Therefore **every call in all three lanes presents the same caller ID**, and
  a 2,000-call day is 2,000 calls from one number.

Determinations:

| Question | Answer |
|---|---|
| Current configured from-number | one E.164 number in `VOBIZ_FROM_NUMBER` (masked in all reports) |
| Rotation supported by existing code | **No.** Single env value, single `from` field. |
| Does Vobiz expose a DID pool | **UNKNOWN — needs external confirmation.** Nothing in the repository lists account numbers, and the API surface we use has no numbers endpoint. |
| Can rotation be added without touching the protected voice/media layer | **Yes, in principle.** The change is confined to `vobiz.provider.ts` selecting a `from` from a list, plus an optional `from` on `TelephonyCallParams`. The media bridge, codec, audio queue, barge-in and turn detection are not involved. |

**This is reported as a blocker rather than implemented**, per the Phase 6 rules:
rotation cannot be written against an unknown pool, and picking numbers at
random from a list we have not confirmed we own would be worse than not
rotating. Readiness check 8 enforces the interim rule: a run whose ceiling
exceeds `CAMPAIGN_MAX_CALLS_PER_DID` (500) is **BLOCKED**.

What is needed from you: the list of DIDs on the Vobiz account, whether Vobiz
permits setting `from` per call to any of them, and the per-DID daily limit.

---

## E. AMD / voicemail — what can and cannot be distinguished

From the code, not from the carrier:

| Status | Available? | How it is determined today |
|---|---|---|
| Call answered | Yes, **but only as "the media stream opened"** | The Vobiz bridge calls `confirmCallAnswered()` on the stream `start` event. That fires for a human, a voicemail greeting and an IVR alike. |
| **Human** answered | **No** | Nothing separates a human from a machine. |
| Voicemail / answering machine | **No** | No AMD parameter is sent; no carrier verdict is received. A voicemail becomes a normal answered call whose transcript the classifier reads, typically landing as `no_engagement` or `unclear`. |
| Busy | **Inferred only** | `classifyError` matching `/busy/` in a thrown Call-API message. A busy line the carrier accepts and drops presents as `NO_ANSWER`. |
| No answer | **Inferred** | Our own 35 s ring watchdog. Stored as `status_source='inferred'`; the results report counts these separately as `inferredTerminal`. |
| Rejected / declined | **Inferred only** | Error-string match `/reject\|declined\|denied\|forbidden\|403/`. A callee pressing decline is indistinguishable from no answer. |
| Completed conversation | **Observed** | The existing session state machine reaching IDLE, or a watchdog verdict; `hangup_reason` records which. |
| Carrier hangup cause | **No** | The Vobiz bridge documents that the platform sends no `stop` event — a WebSocket close is end-of-stream. No status-callback route exists (`webhook_events` exists and has no handler). |

**Treat every BUSY and REJECTED count as a lower bound, and voicemail as
indistinguishable from an answer.** Readiness check 29 states this on every run.

### Proposed minimal additive AMD/status implementation — NOT IMPLEMENTED

Explaining first, as required. If Vobiz confirms support, the minimal change is:

1. Add a status-callback route `src/app/api/voice/vobiz/status/route.ts` that
   inserts into the existing `webhook_events` table with
   `ON CONFLICT DO NOTHING` (the dedupe design is already in the schema and
   already verified by `db:verify`), resolves the attempt by
   `provider_call_id`, and writes `status_source='carrier'` plus
   `hangup_reason`.
2. Send `status_callback_url` (exact parameter name to be confirmed) alongside
   `answer_url` in `startCall`, and store the returned `request_uuid` into
   `call_attempts.provider_call_id` — the column and its unique index already
   exist and are currently never written.
3. If a machine-detection parameter exists, pass it and map its verdict to a new
   terminal failure class, so a voicemail is finalised **without** the
   conversation pipeline ever starting.

All three touch only the campaign/telephony dispatch layer. None touches
Deepgram, the LLM, any TTS provider, turn detection, the SentenceChunker,
barge-in, the audio queue, the media bridges or the codec. **Say the word and I
will implement it; I have not done so.**

---

## F. Production URL / WebSocket requirements

The architecture requires all four, and readiness checks 4, 5 and 7 verify them:

1. **A stable HTTPS public URL.** `APP_PUBLIC_BASE_URL` is the origin Vobiz
   fetches the answer URL from. Currently `https://voice-agent-lab.onrender.com`
   — a deployment, **not** a tunnel. Dev tunnels (ngrok, cloudflare, loca.lt,
   devtunnels, …) are rejected by check 5 because their hostname changes between
   sessions; they are **not** the production recommendation.
2. **WebSocket accessibility.** The answer XML returns
   `wss://{host}/api/voice/vobiz/stream?sessionId=…`, derived from
   `APP_PUBLIC_BASE_URL` by swapping the scheme. The upgrade is handled by
   `server.ts`, not by a Next route — so the deployment **must run
   `tsx server.ts`** (`npm start`), never `next start`, and the host must permit
   WebSocket upgrades on that path with no idle timeout shorter than
   `CAMPAIGN_MAX_CALL_SECONDS`.
3. **Answer URL accessibility.** `VOBIZ_ANSWER_URL` must equal
   `{APP_PUBLIC_BASE_URL}/api/voice/vobiz/answer`, be https, and carry **no**
   query string (the provider appends `?sessionId=`). Check 7 enforces all
   three. A stale answer URL is the failure that connects the call and then
   delivers silence.
4. **Correct callback routing.** The dispatcher **must run in the same process**
   as the media bridges: the session manager is in-memory on `globalThis`, so
   the answer webhook and the audio socket have to land on the process that owns
   the session. One instance, no autoscaling, no rolling restart mid-run. The
   dispatcher lock enforces one dispatcher per campaign, but it cannot make a
   second replica able to answer for a session it does not hold.

---

## G. Load safety — verified controls

| Control | Where | Verified |
|---|---|---|
| Global concurrency | `Semaphore(globalMaxConcurrent)` in `dispatcher.ts` | Yes |
| Per-provider concurrency | one `Semaphore` per lane in `LaneGate` | Yes |
| Global CPS | `TokenBucket(globalCallsPerSecond)`, continuous refill | Yes |
| Per-provider CPS | one `TokenBucket` per lane | Yes |
| Stage max calls | counted **at claim time**, so parallel starts cannot overshoot | Yes |
| Max call duration | call-runner watchdog → existing public `end()` | Yes |
| Max silence | same watchdog | Yes |
| Ring timeout | same watchdog → inferred `NO_ANSWER` | Yes |
| Retry limit | `retry-planner.ts`, same provider only | Yes |
| **Calling window** | **added in Phase 6** — launch gate + pause watcher | Yes |
| Pause | `POST /pause` → durable `campaign_controls` → watcher → `pause()` | Yes |
| Resume | `POST /resume` → a **new run** through the same preflight and lock | Yes |
| Stop | as pause, marks the campaign STOPPED | Yes |
| Restart recovery | `recoverOrphans` closes in-flight attempts as SYSTEM and re-queues contacts; **never re-dials blind** | Yes |

### Configurations that could previously allow unlimited or zero calls

Two real holes were found and are now closed by `load-guardrails.ts`, checked at
launch in `run-launcher.ts` (the run is **refused**, not clamped):

* **`CAMPAIGN_GLOBAL_CPS=0` did not mean "no calls per second" — it meant NO
  RATE LIMIT.** `TokenBucket.take()` returns immediately for a non-positive
  rate, so a zero (a plausible typo, and the natural way to write "unset")
  removed the only control pacing origination: every call in the concurrency
  window would start in the same instant. Same for any per-lane CPS.
* **`CAMPAIGN_GLOBAL_MAX_CONCURRENCY=0` silently never dials** — the semaphore
  never grants and the lanes poll forever.

Also refused now: any concurrency/CPS/ceiling/call-duration/retry value above
the absolute ceilings in section A, a zero or negative watchdog bound (which
would end every call the instant it was answered), and a zero call ceiling.

**The first real pilot remains capped at 10 calls**: `CAMPAIGN_STAGE_MAX_CALLS`
defaults to 10, `pilot_stage` 0 is 10, and `describeCallCeiling` takes the
**smallest** of the environment ceiling, the ladder rung and any per-campaign
ceiling — so every control can only ever lower the number of calls placed.

---

## H. Production load ladder

**Do not advance a rung until every gate below is green for the rung you are
on.** Each rung: run the campaign, then `npm run campaign:audit -- <id>`, then
read the deployment logs for the run window.

| Rung | Calls | `pilot_stage` | `CAMPAIGN_STAGE_MAX_CALLS` | Suggested concurrency / CPS |
|---|---|---|---|---|
| 1 | 10 | 0 | 10 | 15 / 3 (defaults — effectively serialised at this size) |
| 2 | 50 | 1 | 50 | unchanged |
| 3 | 100 | 2 | 100 | unchanged |
| 4 | 500 | 3 | 500 | unchanged, **only after the carrier limits are confirmed** |
| 5 | 2,000+ | 4 | set explicitly | raise only against measurements — section I |

Set the rung with `POST /api/campaigns/{id}/stage` (`{"stage": n}`). Raising the
stage does **not** raise `CAMPAIGN_STAGE_MAX_CALLS`; the smaller of the two
binds, and the response says which one did.

### Gate for every rung

| Metric | Where to read it | Pass condition |
|---|---|---|
| Duplicate calls | `campaign:audit` → integrity | **0** (`duplicateNumbersInCampaign`, `contactsOverRetryCap`, `maxAttemptsOnOneContact` ≤ retry cap) |
| Cross-provider calls | `campaign:audit` → integrity | **0** (`crossProviderAttempts`, `unknownProviderContacts`) |
| Numbers shared with another campaign | `campaign:audit` → integrity | reviewed — `numbersWithConflictingProviderElsewhere` must be **0** before a reminder campaign reuses a registration list |
| Stuck sessions | `campaign:audit` → stuck | **0** live attempts past deadline, **0** contacts stuck claimed, **0** dispatcher locks left held |
| Database errors | `campaign:audit` → event log errors; deployment logs for `[campaign-db]` | 0 unexplained |
| Provider rate-limit errors | `campaign:audit` → `rateLimitedAttempts` | **0** at rungs 1–3; any at rung 4 stops the ladder until the vendor limit is confirmed |
| Event-loop starvation | deployment logs: `pump burst capped` in the media bridge | none at rungs 1–3; **count must not grow with concurrency** |
| Audio pump warnings | same | as above |
| Answer rate | results `connectRate`, or audit `answered / dialled` | recorded per rung; a sharp fall between rungs is a caller-ID reputation signal — stop |
| Call completion | audit `completed` | consistent with the rung below |
| Outcome classification | audit `nonSuccessReasons`, results `dataHealth.attemptsMissingOutcome` | missing-outcome count **0** |
| Latency p50/p95 | `campaign:audit` → latency (voice only) | p95 total not degrading as concurrency rises |
| Cost | `campaign:audit` → cost, incl. cost per success | per-call cost stable; compare to the carrier CDR at rung 3 |
| Memory growth | host metrics for the run window | flat across the run; **not recorded in the database** |

Between rungs also re-run `npm run preflight:prod -- <id>` and `npm run db:verify`.

---

## I. 2,000+ call capacity from the current configuration

The binding limit is whichever is lower: how fast calls may **start** (CPS), or
how many may be **live** at once divided by how long each lasts.

* CPS limit: `min(global 3, lanes 3) = 3/s` → **10,800 calls/hour**
* Concurrency limit: `min(global 15, lanes 15) = 15` live calls

So **concurrency binds, by a factor of 24.** Channel occupancy per attempt
(ring + talk + teardown) is an **input, not a measurement** — nothing in this
repository has observed it:

| Assumed seconds/attempt | Calls/hour | 2,000 calls | 10,000 calls |
|---|---|---|---|
| 60 | 900 | 2.2 h | 11.1 h |
| 90 | 600 | 3.3 h | 16.7 h |
| **120** (planning figure) | **450** | **4.4 h** | **22.2 h** |
| 150 | 360 | 5.6 h | 27.8 h |
| 215 (35 s ring + 180 s max call — worst case) | 251 | 8.0 h | 39.8 h |

Read against a 10-hour calling window (10:00–20:00):

* **2,000 calls fit in one day at the current settings** on every assumption
  except the absolute worst case. No concurrency increase is required.
* **10,000 calls do not.** One day needs ~1,000 calls/hour, i.e. **~34
  concurrent channels** at 120 s/attempt (`1000 × 120 / 3600`). CPS is nowhere
  near binding — 0.28/s would do.

### Recommended safe initial values — unchanged from the defaults

**Concurrency 15 (5 per lane). CPS 3 (1 per lane).** Do not raise either for the
pilot. Reasons:

1. Vobiz's channel and CPS limits are **unconfirmed**. 15 concurrent calls is
   the number to ask them about.
2. Deepgram will see one streaming socket per live call — 15 concurrent — and
   that account limit is also unconfirmed.
3. `DATABASE_POOL_MAX` is **10** while concurrency is 15. Queries are short and
   not held for the call, so 10 is workable now, but pool max must be raised
   **with** any concurrency increase or the claim query becomes the bottleneck.
4. Every live call runs an audio pump in the **same Node process** as the
   dispatcher and the media bridges. The bridge already caps pump bursts after
   event-loop starvation and logs when it does. That log line is the real
   ceiling on concurrency for this deployment, and it has never been observed
   under load.

### What must be measured before raising concurrency

| Measurement | Source | Raise only if |
|---|---|---|
| Actual seconds/attempt | audit `connectedSeconds` p50/p95 + ring times | the arithmetic above says you need to |
| `pump burst capped` occurrences | deployment logs | **zero, or flat**, at the current concurrency |
| Voice p95 total latency | audit latency per provider | not degrading between rungs |
| DB claim latency | `dispatch_metrics.queue_wait_ms` / `claim_to_dial_ms` p95 | stable — a rise means the pool is the limit |
| Process RSS across a run | host metrics | flat |
| Vobiz concurrent-channel allowance | **the carrier** | your target is below it |
| Deepgram concurrent-stream allowance | **Deepgram** | your target is below it |
| OpenAI RPM/TPM headroom | **OpenAI dashboard** | turns/minute at target concurrency is below it |
| TTS concurrency limits ×3 | **each vendor** | per-lane concurrency is below the smallest |

Raise in one step at a time — concurrency **and** `DATABASE_POOL_MAX` together —
and re-run a rung you have already passed before going higher.

---

## J. Production observability

| Question | Answered by | Status |
|---|---|---|
| How many attempted? | results funnel / audit `attempted` | ✅ |
| How many answered? | `answered` (`answered_at IS NOT NULL`) | ✅ |
| How many completed? | `completed` | ✅ |
| How many failed? | `failed` + `byFailureClass` | ✅ |
| How many no-answer? | `noAnswer` | ✅ **inferred** by our watchdog |
| How many busy? | `busy` | ⚠️ lower bound — error-string only |
| How many rejected? | audit `byFailureClass.REJECTED` | ✅ **added in Phase 6** (the status enum has no REJECTED; nothing surfaced the class) — lower bound |
| How many registered? | outcomes `registered_confirmed` / `succeeded` | ✅ |
| How many did not register? | outcome rows with `succeeded IS NOT TRUE` | ✅ |
| Why did they not register? | audit `nonSuccessReasons` (outcome type × primary reason) | ✅ **added in Phase 6** |
| Which provider called each number? | `listAttempts`, audit `auditNumbers` (masked) | ✅ |
| Was any number called twice? | audit integrity: duplicates, over-retry-cap, max attempts, cross-campaign | ✅ **added in Phase 6** |
| Cost per provider? | results voice cost / audit cost | ✅ estimated |
| Cost per successful registration? | audit `costPerSuccessUsd` | ✅ **added in Phase 6**; `null`, never 0, without a success |
| Average / p50 / p95 latency? | audit latency (p95 **added in Phase 6**; results carry p50/p90) | ✅ |
| Average call duration? | audit `connectedSeconds` mean/p50/p95 | ✅ **mean added in Phase 6** |
| Any rate-limit errors? | audit `rateLimitedAttempts` + examples | ✅ **added in Phase 6**, separated out of `TEMPORARY` |
| Any system errors? | audit `systemFailures` + `eventErrorsByCode` | ✅ **added in Phase 6** |

Deliberately **not** answerable from the database, and stated as such by the
audit itself:

* voicemail vs human answer (no AMD);
* carrier-reported busy / rejected / hangup cause (no status callback);
* event-loop starvation and audio-pump warnings — these go to process stdout in
  the media bridge, so read the deployment logs for the run window;
* process memory growth — take it from host metrics.

The Phase 5 rule is preserved throughout: **no statement anywhere reads both
`call_metrics` and `dispatch_metrics`.** A database write can never appear inside
a provider's TTS latency.

---

## K. Steps before the FIRST real 10-call pilot

1. **Confirm the deployment is running `server.ts`.** `npm start`
   (`NODE_ENV=production tsx server.ts`), not `next start` — a Next route cannot
   terminate the media WebSocket. Confirm the host allows WebSocket upgrades on
   `/api/voice/vobiz/stream` with an idle timeout above 180 s.
2. `npm run db:migrate` then `npm run db:verify` → expect 16/16.
3. `npm run preflight:prod` → expect BLOCKED on check 6 only.
4. Import the 10-contact CSV, then `npm run preflight:prod -- <campaignId>` →
   expect checks 9, 21, 22, 23, 24, 25 PASS.
5. `GET /api/campaigns/{id}/preflight` → the only remaining blockers should be
   the kill switch and the standing external-limits entry.
6. **Obtain the external values in section C** — at minimum Vobiz concurrent
   channels, Vobiz CPS, per-DID limits, and whether a status callback and AMD
   exist. A 10-call pilot may proceed without them; 500 cannot.
7. Confirm `pilot_stage` is 0 and `CAMPAIGN_STAGE_MAX_CALLS` is 10.
   `GET /api/campaigns/{id}/stage` must report `effective: 10`.
8. Confirm the calling window is open, and that you are inside it in
   `Asia/Kolkata`, before starting. A run outside it is refused.
9. Have the STOP path ready: `POST /api/campaigns/{id}/stop` works from any
   process, because the instruction is a database row.
10. Set `CAMPAIGN_DIALING_ENABLED=true` **in the deployment environment only,
    for the pilot window**, and restart the process. Nothing in this repository
    will set it for you.
11. `POST /api/campaigns/{id}/start`. Watch `/progress` and the process logs
    live. Ten calls at these settings take a few minutes.
12. `npm run campaign:audit -- <campaignId>` and walk the rung-1 gate table in
    section H.
13. **Set `CAMPAIGN_DIALING_ENABLED` back to false** until the next rung is
    authorised.
