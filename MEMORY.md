# MEMORY.md — Persistent Project Memory

> Long-lived truth about this project. Read this **first** in every new
> conversation. Update it **only** when something structural changes:
> architecture, stack, a locked constraint, or a convention. Day-to-day progress
> belongs in [HANDOFF.md](HANDOFF.md), not here.

---

## 1. Project overview

**Voice Agent Lab** is an outbound voice-AI platform with two layers in one
codebase:

1. **The voice lab** — a provider-agnostic benchmarking harness. Any telephony /
   STT / LLM / TTS vendor can be swapped by changing an id, and per-turn latency
   and cost are measured for the resulting stack.
2. **The campaign layer** — production outbound calling: CSV contact import, a
   rate- and concurrency-limited dispatcher, a scripted conversation, outcome
   classification, results export, and Google-Sheet sync of positive outcomes.

Current real-world use: **registration / reminder calling campaigns in India**
(English, Hindi, Hinglish), placed through Vobiz, with confirmed-yes contacts
written to a Google Sheet.

- Repository: `https://github.com/gosainsakshi2-creator/Voice-agent-lab.git`
- Deployed base URL: `https://voice-agent-lab.onrender.com` (`APP_PUBLIC_BASE_URL`)

---

## 2. Tech stack

| Layer | Choice |
|---|---|
| Language | TypeScript 5.9, **ESM** (`"type": "module"`) |
| Runtime | Node >= 20 (dev machine runs Node 24), executed via `tsx` |
| Web | Next.js 16 (App Router) + React 19 |
| Server | **Custom server** `server.ts` (`npm run dev` = `tsx server.ts`) — required for the raw WebSocket media bridges Next cannot host |
| UI | Tailwind CSS 4, Radix primitives, `lucide-react`, `components.json` (shadcn-style) |
| Database | PostgreSQL via `pg`, plain SQL migrations in `src/campaign/db/migrations/` |
| Telephony | **Vobiz** (primary, live), Plivo (secondary / legacy) |
| STT | Deepgram |
| LLM | OpenAI GPT, Google Gemma |
| TTS | ElevenLabs, Cartesia, Sarvam, Smallest AI |
| Sheets | Google Sheets via service account (`GOOGLE_SERVICE_ACCOUNT_JSON`) |

---

## 3. Architecture

Dependency direction is strictly one-way — **nothing below ever imports upward.**

```
src/
├── types/          pure data shapes (no logic)
├── interfaces/     behavioural contracts only (no implementations)
├── constants/      locked, closed sets (provider ids, languages, state graph)
├── core/errors/    VoiceAgentError hierarchy
├── providers/      concrete vendor adapters, one per interface
│   ├── telephony/ speech-to-text/ language-model/ text-to-speech/
│   ├── registry/   id -> instance resolution (the ONLY place that knows both)
│   └── shared/     env, http, audio, health helpers
├── core/session/   DefaultVoiceSessionManager + the conversation pipeline
├── server/         media bridges (Plivo/Vobiz WS), audio codec, VAD segmenter
├── campaign/       the campaign layer (see below)
├── app/            Next.js App Router — API routes + dashboard UI
├── components/     React components
└── hooks/ lib/ utils/
```

**The two rules that keep it swappable**

- The Dashboard may call **only** `VoiceSessionManager`.
- `VoiceSessionManager` depends **only** on the four provider interfaces and the
  `ProviderRegistry` — never on a vendor SDK.

**Session lifecycle**

```
Idle → Initializing → WarmingProviders → Ready → Calling → Listening
  ↕                                                  ↕         ↕
 Error ←──────────────────────────────────────── Thinking ↔ Speaking → Ending → Idle
```

`SESSION_STATE_TRANSITIONS` (in `constants/session-states.constants.ts`) is a
declarative data table, not branching logic. Both `canTransition` and any future
analytics read from it.

**Campaign layer flow**

```
CSV import → validate → normalise phone → allocate TTS provider (lane)
   ↓
dispatcher  ── global Semaphore + TokenBucket
            ── per-lane Semaphore + TokenBucket
            ── calling-window watcher, control watcher (pause / resume / stop)
   ↓
call-runner → VoiceSessionManager → telephony + media bridge → live call
   ↓
outcome classifier → disposition → results repo → CSV export + FINAL_YES sheet sync
```

---

## 4. Important decisions and constraints

Full reasoning lives in [docs/DECISIONS.md](docs/DECISIONS.md); the binding
summary is here.

### Architecture

- Streaming was added as **additive optional interface members only** —
  `transcribeStream?`, `generateCompletionStream?`, `synthesizeStream?`,
  `openMediaStream?`. Every concrete provider stayed valid; the session manager
  feature-detects at runtime and falls back to whole-turn request/response.
- `pushInboundAudio`, `onOutboundAudio` and `signalBargeIn` exist on
  `DefaultVoiceSessionManager` but deliberately **not** on the
  `VoiceSessionManager` interface — transports and tests use them; the Dashboard
  cannot see them.
- Provider capability figures are never invented in config. Unconfirmed vendor
  limits stay conservative and are raised only against measurements.

### Production / load — see [docs/phases/PHASE6_PRODUCTION_READINESS.md](docs/phases/PHASE6_PRODUCTION_READINESS.md)

- **Vobiz confirmed ceiling: 3 simultaneous live calls.** This is the default for
  both `globalMaxConcurrent` and every lane. Exceeding it means carrier-side
  teardown of live conversations, indistinguishable from a random disconnect.
- **`CAMPAIGN_DIALING_ENABLED` is the kill switch**, default `false`. It is
  currently `true` in `.env.local` because real calling is live.
- **`CAMPAIGN_STAGE_MAX_CALLS` defaults to 10.** The effective ceiling is the
  *smallest* of the env ceiling, the pilot-stage rung and any per-campaign
  ceiling — every control can only ever lower the call count.
- **A single caller ID is a production blocker for volume.** `VOBIZ_FROM_NUMBER`
  is one number, read once, sent verbatim on every call. No pool, no rotation. A
  run whose ceiling exceeds `CAMPAIGN_MAX_CALLS_PER_DID` (500) is BLOCKED.
  Unblocking needs the DID list from Vobiz, not more code.
- **There is no AMD / voicemail detection.** "Answered" means "the media stream
  opened" — true for a human, a voicemail greeting and an IVR alike.
- `CPS = 0` means *no rate limit*, not *no calls*, and `MAX_CONCURRENCY = 0`
  silently never dials. Both are now refused at launch by `load-guardrails.ts` —
  the run is **refused, not clamped**.
- Advance the load ladder (10 → 50 → 100 → 500 → 2,000+) one rung at a time, and
  only when every gate in Phase 6 section H is green.

### Campaign correctness

- Scripts are pinned by a **content hash** (`hashScript`). Editing a script's
  wording changes its hash, which makes a running campaign's snapshot detectably
  stale instead of silently drifting.
- `COMMIT_ANCHORS` in `src/campaign/outcome/classifier.ts` matches the **exact
  wording of the gate question** in the script. Re-wording the script without
  updating the anchors silently kills FINAL_YES detection — and with it the sheet
  row and the auto-hangup.

---

## 5. Coding conventions

- **ESM, extensionless relative imports** — `import { x } from "./thing";`
- **Named exports only.** No `export default` anywhere in `src/` outside
  `src/app/`, where Next requires it for pages and routes.
- **One `index.ts` barrel per folder**, re-exporting that folder's public surface.
- **`readonly` on interface fields** and `readonly T[]` for arrays. Config is an
  immutable shape returned by a `getXConfig()` function, not a module-level
  constant.
- **All env access goes through `src/providers/shared/env`** (`optionalEnv`,
  `optionalEnvNumber`, and their required counterparts). Never touch
  `process.env` directly — `VoiceAgentLabEnv` augments `ProcessEnv`, so a typo is
  a compile error.
- **Every non-trivial file opens with a block comment** explaining *why* it exists
  and what the tradeoff was. Match that density; it is the house style.
- **Types live in `types/`, contracts in `interfaces/`, closed sets in
  `constants/`.** No file mixes those concerns.
- Tests are standalone `tsx` scripts under `src/campaign/tests/`, each wired to
  its own `npm run test:*` script. There is no test framework.

---

## 6. Things that must NOT be changed

1. **Folder names, interface names, and existing interface member signatures.**
   A provider interface may be extended only by appending an **optional** member,
   so every existing implementation stays valid.
2. **The voice/media layer** — `src/server/plivo-media-bridge.ts`,
   `vobiz-media-bridge.ts`, `audio-codec.ts`, `vad-segmenter.ts`, and the
   barge-in / turn-detection code in `src/core/session/`. Campaign-layer work
   must not reach into these. They are the most timing-sensitive code in the repo.
3. **The dialing kill switch and the load guardrails.** Never raise a limit to
   make something pass. `load-guardrails.ts` refusing a run is the feature.
4. **Concurrency above 3**, without new written confirmation from Vobiz.
5. **Script wording without also updating `COMMIT_ANCHORS`** (see §4).
6. **`.env.local`** — never rewrite it wholesale. It holds live credentials and
   has been corrupted once already (see §7).

---

## 7. Recurring gotchas — read before debugging

- **`.env.local` multi-line values break silently.** An unquoted multi-line JSON
  value (e.g. `GOOGLE_SERVICE_ACCOUNT_JSON`) truncates to `{`. Duplicate keys are
  last-win. The symptom is an auth failure that looks like a bad key.
- **`npm run typecheck` can pass on a file that does not parse** — a stale
  `tsconfig.tsbuildinfo`. When a result looks too good, run
  `npx tsc --noEmit --incremental false`.
- **Campaign tests need dialing off.** Running the campaign test scripts with
  `CAMPAIGN_DIALING_ENABLED=true` in `.env.local` produces ~3 failures that are
  *not* caused by your change. Turn it off for the run, then restore it.
- **Capacity reality check:** at concurrency 3 the system does roughly 200
  attempts/hour — ~2,000 calls is a full working day. The blockers on volume are
  `STAGE_MAX_CALLS=10` and the absence of auto-resume, not raw speed.

---

## 8. Key files worth knowing

| Concern | File |
|---|---|
| Session orchestration | [src/core/session/voice-session-manager.impl.ts](src/core/session/voice-session-manager.impl.ts) |
| Turn-by-turn pipeline | [src/core/session/conversation-pipeline.ts](src/core/session/conversation-pipeline.ts) |
| Dispatcher + limits | [src/campaign/dispatch/dispatcher.ts](src/campaign/dispatch/dispatcher.ts), [src/campaign/dispatch/concurrency.ts](src/campaign/dispatch/concurrency.ts) |
| All campaign limits | [src/campaign/config/dispatch.config.ts](src/campaign/config/dispatch.config.ts) |
| Refusal rules | [src/campaign/dispatch/load-guardrails.ts](src/campaign/dispatch/load-guardrails.ts) |
| Outcome classification | [src/campaign/outcome/classifier.ts](src/campaign/outcome/classifier.ts) |
| Scripts + hashing | [src/campaign/script/script-registry.ts](src/campaign/script/script-registry.ts) |
| Custom server entry | [server.ts](server.ts) |

---

*Last structural update: 2026-08-22.*
