# Voice Agent Lab — Technical Handoff

**Outbound voice-AI platform and provider-benchmarking harness**

| | |
|---|---|
| **Document version** | 1.0 |
| **Prepared** | 2026-09-07 |
| **Repository** | `voice-agent-lab` |
| **Branch inspected** | `voice-agent-improvements` |
| **HEAD commit** | `5eff685` — *conversational correctness issue* (2026-09-04) |
| **Working tree** | Clean at time of writing |
| **Audience** | Incoming senior engineer |

> **Accuracy rule for this document.** Every architectural statement below is
> taken from the source tree at the commit above. Where a fact could not be
> established from the repository it is marked **"Not confirmed from
> repository."** No credentials, keys, tokens or private URLs appear here —
> only environment-variable **names**.

---

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [System overview](#2-system-overview)
3. [Technology stack](#3-technology-stack)
4. [High-level architecture](#4-high-level-architecture)
5. [End-to-end voice flow](#5-end-to-end-voice-flow)
6. [Telephony and media streaming](#6-telephony-and-media-streaming)
7. [STT layer](#7-stt-layer)
8. [LLM layer](#8-llm-layer)
9. [TTS and voice-provider layer](#9-tts-and-voice-provider-layer)
10. [Turn detection and the conversation pipeline](#10-turn-detection-and-the-conversation-pipeline)
11. [Barge-in and interruption handling](#11-barge-in-and-interruption-handling)
12. [Hearing / attention handling](#12-hearing--attention-handling)
13. [Conversation state and continuity](#13-conversation-state-and-continuity)
14. [Call recording](#14-call-recording)
15. [Campaign architecture](#15-campaign-architecture)
16. [Outcome classification](#16-outcome-classification)
17. [Latency and performance](#17-latency-and-performance)
18. [Cost architecture](#18-cost-architecture)
19. [Testing and quality](#19-testing-and-quality)
20. [Deployment and environment configuration](#20-deployment-and-environment-configuration)
21. [Known issues](#21-known-issues)
22. [Engineering "do not break" rules](#22-engineering-do-not-break-rules)
23. [Important files / code map](#23-important-files--code-map)
24. [Getting started for a new engineer](#24-getting-started-for-a-new-engineer)

---
<div class="page-break"></div>

## 1. Executive summary

**Voice Agent Lab is two products in one codebase, sharing one provider
abstraction.**

1. **The voice lab** — a provider-agnostic benchmarking harness for
   conversational voice stacks. Telephony, STT, LLM and TTS vendors are
   addressed by `{category, id}` identifiers resolved through a
   `ProviderRegistry`, so swapping ElevenLabs for Cartesia in a benchmark run
   is a *data* change, not a code change. Per-turn latency and estimated cost
   are measured for whatever stack is selected.

2. **The campaign layer** — production outbound calling: CSV contact import,
   a rate- and concurrency-limited dispatcher, a scripted conversation, a
   deterministic rule-based outcome classifier, results export, and Google
   Sheet sync of confirmed positive outcomes.

The live use today is **registration / reminder calling campaigns in India**
(English, Hindi, Hinglish) placed through **Vobiz**, with confirmed-yes
contacts written to a Google Sheet
(`src/campaign/integrations/final-yes-sheet.ts`).

**What makes this codebase unusual, and what you must internalise first:**

- **The most valuable asset is the comment density.** Nearly every non-trivial
  file opens with a block comment explaining *why* it exists and what the
  trade-off was. Many of those comments record a specific production defect
  and the measurement that motivated the fix. Read them before changing
  timing-sensitive code; several constants look arbitrary and are not.
- **The voice/media layer is the most fragile code in the repo.** Turn
  detection, barge-in, endpointing, the media bridges and the audio codec were
  each hardened against a specific reported production failure. Section 22
  lists what must not regress.
- **The campaign layer is guarded by refusals, not clamps.**
  `load-guardrails.ts` refuses a misconfigured run rather than silently
  correcting it. `CAMPAIGN_DIALING_ENABLED` is a hard kill switch. Real calls
  are live in the current `.env.local`.
- **`ConversationPipeline` is ~4,970 lines in one file.** It is the single
  most important file to understand and the hardest to change safely.

---

## 2. System overview

### 2.1 What the system does

Given a list of phone numbers and an approved script, the system:

1. dials each number through a telephony carrier;
2. streams the call's audio bidirectionally over a WebSocket;
3. transcribes the caller in real time (Deepgram streaming);
4. decides when the caller has finished speaking (adaptive turn detection);
5. generates a reply (OpenAI GPT streaming), sentence-chunked;
6. synthesizes and plays that reply as it is generated (streaming TTS);
7. handles interruption, backchannel, self-echo and "can you hear me" cases;
8. classifies the finished transcript into an outcome;
9. projects that onto a contact-level disposition (`FINAL_YES` / `FINAL_NO` /
   `RETRYABLE` / `UNRESOLVED` / `TECHNICAL_FAILURE`);
10. decides retry vs terminal, persists everything, and mirrors a definitive
    `FINAL_YES` into a Google Sheet.

Simultaneously, per-turn STT / LLM / TTS / end-to-end latency and estimated
cost are recorded per call, tagged with the provider stack that produced them
— which is what makes the platform a benchmark rather than just a dialer.

### 2.2 Dependency direction

Strictly one-way. Nothing below ever imports upward.

```
types/          pure data shapes, no logic
interfaces/     behavioural contracts only, no implementations
constants/      locked closed sets (provider ids, languages, state graph)
core/errors/    VoiceAgentError hierarchy
providers/      concrete vendor adapters + registry + shared env/http/audio
core/session/   DefaultVoiceSessionManager + ConversationPipeline
server/         media bridges, audio codec, VAD segmenter, runtime bootstrap
campaign/       campaign layer (dispatch, outcome, results, integrations)
app/            Next.js App Router — API routes + dashboard UI
components/ hooks/ lib/ utils/
```

**Two rules keep the platform swappable** (`docs/DECISIONS.md`, D-01/D-02):

- The Dashboard may call **only** `VoiceSessionManager`.
- `VoiceSessionManager` depends **only** on the four provider interfaces and
  the `ProviderRegistry` — never on a vendor SDK.

---
<div class="page-break"></div>

## 3. Technology stack

All versions below are the declared ranges in `package.json` at HEAD.

### 3.1 Language and runtime

| Concern | Choice | Evidence |
|---|---|---|
| Language | TypeScript `^5.9.3`, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` | `tsconfig.json` |
| Module system | **ESM** (`"type": "module"`), extensionless relative imports | `package.json` |
| Runtime | Node `>=20`, executed through `tsx ^4.19.2` (no build step for the server) | `package.json` `engines`, `scripts.dev` |
| Target / lib | `ES2022`, `DOM` | `tsconfig.json` |
| Path alias | `@/*` → `src/*` | `tsconfig.json` |

### 3.2 Frontend

| Concern | Choice | Evidence |
|---|---|---|
| Framework | **Next.js `^16.2.12`**, App Router (`src/app/`) | `package.json`, `src/app/layout.tsx` |
| UI library | **React `^19.2.8`** / `react-dom ^19.2.8` | `package.json` |
| Styling | **Tailwind CSS `^4.0.0`** via `@tailwindcss/postcss`, CSS-variable design tokens | `src/app/globals.css`, `postcss.config.mjs` |
| Component primitives | **Radix UI** — avatar, label, scroll-area, select, separator, slot, tooltip | `package.json` |
| Component convention | shadcn-style, style `new-york`, base colour `neutral`, CSS variables on | `components.json` |
| Icons | `lucide-react ^0.460.0` | `components.json` (`iconLibrary: "lucide"`) |
| Fonts | `geist ^1.7.2` (Geist Sans + Geist Mono) | `src/app/layout.tsx` |
| Class utilities | `clsx`, `tailwind-merge`, `class-variance-authority` | `package.json` |
| Animation | `tw-animate-css ^1.2.5` (dev dependency, imported from `globals.css`) | `src/app/globals.css` |

> **Animation libraries:** there is **no** Framer Motion / GSAP / react-spring
> dependency. Animation is CSS-only via Tailwind + `tw-animate-css`.

Two UI surfaces exist:

- `/` — the **benchmark dashboard** (`src/components/dashboard/`): provider
  stack config, live transcript, live metrics, session-state stepper. Backed
  by `useLiveSession` over an SSE endpoint, with a mock fallback
  (`src/lib/mock/`) so the UI renders with no providers registered.
- `/campaigns` and `/campaigns/[id]` — the **campaign console**
  (`src/components/campaign/`): campaign list, CSV import, controls
  (start/pause/resume/stop/stage), live calls, results.

### 3.3 Backend

| Concern | Choice | Evidence |
|---|---|---|
| HTTP server | **Custom Node `http` server** (`server.ts`) that delegates all normal requests to Next's request handler | `server.ts` |
| Why custom | Next App Router routes cannot terminate a WebSocket upgrade; the telephony media streams **are** WebSockets | `server.ts` header comment |
| WebSocket | `ws ^8.18.0`, `WebSocketServer({ noServer: true })`, manual `server.on("upgrade")` routing | `server.ts` |
| WS paths | `/api/voice/plivo/stream`, `/api/voice/vobiz/stream` — both require `?sessionId=` | `server.ts` |
| API architecture | Next App Router route handlers under `src/app/api/**` (REST + one SSE stream) | route files |
| Live UI updates | **Server-Sent Events**, not WebSocket — `GET /api/sessions/[id]/events` | `src/app/api/sessions/[id]/events/route.ts` |
| Database | **PostgreSQL** via `pg ^8.23.0`, plain SQL migrations | `src/campaign/db/` |
| Migration runner | Hand-rolled — `npm run db:migrate` (`src/campaign/db/migrate.ts`) | `package.json` |
| Process singleton | One `ProviderRegistry` + one `DefaultVoiceSessionManager` on `globalThis` | `src/server/runtime.ts` |
| HTTP tuning | `undici ^7.29.0` global dispatcher with extended keep-alive | `src/server/http-keepalive.ts` |
| Graceful shutdown | SIGTERM/SIGINT → close listeners, close PG pool, exit | `server.ts` |

> The DB pool close on shutdown exists because the pooler (Supabase, per the
> comment in `server.ts`) kept counting half-open sessions against a per-tenant
> client limit, so the *next* instance could be refused with
> `EMAXCONNSESSION`.

### 3.4 Voice stack

| Concern | Value | Evidence |
|---|---|---|
| Telephony (primary, live) | **Vobiz** — REST `POST/DELETE /api/v1/Account/{auth_id}/Call/`, header auth `X-Auth-ID` / `X-Auth-Token` | `src/providers/telephony/vobiz.provider.ts` |
| Telephony (secondary / legacy) | **Plivo** via `plivo ^4.75.1` SDK | `src/providers/telephony/plivo.provider.ts` |
| Media protocol | Vendor JSON-over-WebSocket (`start` / `media` / `playAudio` / `clearAudio`) | both media bridges |
| Inbound audio | **G.711 μ-law, 8 kHz, mono**, base64 in `media.payload` | answer-URL XML `contentType="audio/x-mulaw;rate=8000"` |
| Outbound audio | **G.711 μ-law, 8 kHz**, 20 ms frames = **160 bytes** | `OUTBOUND_FRAME_BYTES = 160` in both bridges |
| Outbound pacing | Real-time pump at 20 ms, max 3 frames/tick, 5-frame (100 ms) pre-roll | both bridges |
| STT | **Deepgram** `@deepgram/sdk ^5.7.0`, model default **`nova-3`** | `src/providers/speech-to-text/deepgram.provider.ts` |
| STT streaming config | `language: "multi"`, `encoding: "mulaw"`, `sample_rate: 8000`, `interim_results`, `punctuate`, `smart_format`, `endpointing: 400`, `utterance_end_ms: 1000`, `vad_events: true` | same file |
| LLM (campaign) | **OpenAI**, provider id `gpt-5.1`, `openai ^7.3.0`, Chat Completions **streaming** with `verbosity: "low"` and `stream_options.include_usage` | `src/providers/language-model/openai-gpt.provider.ts` |
| LLM (alternate) | **Google Gemma** via `@google/generative-ai ^0.24.1`, default `gemma-4-31b-it` | `src/providers/language-model/gemma.provider.ts` |
| TTS | **ElevenLabs**, **Cartesia**, **Sarvam AI**, **Smallest AI** — all four implement `synthesizeStream` | `src/providers/text-to-speech/` |
| Transcoding | Hand-written μ-law encode/decode + anti-aliased resampler | `src/server/audio-codec.ts` |

### 3.5 Infrastructure and external services

| Concern | Status |
|---|---|
| Deployed base URL | `https://voice-agent-lab.onrender.com` (per `MEMORY.md`; read from `APP_PUBLIC_BASE_URL`) |
| Deployment manifest | **None in the repository** — no `render.yaml`, `Dockerfile`, `Procfile`, `*.yaml`, `fly.toml`. Verified by search. |
| Render region / plan / CPU / memory | **Not confirmed from repository.** No `RENDER_*` env var is read anywhere in `src/`. |
| Google Sheets | Service-account JWT → OAuth token → Sheets `values.append` (`src/campaign/integrations/google-sheets.client.ts`) |
| Phone parsing | `libphonenumber-js ^1.13.11` |
| CSV parsing | `csv-parse ^5.6.0` |
| Logging / monitoring | **`console.*` only.** No logging library, no APM, no metrics exporter, no Sentry. Every subsystem uses a structured prefix — `[PIPELINE:sid]`, `[TURN:sid]`, `[TIMING:sid]`, `[STT:deepgram]`, `[LLM:openai]`, `[TTS:…]`, `[vobiz-bridge:sid]`, `[SPECULATE:sid]`, `[PLAYBACK:sid]`, `[sheet-sync]`, `[campaign-db]`. Operational observability is these logs plus the `call_metrics` / `dispatch_metrics` / `campaign_events` tables and `npm run campaign:audit`. |

---
<div class="page-break"></div>

## 4. High-level architecture

### 4.1 The live-call path (verified against the implementation)

```
                    Caller (PSTN handset)
                              |
                              v
              Vobiz / Plivo carrier  ── REST: startCall / endCall / Record
                              |
                (callee answers -> carrier fetches answer_url)
                              |
                              v
       /api/voice/{vobiz|plivo}/answer   ->  returns <Stream> XML
                              |
                (carrier opens WebSocket to the app)
                              |
                              v
        server.ts  "upgrade" handler  ->  attach{Vobiz|Plivo}MediaBridge
                              |
      +-----------------------+------------------------+
      |  inbound: base64 mulaw frames                   |  outbound: playAudio
      v                                                 ^
  manager.pushInboundAudio()                    onOutboundAudio() listener
      |                                                 |  (20ms pump, mulaw)
      v                                                 |
  SessionRecord.inboundAudioFallback (AsyncQueue)       |
      |                                                 |
      v                                                 |
  ConversationPipeline.startContinuousStt()             |
      |                                                 |
      v                                                 |
  Deepgram live WS  ->  TranscriptSegment stream        |
      |                                                 |
      +--> voicemail check                              |
      +--> backchannel filter (SPEAKING only)           |
      +--> interruption corroboration (SPEAKING only)   |
      +--> self-echo filter                             |
      +--> triggerExternalBargeIn()  ------------------>|  clearAudio
      |                                                 |
      v                                                 |
  AdaptiveTurnDetector.feed()                           |
      |  (silence window + evidenced confirmation)      |
      v                                                 |
  onTurnEnd  ->  main loop acquires the user turn       |
      |                                                 |
      +--> ConversationMemory.recordUserTurn()          |
      +--> handleAttentionCheck()  (may answer w/o LLM) |
      |                                                 |
      v                                                 |
  OpenAI generateCompletionStream (may be pre-opened)   |
      |  token deltas                                   |
      v                                                 |
  SentenceChunker  ->  sentence                         |
      |                                                 |
      v                                                 |
  TTS synthesizeStream  ->  PCM_16 chunks               |
      |                                                 |
      v                                                 |
  playAudioChunk -> onOutboundAudio ------------------->+
      |
      v
  drainPlayback()  (holds SPEAKING until audio has really played)
      |
      v
  ConversationMemory.recordAssistantTurn()  ->  back to LISTENING
```

**Corrections to the generic flow in the brief:**

- There is **no separate "voice session" step after the WebSocket** — the
  session is created *before* dialling by the campaign call-runner (or the
  dashboard), and the media bridge attaches to an existing session by
  `sessionId` carried through the answer URL.
- Audio does **not** flow through the `TelephonyProvider`. Neither telephony
  provider implements the optional `openMediaStream` member; the bridges call
  `manager.pushInboundAudio` / `manager.onOutboundAudio` / `signalBargeIn`
  directly on the concrete manager class (decision D-03).
- **STT starts before the greeting**, not after it (`run()` in
  `conversation-pipeline.ts`) — the Deepgram handshake and audio backlog would
  otherwise land on the first user turn.
- The greeting is a **fixed spoken line**, not an LLM generation.

### 4.2 The campaign / outcome path

```
  Contact row (assigned_provider locked at import)
        |
        v
  CampaignDispatcher lane  (per-provider Semaphore + TokenBucket,
        |                   under a shared global Semaphore + TokenBucket)
        v
  runCall()  -- attempt row FIRST -> kill switch -> campaign context
        |
        v
  VoiceSessionManager  ->  live call  (watchdog: ring / max-duration /
        |                              max-silence / FINAL answer /
        |                              agent closing)
        v
  manager.getTranscript()  ->  StoredTranscript
        |
        v
  classifyOutcome()      -> outcomeType (11 values) + signals + explanation
        |
        v
  dispositionFor()       -> FINAL_YES | FINAL_NO | RETRYABLE |
        |                    UNRESOLVED | TECHNICAL_FAILURE
        v
  planRetry()            -> retry vs terminal, next_attempt_after
        |
        v
  finalizeAttempt()      -> attempt closed + contact moved, one transaction
        |
        v
  saveClassification()   -> call_outcomes (+ stored transcript)
        |
        v
  syncFinalYesToSheet()  -> Google Sheet row, only when FINAL_YES
```

---
<div class="page-break"></div>

## 5. End-to-end voice flow

Stage by stage, with the file and function responsible.

| # | Stage | Where |
|---|---|---|
| 1 | **Outbound call requested** | `runCall()` — `src/campaign/dispatch/call-runner.ts`, or `POST /api/sessions/[id]/start` for the dashboard |
| 2 | **Session created** | `DefaultVoiceSessionManager.createSession()` — resolves all four providers up front so a bad stack fails before dialling |
| 3 | **Provider warm-up** | `warmUpProviders()` → `WARMING_PROVIDERS` state, per-provider `checkHealth`, result in `SessionWarmupResult` |
| 4 | **Dial** | `start()` → `TelephonyProvider.startCall()`; Vobiz returns `request_uuid` as the handle |
| 5 | **Answer webhook** | `src/app/api/voice/vobiz/answer/route.ts` — returns `<Stream bidirectional="true" contentType="audio/x-mulaw;rate=8000" keepCallAlive="true">` and (Vobiz only) fires recording in the background |
| 6 | **Media WebSocket** | `server.ts` upgrade handler → `attachVobizMediaBridge` / `attachPlivoMediaBridge` |
| 7 | **Call answered** | Bridge's `start` event → `manager.confirmCallAnswered()` → `CALLING` → `LISTENING`, pipeline `run()` begins |
| 8 | **Inbound audio ingestion** | Bridge `media` event → `MulawVadSegmenter` (energy detection only) **and** `manager.pushInboundAudio()` → `SessionRecord.inboundAudioFallback` (`AsyncQueue`) |
| 9 | **STT streaming** | `ConversationPipeline.startContinuousStt()` → `DeepgramSpeechToTextProvider.transcribeStream()` — **one continuous socket for the whole call** |
| 10 | **Greeting** | `openingLineFor()` (`system-prompt.ts`) spoken through `speakFixedUtterance()`. No LLM request. `primeLlmPrefixCache()` runs concurrently. |
| 11 | **Interim / final transcripts** | `transcriptEventFromMessage()` maps Deepgram messages to `TranscriptSegment`, distinguishing `isFinal` (chunk boundary) from `isSpeechFinal` (endpoint) and emitting a text-less `isEndOfSpeechMarker` |
| 12 | **Turn detection** | `AdaptiveTurnDetector.feed()` / `.noteEndOfSpeech()` — adaptive silence window + evidenced confirmation window |
| 13 | **Turn release** | `emitTurnEnd()` → `onTurnEnd` listener in `waitForTurnDetectorEnd()` → `acquireNextUserTurn()` returns an `AcquiredTurn` |
| 14 | **User turn committed** | `ConversationMemory.recordUserTurn(text, detectedLanguage)`; `record.liveUserTranscript` cleared |
| 15 | **Attention-check interception** | `handleAttentionCheck()` — may answer the turn with a fixed line and **never reach the model** |
| 16 | **LLM request** | `runThinkingAndSpeaking()` → `buildRequestHistory()` → `generateCompletionStream()`. A **pre-opened** (speculative) stream may be adopted. |
| 17 | **LLM streaming + chunking** | `runStreamingCompletion()` → `SentenceChunker.push(delta)` → per-sentence `synthesizeAndPlay()` |
| 18 | **TTS** | `synthesizeAndPlay()` prefers `synthesizeStream`, falls back to `synthesize` + simulated playback duration |
| 19 | **Playback** | `playAudioChunk()` → `record.emitOutboundAudio()` → bridge queue → 20 ms pump → `playAudio` JSON |
| 20 | **Drain** | `drainPlayback()` holds SPEAKING until the queued audio has really played (plus a 150 ms pre-roll allowance) |
| 21 | **Assistant turn committed** | `ConversationMemory.recordAssistantTurn()` — **the full text if completed, only the heard prefix if barged-in** |
| 22 | **Metrics** | `SessionMetricsCollector.recordTurn()` — per-stage latency + per-stage cost |
| 23 | **Call end** | Watchdog verdict or remote hangup → `manager.end()` → abort loop, stop playback, close media, `TelephonyProvider.endCall()` |
| 24 | **Persistence** | `captureTranscript()` → `classifyOutcome()` → `dispositionFor()` → `planRetry()` → `finalizeAttempt()` → `saveClassification()` → `syncFinalYesToSheet()` |

### 5.1 Session state machine

`src/constants/session-states.constants.ts` is a declarative transition table,
not branching logic. `canTransition()` reads it.

```
IDLE -> INITIALIZING -> WARMING_PROVIDERS -> READY -> CALLING -> LISTENING
                                                              <->  THINKING
                                                                      <->
                                                                  SPEAKING
                                                          -> ENDING -> IDLE
```

- `THINKING -> LISTENING` exists **specifically** so the pipeline can recover
  from a failed turn without ending the session.
- `SPEAKING -> LISTENING` is the barge-in / drain-complete edge.
- Any non-terminal state may go to `ERROR`; `ERROR` may go to `ENDING` or
  `IDLE`.
- There is **no** `LISTENING -> SPEAKING` edge, which is why every fixed
  utterance passes through `THINKING` (`speakFixedUtterance`).

---
<div class="page-break"></div>

## 6. Telephony and media streaming

### 6.1 Providers

| | Vobiz (primary, live) | Plivo (secondary) |
|---|---|---|
| File | `src/providers/telephony/vobiz.provider.ts` | `src/providers/telephony/plivo.provider.ts` |
| SDK | none — direct `fetch` | `plivo ^4.75.1` |
| Auth | `X-Auth-ID` / `X-Auth-Token` headers | SDK client |
| Start call | `POST /api/v1/Account/{auth_id}/Call/` with `from`, `to`, `answer_url`, `answer_method` → `request_uuid` | SDK `calls.create` |
| End call | `DELETE /api/v1/Account/{auth_id}/Call/{call_uuid}/` | SDK |
| Health | `GET /api/v1/auth/me` | SDK probe |
| Recording | `POST .../Call/{call_uuid}/Record/` — **Vobiz only** | none |
| `openMediaStream` | **not implemented** | **not implemented** |
| Answer route | `src/app/api/voice/vobiz/answer/route.ts` | `src/app/api/voice/plivo/answer/route.ts` |
| Bridge | `src/server/vobiz-media-bridge.ts` | `src/server/plivo-media-bridge.ts` |
| Session correlation | `sessionId` in the `answer_url` query string | `pending-call.ts` — `CallUUID` → pending session claim |
| Live call-id re-key | **Yes** — the bridge calls `manager.setProviderCallId(sessionId, start.callId)` on the `start` event | **No** — the `request_uuid`/handle is never re-keyed |

Note the **different correlation mechanisms**: Vobiz carries the `sessionId`
through the answer URL; Plivo claims a *pending* session by `CallUUID` because
its answer webhook does not carry our identifier.

### 6.2 Audio format — confirmed by code

| Direction | Codec | Rate | Frame | Notes |
|---|---|---|---|---|
| Inbound | G.711 μ-law | 8 kHz mono | vendor-paced (~20 ms) | Requested via `contentType="audio/x-mulaw;rate=8000"` on the `<Stream>` XML |
| Outbound | G.711 μ-law | 8 kHz | **160 bytes = 20 ms** | `contentType: "audio/x-mulaw"` **bare** plus `sampleRate: 8000` in the JSON — the `;rate=` suffix is valid *only* on the XML attribute |

TTS providers emit `PCM_16` at their own configured rate;
`createOutboundMulawEncoder()` (`audio-codec.ts`) resamples with an
anti-aliased resampler and encodes to μ-law, and
`createOutboundMulawFramer(160)` cuts it into exact 20 ms frames so a runt
frame can never desynchronise the pump.

### 6.3 Outbound playback pump

Both bridges implement the same shape:

| Constant | Value | Purpose |
|---|---|---|
| `OUTBOUND_FRAME_BYTES` | 160 | 20 ms at 8 kHz μ-law |
| `OUTBOUND_FRAME_MS` | 20 | pump tick |
| `MAX_FRAMES_PER_TICK` | 3 | prevents burst-flooding after event-loop starvation |
| `PREROLL_FRAMES` | 5 (100 ms) | builds a playout cushion before the first send |
| `PREROLL_MAX_WAIT_MS` | 120 | short utterances never reach the pre-roll count |

**Plivo only** additionally implements outbound backpressure:

| Constant | Value |
|---|---|
| `OUTBOUND_HIGH_WATER_FRAMES` | 140 (≈2,800 ms) |
| `OUTBOUND_LOW_WATER_FRAMES` | 110 (≈2,200 ms) |
| `OUTBOUND_BACKPRESSURE_TIMEOUT_MS` | 5,000 |

> **Asymmetry to know about:** `vobiz-media-bridge.ts` has **no** high/low
> water marks and no backpressure gate. On the live Vobiz lane the outbound
> queue is unbounded within the process. This is a real difference between the
> two bridges, not an oversight in this document.

### 6.4 Playback clearing (barge-in on the wire)

`clearOutboundPlayback()` in each bridge:

1. drops every queued frame in the process,
2. stops the pump and clears the pre-roll timer,
3. sends `{ event: "clearAudio", streamId }` so the carrier drops what it has
   already buffered.

It is invoked from two places:

- the `onStateChange` listener, when a `SPEAKING -> LISTENING` transition
  carries a reason matching `/barge.?in/i`;
- the energy-only fallback, **only if `manager.signalBargeIn()` returned
  `true`** — because the pipeline declines a barge-in while the fixed opening
  line is playing, and dropping the queue anyway would leave the caller in
  silence with nothing to play and no reply on the way.

### 6.5 Energy gates in the bridges

Two independent thresholds, answering two different questions
(`vad-segmenter.ts` + bridge constants):

| Gate | Threshold | Duration | Question it answers | Consumer |
|---|---|---|---|---|
| **Liveness** | RMS ≥ 700 | 6 frames = 120 ms | "is anyone on this line?" | `manager.noteCallerSpeech()` → keeps the campaign silence watchdog from hanging up on a soft-spoken caller. **Never triggers barge-in.** |
| **Near-end speech** | RMS ≥ 1600 | 4 frames = 80 ms | "is the *caller* talking over us, rather than a TV / a second person / our own echo?" | `manager.noteCallerEnergy()` → **corroborates** a Deepgram transcript before it may interrupt |

Plus an **energy-only fallback**: `ENERGY_ONLY_BARGE_IN_MS = 700` of sustained
near-end energy with *no transcript at all* barges in directly — the last
resort for a dead STT socket.

**Vobiz only** gates that fallback on `STT_UNHEALTHY_AFTER_MS = 30_000`: if
Deepgram delivered a segment less than 30 s ago the socket is demonstrably
alive, so loud energy that produced no words is *not* the caller, and the
fallback is suppressed (logged as `energy-only barge-in SUPPRESSED`). This
closed the defect reported as "Sarvam truncates sentences".

> **Second asymmetry:** `plivo-media-bridge.ts` has **no**
> `STT_UNHEALTHY_AFTER_MS` gate. Its energy-only fallback still fires
> unconditionally after 700 ms.

### 6.6 Connect / disconnect

- **Connect:** the bridge's `start` event is the only place
  `manager.confirmCallAnswered()` is called. "Answered" therefore means *the
  media stream opened* — true for a human, a voicemail greeting and an IVR
  alike (see §14 and §21).
- **Disconnect:** Vobiz sends **no** `stop` event; WebSocket close *is*
  end-of-stream. Plivo does send `stop`. Both bridges' `cleanup()` unsubscribes
  the outbound listener and the state listener, clears the pump, and discards
  the queue.
- **Hang-up:** initiated by `DefaultVoiceSessionManager.end()`, which aborts
  the loop, stops playback, closes the media stream **and** calls
  `TelephonyProvider.endCall()` on the carrier leg. The campaign watchdog, the
  dashboard's End Call, and the pipeline's voicemail path all go through this
  one method.

> **The two Vobiz call identifiers — read this before touching hangup or
> recording.** `startCall()` can only return what the placement API returns,
> which for Vobiz is the **`request_uuid`**. But its hangup API
> (`DELETE .../Call/{call_uuid}/`) and its recording API
> (`POST .../Call/{call_uuid}/Record/`) are both keyed by the **`call_uuid`**,
> which exists only once the callee has answered. It arrives in two independent
> places: as `start.callId` on the media WebSocket, and in the answer-URL
> webhook payload.
>
> - The **Vobiz bridge** re-keys the session's telephony handle via
>   `manager.setProviderCallId(sessionId, event.start.callId)` — the additive,
>   non-interface method on `DefaultVoiceSessionManager`. It writes one field
>   and nothing else; `end()` → `telephony.endCall()` remains the only hangup
>   path. Without it, **every** programmatic hangup (the watchdog's closing /
>   final-answer / silence / duration endings, the voicemail hangup, the
>   dashboard's End Call) was a `DELETE` on the wrong id — a 404 logged as
>   "call may already have ended", and a carrier leg left up until the person
>   hung up themselves.
> - The **answer webhook** independently extracts the `call_uuid` for recording
>   (§14), accepting the four spellings Vobiz uses.
>
> The **Plivo bridge does not re-key anything** — `setProviderCallId` has
> exactly one call site in the repository, in `vobiz-media-bridge.ts`.

---
<div class="page-break"></div>

## 7. STT layer

**File:** `src/providers/speech-to-text/deepgram.provider.ts`

| Parameter | Value | Source |
|---|---|---|
| Provider | Deepgram, `@deepgram/sdk ^5.7.0` | `package.json` |
| Model | `DEEPGRAM_MODEL`, default **`nova-3`** | `loadEnvConfig()` |
| Live connection | `client.listen.v1.connect(...)` — a **reconnecting** socket | `transcribeStream` |
| Language | **`"multi"`** on the streaming path (Hinglish code-switching) | `transcribeStream` |
| Encoding / rate | `mulaw` / `8000` — the raw telephony frames, no transcode | `transcribeStream` |
| Interim results | `true` | `transcribeStream` |
| Punctuation | `punctuate: true`, `smart_format: true` | both paths |
| Endpointing | **`400` ms** | `transcribeStream` |
| `utterance_end_ms` | **`1000`** (Deepgram's documented minimum) | `transcribeStream` |
| `vad_events` | `true` — but `SpeechStarted` messages are **deliberately dropped** | `transcriptEventFromMessage` |
| Keep-alive | check every 3 s, send if no audio sent for 4 s | `KEEPALIVE_INTERVAL_MS` / `KEEPALIVE_IDLE_MS` |
| Batch path | `transcribeFile` with the session language's BCP-47 tag — used only by the non-streaming fallback | `transcribe()` |

### 7.1 Two different claims: `is_final` vs `speech_final`

This distinction is load-bearing throughout the pipeline:

- **`is_final`** — "I will not revise these words." A **chunk boundary**,
  emitted repeatedly *mid-utterance*.
- **`speech_final`** — "my endpointer detected end of speech." The actual
  endpoint claim.

Treating them alike is what let `"I'm going to..."` be released as a finished
turn. `TranscriptSegment` therefore carries both as separate fields
(`isFinal`, `isSpeechFinal`).

### 7.2 `transcriptEventFromMessage` — the whole message mapping, as a pure function

Exported specifically so tests can assert both sides of each boundary without
opening a socket. Four cases:

| Deepgram message | Result |
|---|---|
| `UtteranceEnd` | **end-of-speech marker** — `{ text: "", isFinal: true, isSpeechFinal: true, isEndOfSpeechMarker: true, confidence: 0, startedAtMs: 0, endedAtMs: 0 }` |
| `SpeechStarted` (from `vad_events`) | **dropped** — barge-in has its own corroborated energy gate |
| `Results` with no transcript | **dropped**, *unless* `is_final && speech_final`, in which case it is the same end-of-speech marker (the endpoint arriving alone, after the words) |
| `Results` with a transcript | a real segment, carrying `isFinal` and `isSpeechFinal` as two separate claims, plus confidence and word timings |

The marker's absence of text, confidence and word timings is deliberate:
`endedAtMs: 0` would be read as an enormous inter-final gap and would push the
detector's adaptive threshold to its ceiling for the rest of the call — which
is why `startContinuousStt` routes a marker straight to
`turnDetector.noteEndOfSpeech()` and to nothing else (not the display preview,
not the lag metric, not the STT stream clock, not the barge-in gates, not
`feed`).

### 7.3 Why `utterance_end_ms` was added

Measured on the live socket, holding the utterance constant and changing only
the trailing audio:

| Trailing audio | `speech_final` | Recognition lag |
|---|---|---|
| Pure digital silence | **on the words** | 878 ms |
| Low-level line noise | **absent** — arrives 2,289 ms later in its own empty message | 1,740 ms |
| Faint background voice | **absent entirely** | — |

On a real (noisy) line the endpoint claim is therefore in flight *after* the
turn detector has already released. `utterance_end_ms` is word-timing-based,
not VAD-based, so it survives exactly the noise that suppresses
`speech_final`. It **supplements** and replaces nothing.

### 7.4 Reconnect survival

`client.listen.v1.connect()` returns a **reconnecting** socket: on any close
that is not code `1000` it redials itself, reattaches the handler, and flushes
the audio it buffered while down. The provider therefore ends the transcript
stream on exactly one condition: **this generator deciding the call is over**
(audio source exhausted or session aborted). Ending it on the first `close` /
`error` — as an earlier version did — killed transcription for the rest of the
call, froze `lastConversationActivityAt`, and the campaign silence watchdog
hung up a live conversation ~20 s later. That defect is covered by
`test:phase10`.

A reconnect restarts Deepgram's **word clock at zero** while our
`inboundStreamMs` keeps climbing. `sttStreamMsOf()` in the pipeline detects
that rewind (`STT_CLOCK_REWIND_TOLERANCE_MS = 2000`) and maintains
`sttClockOffsetMs` so every comparison stays on the call-long timeline. Without
it, barge-in silently dies for the rest of the call. Covered by
`test:stt-clock`.

---
<div class="page-break"></div>

## 8. LLM layer

### 8.1 Providers

| | OpenAI (`gpt-5.1`) | Gemma (`gemma-4`) |
|---|---|---|
| File | `src/providers/language-model/openai-gpt.provider.ts` | `src/providers/language-model/gemma.provider.ts` |
| SDK | `openai ^7.3.0` | `@google/generative-ai ^0.24.1` |
| Model env | `OPENAI_MODEL`, defaults to the provider id `gpt-5.1` | `GEMMA_MODEL`, default `gemma-4-31b-it` |
| Streaming | `chat.completions.create({ stream: true })` | `generateContentStream` |
| Extra params | `verbosity: "low"`, `stream_options: { include_usage: true }` | `systemInstruction` used directly |
| System prompt | native `system` role | `systemInstruction` channel |
| Special handling | none | **filters `thought` parts** — the SDK version predates the `thought` field, so `chunk.text()` would emit the model's reasoning trace to the caller; `answerPartsOf()` strips it. Thinking cannot be disabled for this model family (API rejects `thinkingBudget` and `thinkingLevel` with HTTP 400). |
| Usage telemetry | real `prompt_tokens`, `cached_tokens`, `completion_tokens`, `reasoning_tokens` forwarded on the `final` event | — |

The campaign path pins the LLM: `call-runner.ts` builds the session request
with `languageModel: { id: "gpt-5.1" }` regardless of campaign config. Gemma is
selectable from the dashboard.

### 8.2 How the model knows which user turn it is answering

Three mechanisms, all in `buildRequestHistory()`
(`conversation-pipeline.ts:3996`) and `system-prompt.ts`:

1. **A windowed history.** `ConversationMemory.recentHistory(20)` returns the
   system turn plus the last **20 user/assistant pairs** (40 entries). The
   window was raised from 6 pairs because at 6 the opening turn — carrying the
   introduction and the first script block — fell out of history after six
   exchanges, and the model then re-introduced itself and re-opened the pitch.
2. **`CURRENT_TURN_NOTE`**, prepended to the **latest user turn only**:
   *"the line below is the caller's current completed turn. Answer this.
   Anything above it is background only…"* This exists because history carries
   no "this one is now" signal, and an interrupted reply is never committed —
   so the model regularly receives **two `user` turns in a row with no
   assistant turn between them**. On Gemma those are merged into one message
   with several parts, and whichever fragment reads as the stronger prompt
   wins. That is exactly how a reply ends up continuing the previous topic.
3. **`languageHintFor(detectedLanguage)`**, prepended alongside it — a
   per-turn bracketed internal note so a language switch takes effect on the
   very next reply. The system prompt's `# PER-TURN INTERNAL NOTES` section is
   what tells the model these bracketed notes are internal and must never be
   spoken.

The final shape of the latest user message is:

```
{CURRENT_TURN_NOTE}
{language hint}
{the caller's actual words}
```

### 8.3 Streaming, sentence chunking and TTFT

- `runStreamingCompletion()` consumes token deltas, feeds `SentenceChunker`,
  and calls `synthesizeAndPlay()` on each completed sentence — so TTS for
  sentence 1 overlaps generation of sentence 2.
- `llmMs` is **time to first token**, measured request-open → first token.
- `llmGenerationMs` subtracts `ttsBlockedDuringStreamMs`, because the
  provider's generator is suspended at its `yield` while TTS runs, and its own
  `latencyMs` would silently include that.
- **Contamination guard:** `isContaminatedOutput()` checks the *accumulated*
  text (a leak's markers are often split across sentences) and stops speaking
  the rest of the turn the moment two markers appear.

### 8.4 Two TTFT optimisations that are currently live

**`primeLlmPrefixCache()`** — started while the greeting plays, never awaited.
It opens a stream with **only the system turn** and breaks after the first
event, so the provider's prefix cache is warm before the first real request.
Measured effect: cold prefill occurs in **4 of 778 turns (0.5%)**.

**Speculative LLM pre-open (`SpeculativeCompletion`, "FIX #8")** — the LLM
request for a turn is opened the instant the detector arms its **evidenced**
confirmation window, so provider TTFT overlaps that hold instead of following
it.

| Property | Behaviour |
|---|---|
| Trigger | `AdaptiveTurnDetector.onTurnPending` — fires **only** when `speech_final` was explicit on the words, no interim is outstanding, and the text reads as finished |
| Request built from | `ConversationMemory.previewRecentHistory(pendingText)` + the same `buildRequestHistory()` annotation — identical role-for-role and content-for-content to the real one |
| Declines to start when | not idle in LISTENING awaiting a turn; voicemail; **an attention episode is open**; **a script remainder is held**; the text is a hearing check; no streaming provider |
| Abandoned by | any further caller speech reaching the detector, voicemail, an attention-check turn, loop end, or **any mismatch at adoption** |
| Adoption | re-derives the normal request and compares; on any difference the pre-opened stream is aborted and the normal request is sent exactly as before |
| Turn release | **unchanged** — still `onTurnEnd` |
| Memory | nothing is committed early |

> The attention/continuity suites assert that a resume spends **zero** LLM
> requests. The `attentionEpisodeOpen` / `heldScriptRemainder` guards in
> `startSpeculation()` are what make that true. Do not remove them.

---
<div class="page-break"></div>

## 9. TTS and voice-provider layer

### 9.1 The provider contract

`src/interfaces/providers/text-to-speech-provider.interface.ts`

| Member | Required | Purpose |
|---|---|---|
| `descriptor` | yes | category, id, display name, supported languages, version |
| `synthesize(task)` | yes | whole-utterance synthesis → `AudioPayload` |
| `synthesizeStream(task, signal?)` | **optional, additive** | yields `TtsAudioChunk`s; `signal` abort must stop emission promptly — this is the barge-in mechanism |
| `prepareSession(sessionId, signal?)` | **optional, additive** | a pure network hint: open the transport now. Must not synthesize, must not send application data, must never throw, must never be required for correctness |
| `disposeSession(sessionId)` | **optional, additive** | release whatever `prepareSession` opened; idempotent |
| `checkHealth()` | yes | reachability + auth |

Streaming was added as **optional members only** (decision D-02) precisely so
that adding it did not invalidate the eight existing concrete providers. The
pipeline feature-detects at runtime.

### 9.2 The four implemented TTS providers

| | ElevenLabs | Cartesia | Sarvam AI | Smallest AI |
|---|---|---|---|---|
| **File** | `elevenlabs.provider.ts` | `cartesia.provider.ts` | `sarvam.provider.ts` | `smallest-ai.provider.ts` |
| **Integration** | official SDK `@elevenlabs/elevenlabs-js ^2.60.0` | official SDK `@cartesia/cartesia-js ^3.5.1` | **direct `fetch` + `ws`** (no official Node SDK) | **direct `fetch`** (no official Node SDK) |
| **Model (default)** | `eleven_flash_v2_5` (`ELEVENLABS_MODEL_ID`) | `sonic-3.5` (`CARTESIA_MODEL_ID`) | `bulbul:v2` (`SARVAM_TTS_MODEL`) | Lightning / `lightning-v3.1` stream |
| **Descriptor `version`** | `v2` | `sonic-3.5` | `bulbul-v3` | `lightning-v3.1` |
| **Batch path** | SDK `textToSpeech.convert`, raw PCM (no container) | `client.tts.generate` "bytes", raw PCM | REST `POST {SARVAM_BASE_URL}/text-to-speech` → base64 **WAV** per input | REST `POST {SMALLEST_AI_BASE_URL}/waves/v1/tts` → **WAV** bytes |
| **Streaming path** | SDK `textToSpeech.stream` | **SSE** — `client.tts.generateSSE` | **WebSocket** — `new WebSocket(streamUrl())` | **SSE** — `POST {SMALLEST_AI_STREAM_BASE_URL}/api/v1/lightning-v3.1/stream`, a *different host* from the batch path |
| **`prepareSession`** | no | no | **yes** — pre-opens the WebSocket | no |
| **Default sample rate** | `8000` (`ELEVENLABS_SAMPLE_RATE_HZ`) | `16000` (`CARTESIA_SAMPLE_RATE_HZ`) | `22050` (`SARVAM_SAMPLE_RATE_HZ`) | `24000` (`SMALLEST_AI_SAMPLE_RATE_HZ`) |
| **In the campaign comparison?** | **No** — deliberately out of scope | **Yes** | **Yes** | **Yes** |

`CAMPAIGN_TTS_PROVIDERS = ["cartesia", "sarvam", "smallest-ai"]`
(`src/campaign/domain/campaign-types.ts`). ElevenLabs remains registered and
selectable from the dashboard.

### 9.3 Provider-specific characteristics recorded in code

**ElevenLabs.** `eleven_flash_v2_5` was chosen from measurement on this
account, same voice, same text, same `pcm_8000` output — time to first audio
byte: `eleven_multilingual_v2` **1467 ms**, `eleven_turbo_v2_5` **445 ms**,
`eleven_flash_v2_5` **412 ms**. It defaults to `pcm_8000` so ElevenLabs does
the band-limiting and resampling server-side and the local resampler is
bypassed entirely.

**Cartesia.** The batch `generate()` endpoint **cannot return a byte until the
whole clip is rendered**, so its time-to-first-audio grows with the text
(~5.9 ms per character). The SSE endpoint is flat at ~160–230 ms, which is why
`synthesizeStream` exists and is preferred. Cartesia's language union has no
distinct Hinglish tag, so `hi-en` maps to `hi`.

**Sarvam AI.** WebSocket TTS with **no end-of-stream marker** — the adapter has
to decide when the utterance is finished from an idle gap. That budget is
adaptive, derived from the request's own observed frame cadence, bounded by
`SARVAM_STREAM_IDLE_GAP_MS` (700 ms ceiling) with a 300 ms floor. The reason is
recorded in the file: Sarvam's frames are quantised multiples of 2,200 bytes
(2200 B = 138 ms, 4400 B = 275 ms, 6600 B = 413 ms, 8800 B = 550 ms of 8 kHz
PCM_16) and which multiple you get varies run to run on identical text, so a
fixed floor alone truncated sentences. `prepareSession` pre-opens the socket so
the handshake does not land on the caller's clock.

**Smallest AI.** `synthesize()` ends in `arrayBuffer()`, so it cannot yield a
byte until the last byte of the body lands; the SSE endpoint replaced it for
that reason. Its stream host is **different from its batch host** — the batch
host answers HTTP 404 for the stream path, which is why `baseUrl` and
`streamBaseUrl` are separate config fields. It also has a vendor-baked
**edge-silence trimmer** (`EdgeSilenceTrimmer`) because measured leading and
trailing silence between sentence chunks was audible as a gap.

### 9.4 Role in benchmarking

- `contact.assigned_provider` is set **once at import** by
  `provider-allocator.ts` (largest-remainder apportionment, SHA-256-ordered for
  reproducibility, interleaved so one lane does not run only in the morning)
  and is **immutable in the database** (`contacts_provider_immutable` trigger).
- The dispatcher runs one lane per TTS provider, **concurrently and
  interleaved**, so time-of-day answer rates cannot be attributed to a vendor.
- A retry is always on the **same** provider — enforced at three layers: the
  immutable column, the claim query filter, and the
  `call_attempts_provider_guard` trigger.
- Per-call latency and cost land in `call_metrics`, tagged with `provider`.

### 9.5 Pricing

Cost **rates** exist in `src/core/session/cost-estimator.ts` (see §18).
Anything not in that file is **not defined in repository**.

---
<div class="page-break"></div>

## 10. Turn detection and the conversation pipeline

**File:** `src/core/session/turn-detection.ts` (`AdaptiveTurnDetector`)

The platform's `TranscriptSegment` exposes per-segment timing and flags — there
is no raw VAD signal at this layer. The detector therefore works on the gap
between successive transcript segments, plus *what* was said.

### 10.1 Adaptive silence window

| Constant | Value | Meaning |
|---|---|---|
| `DEFAULT_SILENCE_TIMEOUT_MS` | 1100 | starting threshold |
| `MIN_SILENCE_TIMEOUT_MS` | 700 | floor — shortest pause still plausibly an end of turn |
| `MAX_SILENCE_TIMEOUT_MS` | 1600 | ceiling |
| `ADAPTATION_RATE` | 0.25 | how strongly one observed gap nudges the estimate **down** |
| `MIN_OBSERVABLE_PAUSE_MS` | 300 | gaps below this are chunk boundaries, not pauses — feeding them to `adaptTimeout` dragged the threshold to its floor mid-sentence |
| `PAUSE_SAFETY_MARGIN_MS` | 250 | head-room above the caller's observed pause length |

### 10.2 Content-aware holds

| Constant | Value | Applies to |
|---|---|---|
| `CONTINUATION_GRACE_MS` | 800 | text ending on a dangling conjunction / particle / preposition |
| `MAX_CONTINUATION_GRACES` | 2 | bound, so trailing off on "and…" still gets a reply |
| `HOLD_GRACE_MS` | 1200 | "one second", "ek minute" — an explicit request for a moment |
| `CHUNK_BOUNDARY_GRACE_MS` | 700 | a final Deepgram did **not** endpoint |
| `MAX_CHUNK_BOUNDARY_GRACES` | 1 | caps added latency when `speech_final` never comes |
| `MAX_INTERIM_CONFIRMATIONS` | 2 | bounded re-waits while Deepgram owes a final |

`HARD_CONTINUATION_WORDS` are checked **ahead of** terminal punctuation,
because Deepgram (with `punctuate` + `smart_format`) routinely closes a
mid-thought chunk with a full stop. `SOFT_CONTINUATION_WORDS` defer to
punctuation. Both sets deliberately **exclude** words that legitimately end an
Indian-English or Hinglish utterance (`hai`, `hain`, `theek hai`, `haan`,
`nahi`).

### 10.3 Two-stage finalisation

The silence window expiring is *evidence*, not proof — transcripts trail the
audio, so the caller may already have resumed. The turn is therefore held for a
**confirmation window** before release, and any segment arriving in that
window (interim or final) cancels it and returns to plain listening.

| Path | Window | Condition |
|---|---|---|
| **Inference** (no fresh endpoint claim) | `CONFIRMATION_WINDOW_MS` = 300 | default |
| Inference, unpunctuated | `OPEN_ENDED_CONFIRMATION_WINDOW_MS` = 550 | likelier mid-thought pause |
| Inference, short + punctuated | 0 | ≤ `SHORT_COMPLETE_TURN_MAX_WORDS` (4), or ≤ `SHORT_QUESTION_MAX_WORDS` (8) if explicitly a question |
| **Evidenced**, short | `EVIDENCED_CONFIRMATION_SHORT_MS` = **150** | `lastFinalWasEndpoint` **and** no pending interim **and** `isReleasableThought()` |
| **Evidenced**, long | `EVIDENCED_CONFIRMATION_LONG_MS` = **250** | as above |
| **Evidenced**, unpunctuated | `EVIDENCED_CONFIRMATION_OPEN_MS` = **300** | as above; punctuation's absence is not counter-evidence |

`isReleasableThought()` is the gate: non-empty, not `FILLER_ONLY`, not
`HOLD_PHRASE_ONLY`, and not `looksIncomplete()`. It replaced an older
`isCompleteThought()` that required terminal punctuation — which, because
Deepgram in `multi` mode routinely declines to punctuate Hinglish finals, threw
the endpoint claim away on the **common** real-call shape and fell back to the
full 1,100–1,600 ms silence window plus 550 ms confirmation.

### 10.4 Ownership of the released turn

- `emitTurnEnd()` calls `reset()` — clearing `pendingFinalText` — **before**
  dispatching to listeners.
- If `listeners.size === 0` the event is **buffered** in `pendingEvent` and
  merged with any later turn (joined by a space) rather than lost.
- `hasBufferedTurn()`, `bufferedTurnText()` and `getPendingTurnText()` are
  **read-only** accessors. Several pipeline call sites poll them; none of them
  subscribes, because an extra `onTurnEnd` subscriber would consume the event
  and the main loop would never see it.

### 10.5 The pipeline's own state

`ConversationPipeline` holds a large amount of per-call state. The fields that
matter most when reasoning about a change:

| Field | Meaning |
|---|---|
| `inboundStreamMs` | monotonic ms of audio handed to STT, for the **whole call** |
| `sttClockOffsetMs` / `sttClockHighWaterMs` | re-base for Deepgram's per-connection word clock |
| `speakingStartedAtStreamMs` | snapshot of `inboundStreamMs` at each entry to SPEAKING |
| `lastTurnReleasedAtStreamMs` | the same clock at the last turn release — separates "sentence tail" from "spoke into the thinking gap" |
| `greetingDone` | gates every barge-in path until the fixed opening line has finished |
| `backchannelInFlight` | true from a bare-acknowledgement interim until its final |
| `currentResponseId` / `cancelledResponseId` | which reply is in flight and whether it was cancelled |
| `cancelledHeardText` | frozen at the instant playback stopped — what the caller actually heard |
| `heldScriptRemainder` / `heldScriptFull` | the unheard tail, and the whole cut-off reply, held for resume/repeat |
| `attentionEpisodeOpen` / `hearingEpisodeBeforeBlock` | hearing-check episode state |
| `contextualReplyCommitted` | has any script content actually been heard yet |
| `outboundQueuedMs` / `outboundPlaybackStartedAt` / `spokenUtterances` | real-time playback accounting |
| `replyFullyQueued` | true from the moment `drainPlayback` is entered |
| `speculation` | the pre-opened LLM request, if any |
| `awaitingTurn` | the main loop is idle in LISTENING awaiting a turn |

---
<div class="page-break"></div>

## 11. Barge-in and interruption handling

Barge-in is the single most-hardened area of this codebase. A transcript
arriving while the assistant speaks is **not**, on its own, evidence the caller
is interrupting: Deepgram is handed one mixed mono telephony channel and
transcribes everything on it — a television, a second person across the room, a
shop counter, and the echo of our own audio out of the caller's earpiece.

### 11.1 The filter chain, in order

Applied in `startContinuousStt()` for every segment. Order is deliberate.

```
segment arrives
  |
  1. stamp lastSttEvidenceAt          (liveness for the bridges' fallback)
  2. end-of-speech marker?  -> noteEndOfSpeech(), continue     [never feeds `feed`]
  3. display preview (liveUserTranscript)
  4. checkForVoicemail()
  5. sttStreamMsOf()                  (re-base the word clock)
  6. metrics: lastFinalSegmentAtMs / lastFinalSttLagMs
  7. spokeOverTheAssistant = greetingDone
                             && state === SPEAKING
                             && segmentEndedAtStreamMs > speakingStartedAtStreamMs
  |
  8. if spokeOverTheAssistant && isBackchannel(segment)
        -> IGNORED. no barge-in, NOT fed to the detector.
  9. if spokeOverTheAssistant && !interruptionCorroborated(segment)
        -> IGNORED. no barge-in, NOT fed to the detector.
 10. if isSelfEcho(segment)           [NOT gated on SPEAKING]
        -> IGNORED. no barge-in, NOT fed to the detector.
 11. if spokeOverTheAssistant -> triggerExternalBargeIn()
 12. endpoint-evidence telemetry
 13. abandonSpeculation("caller resumed speaking")
 14. turnDetector.feed(segment)
```

Steps 8–10 are the three ways a transcript can be *silently dropped*. Each
clears `liveUserTranscript` so a stale preview does not appear as a trailing
user turn (which would block the final-answer hangup check, since that requires
the assistant to have spoken last).

### 11.2 `interruptionCorroborated()`

| Check | Constant | Rule |
|---|---|---|
| Energy corroboration | `BARGE_IN_ENERGY_WINDOW_MS = 2000` | requires loud near-end energy from the transport within 2 s. `lastCallerEnergyAt === 0` means "this transport never reports energy" (in-process fallback, test harnesses) and keeps the pure-transcript behaviour |
| Confidence floor | `BARGE_IN_MIN_CONFIDENCE = 0.4` | applied **only** when the provider reported a non-zero confidence — `0` means "not reported", never "no confidence" |
| Sentence-tail rejection | — | a segment whose **first** word predates `speakingStartedAtStreamMs` did not interrupt us; **we started over them** |
| Thinking-gap exception | `lastTurnReleasedAtStreamMs` | …**unless** the utterance began *after* the last turn release. Then the caller spoke into the THINKING dead air (measured 1.4–3.6 s on live calls) and the reply landed on top of them — they had the floor first, so it **does** corroborate. Logged as `caller began speaking BEFORE the reply did`. |

The last row is the "barge-in thinking-gap fix": without it, a live-call
utterance ("I just said can you please speak to me in हिंदी?", confidence 0.99,
loud energy 2 ms fresh) was rejected twice and **erased whole** — every segment
dropped and never fed to the turn detector.

### 11.3 Backchannel — `isBackchannel()`

Judged on the **whole pending utterance** (the finals the detector already
holds, plus this segment), so a turn that started with real content is never
mistaken for an acknowledgement.

Returns true when:

- the utterance is a **bare greeting** and **no frame has played yet**
  (`outboundPlaybackStartedAt === 0`) — cancelling here commits nothing to
  memory (`heardSoFarText()` is empty), so the next request regenerates the
  identical line, once per "hello?"; **or**
- `isBareAcknowledgement(utterance)` **and** one of:
  - `backchannelInFlight` (the same utterance already judged backchannel), or
  - **`!replyFullyQueued`** — the reply is still being generated and handed
    over sentence by sentence, so more speech is certainly to come, or
  - `remainingSpeechMs() > BACKCHANNEL_MIN_REMAINING_SPEECH_MS` (4,000 ms).

> **Why `!replyFullyQueued` is load-bearing.** The Plivo bridge bounds its
> outbound buffer at a 2.8 s high-water mark, so during a long block
> `remainingSpeechMs()` sat at 2.2–2.8 s and **never crossed the 4 s
> threshold** — every mid-block "haan ji" / "okay" became a barge-in that
> restarted the block. The 4 s rule still decides the *end* of the block, once
> everything has been queued, so an answer to the closing question is heard
> exactly as before.

The 4,000 ms threshold is set from the approved script, not from taste: the
commitment question is the second-to-last line of its block, followed by ~2 s
of speech, so a caller answering it has at most ~2 s of reply left. 4,000 ms is
double that, so **an answer at the gate is never absorbed as backchannel**.

### 11.4 Self-echo — `isSelfEcho()`

On the live Vobiz leg the caller's handset feeds our own outbound audio back up
the **inbound** track. Confirmed empirically, not assumed: a whole call tallied
`INBOUND (caller)=7116, distinctTrackValues=1` — there is no outbound or mixed
track to filter.

The existing three gates cannot catch it: the RMS gate cannot (speakerphone
echo is genuinely loud), `isBackchannel` cannot (the text is not an
acknowledgement), and `interruptionCorroborated` is never even asked, because
the echo's final lands 0.4–1.7 s after the words, by which time `drainPlayback`
has left SPEAKING.

| Constant | Value | Why |
|---|---|---|
| `SELF_ECHO_MIN_WORDS` | 4 | keeps every short caller utterance ("wait", "stop", "hello", "yes", "no", "haan ji") categorically unsuppressible |
| `SELF_ECHO_MIN_BIGRAM_OVERLAP` | 0.7 | word **pairs**, not unigrams — bigrams require word *order* to agree, which an echo has and a genuine answer does not |
| `SELF_ECHO_MIN_MATCHED_BIGRAMS` | 3 | absolute floor, so a short segment cannot clear the ratio on a coincidence |

The comparison is against **`heardSoFarText()`** — the assistant audio the
caller has *actually heard*, never what is still queued. You cannot echo what
has not reached you. That is also why `isSelfEcho` needs no state gate: the
bound is playback itself, and `beginAssistantResponse()` clears
`spokenUtterances` at the next reply.

It deliberately survives its own thresholds: a two-word echo ("Nice. Thanks."
for "Nice, thanks.") is **not** suppressed, because nothing distinguishes it
from a real two-word caller turn. A missed echo costs one confused exchange; a
suppressed caller turn loses their words entirely.

### 11.5 `triggerExternalBargeIn()` — the one accept/decline point

Returns `boolean` so a transport knows whether to clear its own playback buffer.

**Declines when:**

1. `!greetingDone` — the fixed opening line is not interruptible. The
   transports' energy VAD used to reach this method without that gate, so a
   "hello" on pickup truncated the opening line ~120 ms in, and saying "hello"
   again cancelled the next reply too — the call could livelock there.
2. `state === SPEAKING && backchannelInFlight` — a recognised backchannel is
   not an interruption from the energy path either.

**On accept:**

1. `cancelledResponseId = currentResponseId` — recorded **first**, so a chunk
   or `final` event arriving after this handler cannot commit the reply.
2. `cancelledHeardText = heardSoFarText()` — **frozen here**, the last instant
   at which "how much has played" is still a true statement.
3. `bargeIn.triggerBargeIn()` — aborts the in-flight LLM and TTS signals.
4. `SPEAKING -> LISTENING` with reason `"external barge-in signal"` (the string
   the bridges match on to send `clearAudio`).

### 11.6 Buffered-turn drain interruption

`drainPlayback(signal, interruptibleByBufferedTurn)` — passed `true` from
**exactly the two generated-reply drains**, and `false` (the historical
behaviour) from every fixed-utterance drain.

With it `true`, the same remaining span is slept in
`BUFFERED_TURN_DRAIN_POLL_MS` (250 ms) steps, and on each step:

- read `turnDetector.bufferedTurnText()` (read-only, never subscribe);
- cut the reply short via the **existing** `triggerExternalBargeIn()` if the
  waiting turn either `bufferedTurnTakesTheFloor()` **or**
  `bufferedTurnDemandsAttention()`;
- a declined barge-in means "keep draining" and is retried next tick.

`bufferedTurnTakesTheFloor()` is strictly more conservative than the
whole-utterance predicates it wraps: it returns false if the text takes no
floor as a whole, **or** if it can be split at one word boundary into two
halves that each take no floor. That second clause exists because
`emitTurnEnd` **merges** buffered turns — so "Umm" and "Hello? Are you there?"
arrive as the single string `"Umm Hello? Are you there?"`, which no
whole-utterance predicate recognises. Bounded by
`MAX_BUFFERED_TURN_SPLIT_WORDS = 16`.

### 11.7 Stranded barge-in resume

A barge-in can leave nothing behind to reply to — a cough, a door, a half-word,
a hesitation sound (`FILLER_ONLY` is dropped by design), a transcript Deepgram
never finalised. The session then sits in LISTENING with the assistant
mid-sentence and no reply on the way.

`resumeAfterStrandedBargeIn()` speaks the part of the reply the caller never
heard — `unspokenTail(fullText, heardText)` — with **no LLM round trip**, so it
continues the script rather than restarting it.

| Constant | Value |
|---|---|
| `STRANDED_RESUME_QUIET_MS` | 700 — silence that says the barge-in produced no turn |
| `STRANDED_RESUME_MAX_WAIT_MS` | 2,500 |
| `STRANDED_RESUME_POLL_MS` | 100 |
| `MAX_STRANDED_RESUMES` | 3 per call |

**The guard is the whole design:** any turn material at all (`hasBufferedTurn()`
or non-empty `getPendingTurnText()`) abandons the resume, because a genuine
interruption must be answered by the normal contextual path. If it declines,
the remainder is **held** in `heldScriptRemainder` (and the whole reply in
`heldScriptFull`) rather than spoken — which is what the hearing flow below
resumes from.

---
<div class="page-break"></div>

## 12. Hearing / attention handling

This is recent, heavily-tested behaviour (commits `9daba8e`, `0b32593`,
`a7d20cd`, `4b6876b`). It exists because handing a bare "Hello?" to the
language model — which sees a completed block and a bare greeting — made it
either improvise or **restart the script**. Real transcripts show both: the
greeting spoken twice, the pitch re-pitched, once per "hello".

### 12.1 The vocabulary predicates

All in `conversation-pipeline.ts`, all exported so tests can assert both sides
of each boundary directly.

| Predicate | Matches | Notes |
|---|---|---|
| `isAttentionCheck(text)` | `BARE_GREETING_ONLY` **or** `ATTENTION_PRESENCE_ONLY` | the **whole** utterance must be the check. "Hello? What is this about?" matches nothing here and takes the normal contextual path |
| `isHearingCheck(text)` | `ATTENTION_PRESENCE_ONLY` **and** contains a real greeting or presence phrase | **stricter.** A lone "haan ji" / "ji" / "please" never qualifies — after a block, that is the caller's *answer* and must reach the classifier |
| `isEmphaticHearingCheck(text)` | `isHearingCheck` **and** (an explicit presence phrase, **or** ≥ 2 greeting tokens) | needed because a single "Hi." right after our opening line is the caller **answering the phone**, and the right answer to that is the pitch |
| `isRepeatedGreeting(text)` | `isHearingCheck` **and** ≥ 2 greeting tokens | "Hello? Hello?" in one utterance |
| `isContinueRequest(text)` | contains "continue" / "carry on" / "aage bolo" / "जारी रखो" … | a **contains** test — answers to a yes/no question are routinely prefixed |
| `isRestartRequest(text)` | bare "no"/"nahi" as a **whole** utterance, or "from the beginning" / "couldn't hear" / "दोबारा" … | checked **first**, so "continue from the beginning" restarts |
| `HEARING_CONFIRMATION_ONLY` | "yes" / "haan" / "I can hear you" / "ठीक है" … | read **only** inside an open attention episode |

`ATTENTION_PRESENCE_PHRASES` covers English, transliterated Hinglish and
Devanagari ("can you hear me", "are you there", "sun rahe ho",
"आवाज़ आ रही है", …). `ATTENTION_FILLER` allows greetings, vocatives and
politeness around them without turning the utterance into something else.

> The greeting alternation in `ATTENTION_FILLER` **deliberately duplicates**
> `BARE_GREETING_ONLY` rather than being factored out. `BARE_GREETING_ONLY` is
> read by the backchannel and supersession paths, which this feature had to
> leave byte-identical; a shared table would mean a future edit here silently
> changing those.

### 12.2 The fixed lines

No language-model request is made on any hearing path. Every line is fixed
text, spoken through `speakAttentionUtterance()` → `speakFixedUtterance()`, and
every form survives `toSpokenText()` unchanged so the commit site can compare
what was spoken against what was heard.

| Line | English | Purpose |
|---|---|---|
| `attentionAcknowledgementFor()` | **"Hey, can you hear me okay?"** | the one acknowledgement, **once per episode** |
| `hearingFollowUpFor()` | "I just want to make sure you can hear me. Did you catch what I was saying?" | hands the floor back without restating a word of the script |
| `silenceRecoveryPromptFor(1)` | "Hello, are you there?" | first silence-recovery prompt |
| `silenceRecoveryPromptFor(2)` | "Hello, is anyone there?" | second, then the call is allowed to end |

Hindi (`hi`) and Hinglish (`hi-en`) variants exist for all four. All are
**gender-neutral** — the agent persona's gender is configurable and no fixed
line may assume it.

> The acknowledgement is a **question** on purpose. Over a reply the caller is
> talking across with "Hello? Hello?", the line may have gone bad in either
> direction, and asking turns the next turn into an instruction the pipeline
> can act on **without the model**.

### 12.3 `handleAttentionCheck()` — the decision table

Called from the main loop *after* the user turn is committed and *before*
`runThinkingAndSpeaking()`. Returns `true` if it answered the turn itself.

| Condition | Action |
|---|---|
| Not a check, not a confirmation, not continue/restart | **Episode closed.** `heldScriptRemainder` and `heldScriptFull` cleared — an unheard remainder must never be spoken into a conversation that has moved on. Returns `false`. |
| `wantsRestart` (episode open **and** `heldScriptFull` non-empty) | **Repeat the whole cut-off reply from its first word.** Whatever is cut off again is re-held. |
| `wantsContinue` but nothing left to continue | Episode closed, returns `false` — the contextual path continues with both lines in history |
| Episode open **and** a remainder is held | **Resume from exactly where the reply stopped.** Reached by a second "hello", by a confirmation ("yes", "haan") and by an explicit "continue from where you stopped" |
| `isCheck` **and** episode not open **and** a remainder is held | **Acknowledge once.** `attentionEpisodeOpen` is set **before** the line is spoken, so a second "hello" over the acknowledgement finds the episode already open |
| Episode not open, nothing held | Qualifies if `isHearingCheck` (after a block has been committed) or `isEmphaticHearingCheck` (before any block). Acknowledge once; record `hearingEpisodeBeforeBlock`. Otherwise return `false` — a bare "haan ji" reaches the classifier exactly as today. |
| Episode open before any block, still checking | Acknowledge **again** (a TTS request, never the model — the greeting cannot be re-spoken) |
| Episode open before any block, confirming | Close the episode, return `false` — the contextual path gives them the pitch, which is what they are waiting for |
| Episode open after a block, nothing held | **One follow-up, once.** Episode closes so a further "hello" starts over with the acknowledgement rather than looping. |

### 12.4 The thinking-gap / buffered-turn case

The scenario in the brief is implemented and tested:

```
caller:    "Hello."
             -> released as turn 0
agent:     [long thinking gap, then a long generated block starts playing]
caller:    "Hello?"
             -> spoken into the THINKING gap, so it ENDS before
                speakingStartedAtStreamMs -> spokeOverTheAssistant is FALSE
             -> no barge-in path is consulted
             -> emitTurnEnd fires with listeners.size === 0
             -> the turn lands in pendingEvent, invisible
```

Before the fix, that turn was invisible until the whole block had drained —
measured at **22,026 ms of residual wait** on one production turn.

`drainPlayback`'s poll now sees it. `bufferedTurnDemandsAttention(buffered)`
returns true for two shapes:

- **(a)** `isRepeatedGreeting(buffered)` — "Hello? Hello?" in one utterance;
- **(b)** `isHearingCheck(buffered)` **and** the most recent *user* turn in
  committed history was itself an `isAttentionCheck` — i.e. the turn this reply
  is answering was nothing but a greeting, and now another hearing check is
  waiting.

The reply is cut through `triggerExternalBargeIn()`; the heard prefix is
committed; the tail is held; and the waiting "Hello?" is answered on the next
loop iteration with **"Hey, can you hear me okay?"** — no LLM request.

A **single** buffered "Hello?" after a substantive turn is deliberately **not**
this and lets the block finish.

### 12.5 Silence recovery

Runs **only** while the main loop is idle in LISTENING awaiting a turn
(`waitForTurnDetectorEnd`), which by construction is after `drainPlayback` has
slept out every queued frame. It never aborts, drains, clears or barges into
anything — the timer is armed on subscription and simply lets the wait return
`SILENCE_ELAPSED` instead of a turn.

| Constant | Value |
|---|---|
| `SILENCE_RECOVERY_INTERVAL_MS` | **10,000** |
| `SILENCE_RECOVERY_MAX_PROMPTS` | 2 |

Any transcript text, any energy the transport attributes to the caller, and any
turn material re-arms or cancels it — the same `lastConversationActivityAt`
stamp the campaign watchdog reads. After the second prompt the call is allowed
to end on the existing watchdog.

---
<div class="page-break"></div>

## 13. Conversation state and continuity

### 13.1 `ConversationMemory`

`src/core/session/conversation-memory.ts` — plain in-memory, per session, dies
with the session.

| Member | Behaviour |
|---|---|
| constructor | pushes the leading `system` turn (`buildSystemPrompt`) |
| `recordUserTurn(text, lang)` | appends, **updates the tracked language**, extracts entities (phones, numbers, proper nouns), increments turn count |
| `recordAssistantTurn(text)` | appends; if it looks like a question, remembers a normalised form in `askedQuestions` |
| `hasAskedSimilarQuestion(q)` | normalised (case/punctuation/whitespace-insensitive) repeat check |
| `history()` | full history including the system turn |
| `recentHistory(maxPairs = 20)` | system turn + last 20 user/assistant pairs |
| `previewRecentHistory(pendingText, 20)` | **read-only** — exactly what `recentHistory()` *would* return after recording `pendingText`, without recording anything. Shares the private `window()` with `recentHistory` so the identity holds by construction, which is what makes speculative LLM adoption safe |
| `snapshot()` | for the dashboard |

### 13.2 Turn commitment rules

**User turn:** committed in the main loop immediately after
`acquireNextUserTurn()` returns, before any attention handling or LLM call.
Three exceptions never commit a user turn:

- **voicemail** — the transcript *is* recorded (it is the evidence that labels
  the call `suspected_voicemail`), but no reply is generated;
- **pickup acknowledgement** — a bare "Hello"/"Haan"/"Hi" heard while the
  opening line was still playing. `pickupAckAllowance` grants **at most one
  such drop per call**, and is consumed by that turn whatever it is;
- **backchannel / uncorroborated / self-echo segments** — filtered before they
  ever reach the turn detector, so they never become a turn at all.

**Assistant turn:** committed **after** `drainPlayback()` returns, i.e. after
the audio has really played.

- **Completed reply** → the full text is committed.
- **Interrupted reply** → only `cancelledHeardText` (the heard prefix) is
  committed; the unplayed remainder is discarded from history. Committing the
  whole thing would put a sentence the caller never let us finish between their
  own two utterances and feed it to the next request as a real exchange.
- **Nothing heard** → nothing is committed, which is correct, and is exactly
  why `isBackchannel` refuses to cancel a reply before playback has started.

### 13.3 The unheard remainder

```
result.assistantText     the whole generated reply
cancelledHeardText       the part that PLAYED  (frozen at barge-in)
unspokenTail(full, heard) the part that did NOT
```

`unspokenTail()` walks both strings ignoring whitespace and returns the rest of
`fullText` from where the prefix ends. It returns `""` — resume nothing — the
moment they diverge, because speech formatting is applied both per utterance
and to the whole reply, so the two are not guaranteed to line up; when they do
not, saying nothing is correct and guessing is not.

Flow after a cancelled reply:

```
strandedRemainder = unspokenTail(assistantText, heard)
   |
   +-- resumeAfterStrandedBargeIn() spoke it   -> heldScriptRemainder = ""
   |                                              heldScriptFull      = ""
   |
   +-- declined (caller produced a turn)       -> heldScriptRemainder = remainder
                                                  heldScriptFull      = assistantText
```

The held position is then available to `handleAttentionCheck()` for **resume**
(`heldScriptRemainder`) or **full replay** (`heldScriptFull`), and is cleared
by the first real contribution.

### 13.4 What the model is told about interruptions

Because an interrupted reply is never committed in full, the model regularly
sees consecutive `user` turns with no assistant turn between them. The system
prompt has a dedicated `# INTERRUPTIONS AND BARGE-IN` section explaining that,
rather than leaving the model to guess. `conversation-policy.ts` carries the
"never repeat a line they have already heard" rules — but note that instruction
is **unactionable** when history shows the line was never said, which is
precisely why the heard prefix is committed.

---
<div class="page-break"></div>

## 14. Call recording

**Short answer: recording exists, is Vobiz-only, is entirely server-side at the
carrier, and nothing about it is persisted or retrievable from this
application.**

### 14.1 What exists

| Question | Answer | Evidence |
|---|---|---|
| Are calls recorded? | **Yes, on the Vobiz lane only.** | `VobizTelephonyProvider.startRecording()` |
| Where is it initiated? | `src/app/api/voice/vobiz/answer/route.ts` → `startRecordingInBackground()`, **fire-and-forget** | same file |
| Why there? | Recording needs the **`call_uuid`**, which only exists once the callee answers. `startCall()` returns a `request_uuid` — a *different* identifier. The answer webhook is the first place `call_uuid` is available. | route header comment |
| How? | `POST {VOBIZ_API_BASE_URL}/api/v1/Account/{auth_id}/Call/{call_uuid}/Record/` with `{ file_format: "mp3", time_limit: 900 }` | `vobiz.provider.ts` |
| Format | **MP3** | request body |
| Duration cap | **`VOBIZ_RECORDING_TIME_LIMIT_SECONDS = 900`** (15 min). Vobiz's documented default is 60 s, and omitting the parameter is what caused the reported ~60 s truncation. 900 covers `CAMPAIGN_MAX_CALL_SECONDS` (180) five times over. Recording stops when the call ends. | exported constant + comment |
| Where are recordings stored? | **On Vobiz's side.** Nothing is downloaded, proxied or stored by this application. | no storage code exists |
| Association with a call | Only via `call_uuid`. The response's `recording_id` and `url` are **logged and then discarded** — `[Vobiz] recording started: call_uuid=… recording_id=… url=…` | `startRecording()` |
| Persisted anywhere? | **No.** There is no `recording_id` / `recording_url` column in any migration, no repository method, no API route. | schema + repo search |
| Retrieval / playback path in this app | **None.** Recordings must be retrieved from the Vobiz console/API. | — |
| Transcription association | **Indirect only.** The pipeline's own transcript is stored in `call_outcomes.transcript` and keyed by `call_attempt_id`. `call_attempts.provider_call_id` holds the carrier identifier, so a recording can be correlated **manually** through that. There is no automated link. | `001_init.sql` |
| Plivo lane | **No recording is started at all.** | `plivo/answer/route.ts` |
| Failure behaviour | Fire-and-forget with a `try/catch` — a recording failure can never delay or break the `<Stream>` XML the call depends on. Missing `call_uuid` logs `recording NOT started` and continues. | `startRecordingInBackground()` |

### 14.2 Limitations you should know before working here

1. **No recording metadata is retained.** If you need to find a recording for a
   given attempt, you have `call_attempts.provider_call_id` and the log line —
   nothing else. Adding a `recordings` table or two columns on `call_attempts`
   is the obvious first task if recording work is in scope.
2. **Plivo has no recording path.** If the Plivo lane is ever reactivated,
   recording will silently not happen.
3. **`call_uuid` is spelled inconsistently by Vobiz.** The route accepts
   `CallUUID`, `call_uuid`, `CallUuid`, `calluuid`, from the POST form body or
   the query string.
4. **Recording is not gated by consent or campaign config.** Every answered
   Vobiz call is recorded. **Not confirmed from repository:** any legal /
   consent handling for that.
5. **`test:vobiz-call-control`** covers the `time_limit` parameter and the
   webhook's `call_uuid` extraction — run it before touching this path.

---
<div class="page-break"></div>

## 15. Campaign architecture

### 15.1 Contact and lead handling

```
CSV upload  ->  POST /api/campaigns/{id}/import
                  |
   csv-parser.ts     (csv-parse; CAMPAIGN_CSV_MAX_BYTES / _MAX_ROWS bounds)
   column-mapper.ts  (header -> field mapping)
   phone-normalizer  (libphonenumber-js, CAMPAIGN_DEFAULT_REGION)
   validator.ts      (requiresName from the script; duplicates; invalid numbers)
   provider-allocator.ts  (percentages -> exact, reproducible, interleaved
                           per-contact TTS provider assignment)
                  |
                  v
   contacts row: assigned_provider written ONCE, immutable thereafter
                 every unmapped CSV column preserved verbatim in `metadata`
```

Two guarantees are enforced by **PostgreSQL**, not application code:

- `contacts_one_number_per_campaign` (unique) + `contacts_provider_immutable`
  (trigger) → **one number, one provider, forever**;
- `call_attempts_provider_guard` (trigger) re-reads the contact's assignment on
  every attempt insert/update → **no attempt on the wrong provider**, even from
  a buggy retry planner.

### 15.2 Dispatcher

`src/campaign/dispatch/dispatcher.ts` — **three independent provider lanes over
one campaign**, run concurrently and interleaved.

```
LaneGate.acquire()  ->  globalSemaphore  ->  globalTokenBucket
                    ->  lane Semaphore   ->  lane TokenBucket
```

| Control | Default | Env |
|---|---|---|
| Global max concurrent | **3** (`CARRIER_MAX_CONCURRENT_CALLS`) | `CAMPAIGN_GLOBAL_MAX_CONCURRENCY` |
| Global CPS | 3 | `CAMPAIGN_GLOBAL_CPS` |
| Per-lane max concurrent | **3** | `CAMPAIGN_CONCURRENCY_<PROVIDER>` |
| Per-lane CPS | 1 | `CAMPAIGN_CPS_<PROVIDER>` |
| Ring timeout | 35 s | `CAMPAIGN_RING_TIMEOUT_SECONDS` |
| Max call duration | 180 s | `CAMPAIGN_MAX_CALL_SECONDS` |
| Max silence | 20 s | `CAMPAIGN_MAX_SILENCE_SECONDS` |
| Claim batch size | 5 | `CAMPAIGN_CLAIM_BATCH_SIZE` |
| Poll interval | 1,000 ms | `CAMPAIGN_POLL_INTERVAL_MS` |
| Stage max calls | **10** | `CAMPAIGN_STAGE_MAX_CALLS` |
| Dialing kill switch | **`false`** | `CAMPAIGN_DIALING_ENABLED` |
| Dispatcher lock stale | 90 s | `CAMPAIGN_LOCK_STALE_SECONDS` |

Supporting components: `calling-window-watcher.ts` (time-of-day windows),
`control-watcher.ts` (pause / resume / stop via the `campaign_controls` table),
`load-guardrails.ts` (**refuses** an unsafe run at launch, never clamps it),
`run-launcher.ts`, `session-observer.ts`, `concurrency.ts` (`Semaphore`,
`TokenBucket`, `LaneGate`).

> **The dispatcher MUST run in the same process as the media bridges.** The
> session manager is in-memory on `globalThis`, and the answer webhook and
> audio WebSocket have to land on the process that owns the session. A
> `dispatcher_locks` row enforces one dispatcher per campaign.

### 15.3 Call runner

`src/campaign/dispatch/call-runner.ts` — the **only** module in the campaign
layer that *drives* the voice agent, and only through existing public methods
(`createSession`, `warmUpProviders`, `start`, `end`, `onStateChange`,
`getBenchmarkMetrics`, `getTranscript`, `lastActivityAt`). It does not even
import the manager: it depends on `ManagerLike`, a **structural** interface that
`DefaultVoiceSessionManager` satisfies without being modified or wrapped (the
dispatcher does the same via `DispatchManager`).

> **Precise scope of that claim.** Two other campaign files do import from
> `core/session`, and both imports are deliberate and read-only:
> `outcome/classifier.ts` imports `VOICEMAIL_MARKERS` and
> `isBareAcknowledgement`, and `external-limits.ts` imports the cost-rate
> helpers. Those are the "one table, two readers" couplings described in §11.4,
> §12 and §16.4 — a live gate that disagreed with the label a call is later
> given would be worse than no gate. **No campaign module imports the session
> manager, the pipeline, a media bridge or a provider adapter.**

Order is deliberate:

1. **Attempt row first**, before anything can dial — if the process dies
   immediately after, recovery finds the row rather than a call nobody knows
   about. `call_attempts_contact_attempt_unique` makes a duplicate call
   impossible.
2. **Kill switch** checked before the session is created, so a rehearsal cannot
   reach the telephony provider.
3. **Campaign context** built and validated before dialling — a contact with no
   name fails without ringing anyone. Also verifies the script hash against the
   campaign's pinned `script_hash`.
4. **Every exit path goes through `finalize()`.**

### 15.4 Watchdog — the five ways a call ends

Polled every 500 ms in `runCall`:

| Verdict | Condition |
|---|---|
| `NO_ANSWER` | not answered by `dialStartedAt + ringTimeoutSeconds` |
| `MAX_DURATION` | `now - answeredAt > maxCallSeconds` |
| `MAX_SILENCE` | **only while `sessionState === LISTENING`**, and only when both the transition clock *and* the pipeline's heard-audio stamp are older than `maxSilenceSeconds` |
| `FINAL_ANSWER` | `definitiveAnswerSoFar()` returned `FINAL_YES` / `FINAL_NO` |
| `AGENT_CLOSED` | `agentClosedSoFar()` — the agent said goodbye and the person gave no closable verdict |

> Silence is counted **only in LISTENING** because a caller is *supposed* to be
> silent while the agent is THINKING or SPEAKING. Counting it everywhere hung
> up on people mid-reply. `MAX_DURATION` still bounds a call that never leaves
> THINKING or SPEAKING.

#### The `AGENT_CLOSED` verdict, and the 12-word cap that bounds it

**This is current, verified behaviour at HEAD `5eff685`**, read directly from
`src/campaign/dispatch/call-runner.ts`.

`AGENT_CLOSED` is the one ending that reads what the **agent** said rather than
what the person said. It exists because a conversation that finished without a
verdict the classifier can close a contact on — `unclear`,
`affirmative_not_at_gate`, `callback_requested`, `interested_not_confirmed` — is
a real and common way a call ends, and it was the one ending that left the line
open until the silence window expired (or until the person offered one more
pleasantry, and then the silence window after *that*).

**The relevant function is `agentClosedIn(turns)`**, called through
`agentClosedSoFar()` from the watchdog loop. It introduces **no verdict of its
own and reads no classifier** — it is the hangup condition only. What the call
*meant* is still decided by `classifyOutcome` + `dispositionFor` inside
`finalize`, from the finished transcript, exactly as for every other completed
call. `definitiveAnswerSoFar()` is checked **first** at the single call site, so
a FINAL_YES / FINAL_NO still takes its own path and names its own hangup reason.

It applies **four guards**, all of which must pass:

| # | Guard | Purpose |
|---|---|---|
| 1 | The last turn must be the **agent's** | The pipeline commits an assistant turn only after that reply's audio has **drained** (`drainPlayback`), so this is the moment the closing the person just heard finished playing — never before. It also means the live partial utterance `getTranscript` appends while somebody is still speaking blocks this, so a person who is talking is never hung up on mid-sentence. |
| 2 | The person must have **said something** | A call where only the agent spoke is a machine or a line nobody answered into, and is already handled by the voicemail path and the silence window. |
| 3 | The turn must **end on** a sign-off, not merely contain one | `endsWithClosing()` matches the `AGENT_CLOSINGS` table (English + transliterated Hinglish + Devanagari) and then inspects what follows it. |
| 4 | The turn must **ask nothing** | `asksAQuestion()` — the shared `"?"` test on the raw text. A turn containing a question is a handover point, not an ending, whatever else it contains, and the person is about to answer it. |

**The cap itself:**

```ts
const AGENT_CLOSING_MAX_WORDS = 12;   // call-runner.ts
```

**Where it is enforced.** Inside `agentClosedIn`, *after* guards 1, 2 and 4 and
*before* the sign-off test. The turn's normalised text is word-counted, and a
turn of `0` words or **more than 12** words is rejected outright:

```
wordCount === 0  ||  wordCount > AGENT_CLOSING_MAX_WORDS   ->   not a closing
```

**Why it matters.** A sign-off turn is short. The approved script's blocks and
the agent's answers to questions run well past this — **measured at 213–286
characters, roughly 35–50 words, on the v2/v3 prompt stack**. The cap is what
keeps a long turn that merely *contains* a closing phrase from being read as a
closing and hanging up on a live conversation. It is what separates:

```
"Take care, Sakshi."                                            ->  AGENT_CLOSED
"Just take care to join a few minutes early, the link will
 be on WhatsApp."                                               ->  NOT a closing
```

Both contain "take care". Only the first is a sign-off. Guard 3 catches the
phrase position; the 12-word cap is the independent second filter that stops a
closing phrase used as an **ordinary verb inside a longer reply** from ever
reaching the sign-off test at all.

**The companion constants** — also current, in the same file:

| Constant | Value | Role |
|---|---|---|
| `AGENT_CLOSING_MAX_WORDS` | **12** | Whole-turn length cap (above) |
| `AGENT_CLOSING_MAX_TRAILING_WORDS` | **2** | How many words may follow the sign-off phrase and still leave the turn a sign-off |
| `CLOSING_CONTINUATION_WORDS` | a `Set` of conjunctions, prepositions, articles, determiners and pronouns | Any of these in the tail disqualifies the turn |

The trailing-word allowance exists because guard 3 was originally a strict
`endsWith`, and production showed that is not how the agent actually says
goodbye. This script is name-driven (`{{customer_name}}`, `requiresName: true`)
and the closing is the most natural place in a call to use the person's name, so
the real ending was `"Take care, Sakshi."` — which does not *end* on the phrase.
No closing was ever detected, no `AGENT_CLOSED` verdict was produced, the line
was held open until the silence window, and by then the person had already hung
up and Vobiz answered `endCall` with a 404. Two words covers a trailing vocative
("sakshi", "sakshi ji", "sir", "ma'am") plus the occasional trailing adverb
("ahead", "now"), and is deliberately **not** enough for a clause — which is
what `CLOSING_CONTINUATION_WORDS` enforces: a vocative or adverb ends a
sentence, but a preposition, conjunction, article, pronoun or auxiliary carries
it on.

> **Do not raise `AGENT_CLOSING_MAX_WORDS` to make a missed closing fire.** The
> cap and the trailing-word rule are two independent filters on the same false
> positive, and the failure they prevent — hanging up mid-conversation because a
> long reply happened to contain "take care" or "thanks for your time" — is
> silent and unrecoverable from the caller's side. `test:agent-hangup` is the
> suite that owns this behaviour (see §19.3 for its last recorded result).

### 15.5 Retry behaviour

`src/campaign/dispatch/retry-planner.ts`. **A customer decision outranks
arithmetic.**

- `isDefinitive(disposition)` (`FINAL_YES` / `FINAL_NO`) → **never retried**,
  even with attempts left.
- `RETRYABLE` → retried within budget with a per-reason delay.
- `UNRESOLVED` for a **registration** campaign → retried by default
  (`CAMPAIGN_RETRY_ON_UNRESOLVED_REGISTRATION=true`), because "we never found
  out" is a reason to call back, not a result.
- A retry is **always on the same provider** — three independent layers refuse
  otherwise.
- When no classification is available the planner behaves exactly as it did
  pre-Phase-7: a classifier fault must not change who gets dialled.

| Retry knob | Default |
|---|---|
| `CAMPAIGN_RETRY_MAX_ATTEMPTS` | 3 |
| `CAMPAIGN_RETRY_REGISTRATION_MAX_ATTEMPTS` | falls back to the above |
| `CAMPAIGN_RETRY_NO_ANSWER_DELAY_MINUTES` | 30 |
| `CAMPAIGN_RETRY_BUSY_DELAY_MINUTES` | 10 |
| `CAMPAIGN_RETRY_CALLBACK_DELAY_MINUTES` | 30 |
| `CAMPAIGN_RETRY_UNRESOLVED_DELAY_MINUTES` | 30 |
| `CAMPAIGN_RETRY_TEMPORARY_BACKOFF_MINUTES` | `1,4,16` |
| `CAMPAIGN_RETRY_ON_REJECTED` | `false` |
| `CAMPAIGN_RETRY_ON_USER_HANGUP` | `false` |

### 15.6 Scripts

`src/campaign/script/` — one registry, seven registered scripts:
`registration.v1`, `registration.v1-short`, `registration.v2`,
`registration.v3`, `registration.v4`, `reminder.v1`, `reminder.v2`.

A `CampaignScript` is `{ id, version, campaignType, label,
systemPromptAppendix, openingLineTemplate, requiresName, isPlaceholder }`. The
appendix is appended **after** the master system prompt, never in place of it —
every conversational rule the agent already follows stays in force.

`hashScript()` (SHA-256 over `id + version + systemPromptAppendix +
openingLineTemplate`) pins the exact words. A campaign record stores the hash,
so editing a live script's wording makes the running campaign's snapshot
**detectably stale** rather than silently drifting (decision D-07). Scripts are
validated at module load: a script asking for a variable the layer cannot
supply fails immediately.

### 15.7 Persistence

| Table | Holds |
|---|---|
| `campaigns` | script id/version/**hash**, provider allocation percentages, telephony provider, language, snapshotted `dispatch_config`, `pilot_stage`, idempotency key |
| `contacts` | phone (normalized + original), name, `metadata` (every extra CSV column), **`assigned_provider`** (immutable), status, attempt count, `next_attempt_after`, claim fields, final disposition (migration 003) |
| `call_attempts` | attempt number, provider, telephony provider, `session_id`, `provider_call_id`, status, **`status_source`** (`observed` / `inferred` / `carrier`), timing, `hangup_reason`, `failure_reason`, `failure_class` |
| `call_outcomes` | `outcome_type`, `succeeded`, `primary_reason`, `detail` (jsonb, GIN-indexed), classifier id, schema version, **stored `transcript`** |
| `call_metrics` | turn count, conversation seconds, p50 STT/LLM/TTS/total, first-turn total, per-category cost, **`raw` jsonb** (includes `turnLatencies`) |
| `dispatch_metrics` | queue wait, claim-to-dial, dial request, ring-to-answer, persist time |
| `campaign_controls` | `RUN` / `PAUSE` / `STOP` (migration 002) |
| `campaign_events` | structured event log |
| `dispatcher_locks` | one dispatcher per campaign |
| `webhook_events` | raw carrier webhooks |
| `sheet_sync` | idempotency for the Google Sheet mirror (migration 004) |

**Metric separation is structural:** `call_metrics` holds voice-conversation
measurements, `dispatch_metrics` holds orchestration measurements, in separate
tables so no query can average a database write latency into a TTS latency.

### 15.8 Google Sheet integration

`final-yes-sheet.ts` + `google-sheets.client.ts` + `sheet-sync.repo.ts`.

- Runs **last** in `finalize()`, after the outcome is persisted and the contact
  moved — the sheet is a downstream copy of a decision that is final either
  way.
- **Never throws, never returns a rejected promise.** A missing credential, a
  revoked share, a Google outage or a dead DB connection all end as a log line.
  No sheet problem can reach the retry planner, the disposition, the attempt
  row or the campaign state.
- Idempotent through the `sheet_sync` table: a second sync of the same
  `FINAL_YES` is a primary-key conflict.
- Auth: service-account JWT → OAuth token → `values.append`. Credentials come
  from `GOOGLE_SERVICE_ACCOUNT_JSON` (whole blob) **or** the two flat fields;
  the blob wins when both are set.

### 15.9 Campaign API surface

| Action | Endpoint |
|---|---|
| Create / list | `POST` / `GET /api/campaigns` |
| Get one campaign | `GET /api/campaigns/{id}` — **read-only; there is no update/delete verb on this route** |
| Import contacts | `POST /api/campaigns/{id}/import` |
| Contacts / attempts | `GET /api/campaigns/{id}/contacts`, `/attempts` |
| Preflight | `GET /api/campaigns/{id}/preflight` |
| Production readiness | `GET /api/campaigns/{id}/production-readiness`, `GET /api/production-readiness` |
| Start / pause / resume / stop | `POST /api/campaigns/{id}/{start\|pause\|resume\|stop}` |
| Set ladder rung | `POST /api/campaigns/{id}/stage` — body `{"stage": n}` |
| Progress / results / export | `GET /api/campaigns/{id}/{progress\|results\|export}` |

Voice-lab endpoints: `GET /api/providers`, `POST|GET /api/sessions`,
`GET|DELETE /api/sessions/{id}`, `POST /api/sessions/{id}/start`,
`POST /api/sessions/{id}/warmup`, `GET /api/sessions/{id}/events` (SSE).

---
<div class="page-break"></div>

## 16. Outcome classification

**Files:** `src/campaign/outcome/classifier.ts`,
`conversation-events.ts`, `disposition.ts`, `outcome-types.ts`,
`script-adherence.ts`, `transcript.ts`; plus the live half in
`src/campaign/dispatch/call-runner.ts`.

**Rule-based and deterministic on purpose.** The same transcript produces the
same label on every run, on every machine, with no network call and no model
version drifting underneath a comparison whose whole point is that the only
thing differing between two calls is the TTS provider.

### 16.1 The chain

```
AI question   (assistant turn, matched against COMMIT_ANCHORS)
     |
user answer   (user turn; answerReadability decides if it IS an answer)
     |
classifyOutcome()   -> one of 11 outcome types + every matched phrase,
     |                  with turn index and within-turn offset
dispositionFor()    -> FINAL_YES | FINAL_NO | RETRYABLE | UNRESOLVED
     |                  | TECHNICAL_FAILURE
planRetry()         -> retry vs terminal
     |
finalizeAttempt() + saveClassification() + syncFinalYesToSheet()
```

### 16.2 Precedence

Deliberate, and **not** the order a naive reading would choose:

```
opt-out > wrong number > suspected voicemail > confirmation AT THE GATE
        > callback > refusal > positive-but-not-at-the-gate > unclear
```

Opt-out outranks everything because "take me off your list" said *after* a yes
is still an opt-out — a compliance signal that can be overwritten by an earlier
pleasantry is not a compliance signal.

### 16.3 The gate — `COMMIT_ANCHORS`

A "yes" means nothing without knowing which question it answered. `atGate` is
computed **per user turn** by `answersACommitQuestion()`, which looks
**backward only** — so a yes said *before* the gate can never be attached to it.

```ts
COMMIT_ANCHORS = {
  registration: ["reserve your free seat", "should i reserve", "register you",
                 "registration done", "interested to attend", "like to attend",
                 "want to attend", "count on you to attend", ...],
  reminder:     ["will you attend", "will you be joining", "joining us live",
                 "confirm your attendance", "aap aayenge", "join karenge", ...],
}
```

The look-back walks backwards from the customer turn and stops on:

- an assistant turn **containing an anchor** → `atGate = true`;
- an assistant turn that is **a question** (`isQuestionTurn`) → `false`, the
  person is answering *that*;
- an assistant turn with **content of its own** → `false`, same reason.

Only a **bare acknowledgement** is stepped over, and at most two turns are
checked.

> **⚠ This is the single most fragile coupling in the campaign layer.**
> `COMMIT_ANCHORS` matches the *exact wording of the gate question in the
> script*. Re-wording a script without updating the anchors **silently kills
> FINAL_YES detection** — and with it the Google Sheet row and the auto-hangup
> (decision D-08). The v3 script's re-worded gate is exactly why
> `"interested to attend"` had to be added.

### 16.4 The three recent hardenings (all at HEAD)

**1. Earlier acknowledgements cannot leak into a later gate question.**
Structural, and it always was: `answersACommitQuestion` computes `atGate`
per turn by looking backward only. On the live side, both vocabulary readers
(`isBackchannel`, the pickup-ack drop) and `HEARING_CONFIRMATION_ONLY` inside
an open attention episode either **never record the token** or bind it to a
`?` line that the look-back stops at.

**2. Short substantive assistant statements are no longer skipped by
character length** (`classifier.ts`, commit `5eff685`).

Previously "filler" meant *"under 40 characters"*, which let this through:

```
Agent:    "...should I reserve your free seat?"
Customer: "Is it free?"
Agent:    "Yes, it's completely free."      <- 27 chars, stepped over
Customer: "Okay."                           <- bound to the GATE
          => confirmed_at_gate / FINAL_YES / a Google Sheet row
```

The "okay" acknowledges the answer they just got; it is not a registration, and
a 27-character reply is not a filler. The test is now
`isBareAcknowledgement(turn.text)` — the pipeline's own predicate, imported
read-only from `core/session/turn-detection.ts`, so **one table decides both
sides**. An assistant "Sure." is still stepped over; an assistant sentence never
is.

**3. A live FINAL_YES is not acted on while the agent's latest turn is itself a
question** (`call-runner.ts`, `definitiveAnswerIn`, commit `5eff685`).

If the agent read an "okay" as unclear and **re-asked the gate**, the transcript
ended on an assistant turn, the classifier still bound the okay to the *first*
asking, and the runner hung up while the re-asked question was on the line. Now:

```ts
if (isFinalYes(classification, disposition)) {
  return asksAQuestion(last.content) ? undefined : "FINAL_YES";
}
```

`asksAQuestion()` tests the **raw** text for `"?"` (because `normaliseText`
strips punctuation) and is now a shared helper, so `definitiveAnswerIn` and
`agentClosedIn` cannot disagree about what a question is. The `FINAL_NO` path
is unchanged.

### 16.5 Answer readability

`conversation-events.ts` reports the speech act; the classifier refuses to read
a verdict into anything that was not an answer. A phrase found in a **question**
or an **unfinished sentence** is still recorded on the row for audit but marked
`decisive: false`, and is excluded from every decision rule. A question is
therefore never a yes, never a no, and never a reason to close a contact.

Also filtered before matching:

- `NEGATION_EXCEPTIONS` — "no problem", "koi baat nahi" must not read as a
  refusal;
- `AFFIRMATION_EXCEPTIONS` — "I will see", "not sure", "dekhta hu",
  "soch kar" must not read as a yes. "not sure" was added after a real
  reminder-campaign gate answer *"Maybe, not sure yet."* settled as
  `confirmed_at_gate` and would have written a sheet row.
- A turn containing a **voicemail marker** contributes **no** affirmation at
  all — bare "ok"/"ji" occur inside machine greetings.

### 16.6 The disposition table

| `outcome_type` | Disposition |
|---|---|
| `registered_confirmed` | **FINAL_YES** |
| `attendance_confirmed` | **FINAL_YES** |
| `declined` | **FINAL_NO** |
| `do_not_call` | **FINAL_NO** |
| `wrong_number` | **FINAL_NO** |
| `not_connected` + `INVALID_NUMBER` | **FINAL_NO** |
| `callback_requested` | RETRYABLE |
| `not_connected` (other) | RETRYABLE |
| `not_connected` + `SYSTEM`/`TEMPORARY` | TECHNICAL_FAILURE |
| `no_engagement` | UNRESOLVED |
| `interested_not_confirmed` | UNRESOLVED |
| `acknowledged_not_confirmed` | UNRESOLVED |
| `unclear` | UNRESOLVED |
| *(anything added later without a mapping)* | UNRESOLVED — retryable within budget rather than silently closed or silently counted as a success |

### 16.7 The FINAL_YES sheet gate

`isFinalYes()` is a **conjunction of three existing upstream facts**, not a new
rule:

```ts
disposition === "FINAL_YES"
  && isSuccessOutcome(classification.outcomeType)
  && classification.succeeded === true
  && classification.primaryReason === "confirmed_at_gate"
```

All three are redundant today — `classifier.ts` has exactly one branch that
produces a success outcome and it sets all three together. **That is the
point:** should a future branch ever produce a success outcome for a softer
reason, this stays closed until someone deliberately opens it.

### 16.8 Live vs post-call reading

Both use the **same** `classifyOutcome` + `dispositionFor`. The live reader
(`definitiveAnswerIn`) adds two narrowings, both about never cutting a live call
short:

1. **The last turn must be the agent's.** The pipeline commits an assistant turn
   only after the audio has drained, so this is the moment the confirmation the
   person just heard *finished*. It also means the live partial utterance
   `getTranscript` appends while somebody is still speaking is never read as an
   answer.
2. **A FINAL_NO must be unmistakable.** A bare "no" is a refusal to the
   post-call classifier, but mid-call it is just as often "no, I hadn't heard of
   it" — and a yes at the gate can override an earlier no. So:
   - `opt_out` → final the moment it is said;
   - `explicit_no` → only if the person's own last words match the explicit-
     refusal table;
   - `wrong_person` → only if those last words match
     `UNMISTAKABLE_WRONG_NUMBER` (the classifier's own table carries partials
     like "this is not" and bare "galat", which mid-call also match "no, this is
     not what I asked" and "galat samajh gaye").

---
<div class="page-break"></div>

## 17. Latency and performance

### 17.1 The measured decomposition (2026-09-03 audit, read-only)

**Evidence: 699 fully-decomposable production turns** from
`call_metrics.raw.turnLatencies`, restricted to `recorded_at >= 2026-08-28`
(i.e. after the last TTS-lane commit, so every figure is current-code). Source:
`HANDOFF.md` § LATENCY AUDIT.

Per-turn share of `total` (caller speech end → first audio queued):

| Scope | turns | STT lag | LLM TTFT | Residual¹ | TTS TTFA | **Total** |
|---|---|---|---|---|---|---|
| **All turns** | 699 | **1,544 ms — 41.9%** | 898 ms — 28.5% | 1,109 ms — 17.0% | 409 ms — 12.5% | **3,961 ms** |
| **Slow turns** (>p90 = 6,285 ms) | 69 | 3,090 ms — 34.8% | 995 ms — 10.7% | **7,110 ms — 49.0%** | 552 ms — 5.5% | **11,747 ms** |

¹ `residual = total − stt − llm − tts` = detector confirmation hold + chunker +
buffered-turn drain wait.

Percentiles (686 turns with all four stages present):

| Stage | p50 | p90 | p99 | max |
|---|---|---|---|---|
| **total** | 2,905 | 6,285 | 22,539 | 28,294 |
| STT recognition lag | 1,100 | 3,260 | 5,980 | 8,180 |
| LLM TTFT | 767 | 1,347 | 2,902 | 3,861 |
| TTS TTFA | 328 | 532 | 1,715 | 2,362 |
| **Residual** | **246** | **1,877** | **19,390** | **22,026** |

**Shape of the problem: at the median STT dominates; on the turns that actually
feel broken the residual dominates and LLM/TTS become almost irrelevant.**

### 17.2 The two P0 items

**P0-A — buffered-turn drain wait.** 49% of all slow turns; 19.1% of *second*
turns exceeded 3 s of residual; p99 = 19.4 s. Root cause is narrow: the caller
speaks into the **THINKING gap**, so `spokeOverTheAssistant` is false, no
barge-in path is consulted, `emitTurnEnd` fires with no subscriber, and the turn
sits in `pendingEvent` invisible until the whole reply has drained. Amplified by
reply length — the pitch block measures **208 chars p50 / 407 p90** ≈ **9.5 s
p50 / 18.5 s p90** of speech.

> **Status: FIXED and shipped** on 2026-09-04. `drainPlayback`'s 250 ms
> buffered-turn poll (§11.6) is the implementation of the P0 fix the audit
> proposed. The audit text in `HANDOFF.md` still says "NOT IMPLEMENTED"; that
> section predates the fix.

**P0-B — Deepgram STT recognition lag.** 41.9% of average latency; p90 3,260 ms;
34.8% of slow turns. Decomposes as `endpointing: 400` + 660–1,700 ms vendor
recognition/delivery + **only 150–300 ms of our own detector hold**. On noisy
lines `speech_final` never rides on the words and release waits for
`utterance_end_ms: 1000` (Deepgram's documented minimum). Corroborated by
`test:wire-trace` captures: clean 1,085 ms / noise 1,733 ms / background voice
5,686 ms. **What remains is a vendor floor.**

### 17.3 Ranked remainder

| Rank | Item | Evidence |
|---|---|---|
| P1 | **LLM TTFT** — 898 ms mean. Genuine vendor floor on a ~14,500-token prompt at 98%+ cache hit, `reasoningTokens = 0` everywhere. Only lever is prompt size. Not what makes bad turns bad (10.7% of slow turns). | 699-turn set |
| P1 | **TTS lane assignment** — ~500 ms of p50 spread between lanes: cartesia TTFA **141 ms**, sarvam **257 ms**, smallest-ai **453 ms** (first-turn p90 **1,253 ms**). `assigned_provider` is locked at import, so ~39% of calls are permanently on the slower lanes. | same |
| P2 | **OpenAI silent SDK retries** — mechanism fully confirmed from installed source (`openai 7.3.0`, `maxRetries = 2`, retries on 408/409/429/≥500, backoff 0.5 s→1 s cap 8 s, and a `stream: true` chat completion **is** retryable). Retries log at `info` while default level is `warn`, so they are invisible. **Bounded by data: only 11 of 561 warm turns (2.0%) exceeded 2 s TTFT.** `maxRetries` deliberately **not** changed. | installed SDK + data |
| P2 | **Render region → vendor RTT** — plausible, **entirely unmeasured**. | — |
| P3 | **Render CPU / event-loop starvation** — **not supported by evidence.** Zero occurrences of `pump burst capped` in any log material available locally. Argued against independently: TTS share *falls* to 5.5% on slow turns, so slow turns are slow *before* audio exists. Resolvable in one Render dashboard log search. | repo-wide search |

### 17.4 Three claims the data refuted

1. **"LLM first token ~740 ms is the largest remaining item."** Measured 767 ms
   p50 / 898 ms mean / 1,347 ms p90 — real and second-largest at the median, but
   only 10.7% of slow turns. *Some comments inside
   `conversation-pipeline.ts` still carry the older `1.4–3.6 s` / `1326 ms warm
   / 2726 ms cold` figures. Trust the audit, not those comments.*
2. **"The first response of the call is the slowest (cold prefill)."** Cold
   prefill occurs in **4 of 778 turns — 0.5%.** `primeLlmPrefixCache` works.
   No first-turn penalty on any stage or lane.
3. **"Chunk accumulation ~250–450 ms before the first TTS request."** Applying
   the real chunker algorithm to 1,210 production replies gives a first cut of
   111 chars (pitch block) / 69 chars (later replies) against a derived output
   rate of 776 chars/s p50 → **89–193 ms typical, ~366 ms slow tail = 3–6% of a
   turn.** `MIN_FIRST_CHUNK_LENGTH` needs no change.

### 17.5 Latency mechanisms currently in the code

| Mechanism | Where |
|---|---|
| Streaming STT for the whole call (one socket) | `startContinuousStt` |
| Evidence-gated turn release (150 / 250 / 300 ms instead of 1,100–1,600 ms + 550 ms) | `turn-detection.ts` |
| Fixed greeting — no LLM leg on call-connect | `run()` |
| STT listener started **before** the greeting | `run()` |
| LLM prefix-cache priming during the greeting | `primeLlmPrefixCache` |
| Speculative LLM pre-open on evidenced pending turn | `startSpeculation` / `adoptSpeculation` |
| TTS transport pre-open (Sarvam WebSocket) | `prepareTtsTransport` / `prepareSession` |
| Sentence chunking with an eager first cut | `sentence-chunker.ts` |
| Streaming TTS on all four providers | `synthesizeStream` |
| Global fetch keep-alive (vendor connections survive the inter-turn gap) | `http-keepalive.ts` |
| Buffered-turn drain poll | `drainPlayback` |
| ElevenLabs `pcm_8000` — server-side resampling, half the bytes | `elevenlabs.provider.ts` |

### 17.6 Historical / reverted — **do not reintroduce**

Two commits made on the morning of 2026-09-04 were **reverted the same day**
and nothing from them was reintroduced:

| Commit | Status |
|---|---|
| `8265c24` "latency fix 1" | **REVERTED** by `ffcf969` |
| `92fb511` "latency fix 2" | **REVERTED** by `a24c50a` |

`HANDOFF.md` also contains a long `### PROPOSED P0 FIX — audited, NOT
IMPLEMENTED, awaiting approval` section and a `FIX #3 PHASE C — SARVAM
HANDSHAKE: INVESTIGATED, DELIBERATELY NOT IMPLEMENTED` section. **Both are
historical proposals, not descriptions of current behaviour.** The
`FIX #3 PHASE C` investigation concluded that Sarvam socket pooling is unsafe
here (utterance A cannot be distinguished from utterance B on one socket).

---
<div class="page-break"></div>

## 18. Cost architecture

### 18.1 Which components incur external usage cost

| Component | Billed on | Priced in repo? |
|---|---|---|
| **Telephony** (Vobiz / Plivo) | connected minutes | Yes — **explicitly labelled "order-of-magnitude list-price placeholders"** |
| **STT** (Deepgram) | audio minutes | Yes |
| **LLM** (OpenAI / Gemma) | input and output tokens, **priced separately per 1M** | OpenAI yes; **Gemma explicitly ⚠ UNVERIFIED** |
| **TTS** (ElevenLabs, Sarvam, Smallest AI) | characters per 1K | Yes |
| **TTS** (Cartesia) | **generated audio minutes**, not characters | Yes |
| **Google Sheets API** | quota, not metered spend in this repo | Not priced |

### 18.2 The rate table

`src/core/session/cost-estimator.ts` is the only place rates exist. Every vendor
is priced in **its own billing unit** rather than being forced into a shared
one.

| Category | Provider | Rate as coded |
|---|---|---|
| Telephony | Plivo | `0.0125` USD / connected minute *(placeholder)* |
| Telephony | Vobiz | `0.0125` USD / connected minute *(placeholder)* |
| Telephony | fallback | `0.015` USD / minute |
| STT | Deepgram | `0.0058` USD / minute (Nova-3 multilingual streaming, pay-as-you-go) |
| STT | fallback | `0.006` USD / minute |
| LLM | `gpt-5.1` | `1.25` in / `10` out USD per 1M tokens |
| LLM | `gemma-4` | `0` / `0` — **⚠ UNVERIFIED, do not treat as confirmed** |
| LLM | fallback | `5` / `5` USD per 1M |
| TTS | ElevenLabs | `0.05` USD / 1K chars |
| TTS | Sarvam | `₹3` / 1K chars ÷ `INR_PER_USD = 88` |
| TTS | Smallest AI | `0.0175` USD / 1K chars |
| TTS | Cartesia | `0.05` USD / **generated audio minute** |
| TTS | fallback | `0.05` USD / 1K chars |

> **Do not quote these figures to a customer.** The file itself says: *"These
> are order-of-magnitude list-price placeholders; replace them with your
> contracted rates before quoting figures."* Contracted rates are **not defined
> in repository**.

### 18.3 Structural cost decisions worth knowing

- **A single blended LLM rate is wrong by a factor of 8** for GPT-5.1
  ($1.25 in vs $10 out), and a voice agent's ratio is nothing like 50/50 — the
  prompt carries the whole system prompt plus rolling history every turn while
  the completion is one short spoken sentence. Blending mispriced every turn.
- **Token estimation is script-aware.** `LATIN_CHARS_PER_TOKEN = 4`,
  `DEVANAGARI_CHARS_PER_TOKEN = 1.5` — a flat ~4 undercounted every Hindi and
  Hinglish turn several-fold.
- **Cartesia must be priced on generated audio duration, not `ttsMs`**
  (`ttsMs` is synthesis wall-clock latency, a completely different quantity).
- **Streaming TTS bills for what was generated**: `generatedAudioSeconds`
  accumulates per chunk, so a barge-in halfway through bills for the half that
  was generated rather than a whole clip that never was.
- **The greeting's TTS cost is captured** via
  `metrics.recordAuxiliaryCost({ textToSpeech })` — it is not a measured *turn*,
  but it consumes real characters.
- **Telephony cost was previously always zero** — the collector initialised its
  total to 0 and nothing ever added to it, so the single largest structural cost
  difference between two telephony vendors was silently missing from the exact
  number the lab exists to compare.
- Costs land per-call in `call_metrics.cost_{telephony,stt,llm,tts,total}_usd`.

---
<div class="page-break"></div>

## 19. Testing and quality

### 19.1 Structure

**There is no test framework.** Every suite is a standalone `tsx` script under
`src/campaign/tests/`, written against Node's built-in `assert` with a small
runner, wired to its own `npm run test:*` script, exiting non-zero on failure.

The suites are unusually thorough — most open with a description of the exact
production defect they exist to prevent, often with verbatim transcripts and
measured numbers.

### 19.2 The suites

| Command | File | Covers |
|---|---|---|
| `test:barge-in` | `barge-in-accuracy-tests.ts` (61 KB) | Two 100-call-pilot defects: the agent going silent and staying silent; the "hello" on pickup |
| `test:buffered-turn` | `buffered-turn-drain-tests.ts` (53 KB) | The buffered-turn drain fix and the five things it must not break |
| `test:stt-clock` | `stt-clock-reset-tests.ts` (35 KB) | STT stream-clock rewind after a Deepgram reconnect — barge-in dying silently for the rest of the call |
| `test:continuity` | `conversation-continuity-tests.ts` (63 KB) | Three conversation defects + the registration gate they must not disturb |
| `test:attention` | `attention-check-tests.ts` (49 KB) | "Hello? Hello? Hello?" must not restart the script |
| `test:silence-recovery` | `silence-recovery-tests.ts` (41 KB) | Caller goes quiet; caller can only say "Hello?" |
| `test:ack-continuity` | `acknowledgement-continuity-tests.ts` (28 KB) | "okay" / "achha" / "haan ji" / "hmm" / "hello?" during agent speech |
| `test:self-echo` | `self-echo-tests.ts` (23 KB) | Our own audio back up the inbound track |
| `test:end-of-speech` | `end-of-speech-tests.ts` (31 KB) | The standalone `speech_final` / end-of-speech marker |
| `test:wire-trace` | `wire-trace-tests.ts` (30 KB) | **Real Deepgram wire captures** — clean line vs noise vs background voice |
| `test:turn-release` | `turn-release-tests.ts` (19 KB) | `AdaptiveTurnDetector` release latency |
| `test:turn-timing-telemetry` | `turn-timing-telemetry-tests.ts` (29 KB) | The `[TIMING:…]` / `[RESPONSE-LEN:…]` instrumentation |
| `test:speculative-llm` | `speculative-llm-start-tests.ts` (41 KB) | Pre-opened LLM request; **asserts a resume spends zero LLM requests** |
| `test:tts-streaming` | `tts-streaming-latency-tests.ts` (48 KB) | Time-to-first-audio + the twelve behaviours it must not cost |
| `test:sarvam-stream` | `sarvam-stream-tests.ts` (58 KB) | Sarvam premature truncation and the bounded idle-gap mechanism |
| `test:smallest-stream` | `smallest-ai-stream-tests.ts` (57 KB) | Smallest AI batch → SSE migration |
| `test:speaking-watchdog` | `speaking-watchdog-tests.ts` (20 KB) | A **talking agent** must not be read as silence |
| `test:agent-hangup` | `agent-hangup-tests.ts` (32 KB) | "Thanks for your time, take care." must end the call |
| `test:llm-usage-telemetry` | `llm-usage-telemetry-tests.ts` | OpenAI usage fields on the `final` event |
| `test:vobiz-call-control` | `vobiz-call-control-tests.ts` (15 KB) | Recording `time_limit`; webhook `call_uuid` extraction |
| `test:pronunciation` | `pronunciation-tests.ts` | `pronounceForSpeech` — no vendor, no socket, no DB |
| `test:campaign` … `test:phase10` | `phase2` … `phase10-disconnect-tests.ts` | Campaign layer: DB, dispatcher, results, production readiness, retry semantics, script-faithful handling, the sheet, the final-answer hangup, the Deepgram reconnect |
| *(no npm script)* | `sentence-chunker-first-clause-tests.ts` | Focused chunker regression — run with `npx tsx` |
| *(not a suite)* | `speech-gap-probe.ts` | Temporary diagnostic |
| *(not a suite)* | `script-hash-report.ts` | Prints every registered script with its content hash |

**Which suites place calls:** none. `phase3a` and `phase4` state explicitly
"NOTHING HERE PLACES A CALL" and use a fake manager. Database suites run against
real PostgreSQL and clean up after themselves.

### 19.3 Test status

> **These results are as recorded in `HANDOFF.md` at HEAD (2026-09-04). They
> were not re-run while producing this document.** Re-run before relying on
> them.

**Recorded green at HEAD:**

```
tsc --noEmit --incremental false   clean
phase8      32/32
phase9      21/21
agent-hangup 23/23
phase7      38/38
continuity  41/41   (gate tests 6/6b/7/7b/G/H green)
```

**Known pre-existing failures — not caused by recent work:**

| Suite | Failures | Nature |
|---|---|---|
| `test:phase7b` | **9 of 24** — A, A2, B, C, C2, J, K, L, L2 | All are `script-adherence` **report** assertions ("a faithful call must raise no adherence flag"). **None is about outcome.** Same set recorded since 2026-08-19. `script-adherence` is diagnostic only and is consulted by **no** decision rule. |
| `test:silence-recovery` | 8 of 22 (per project memory) | The suite still waits 3,000 ms while commit `38bae93` raised the recovery interval; the constant is now `10_000`. **Test-only staleness.** |
| `test:continuity` | 1 varying test | Times out at its 15 s deadline when another process (`tsc`, a DB suite) runs alongside; a **different** test fails each run. A pristine tree passed 41/41, as did the changed tree once run alone. |
| `test:stt-clock` | C1, intermittent | A 15 s deadline races a 14.4 s drain. One failure ≠ regression — re-run and read its log. |
| Campaign suites | ~3 assertions | Fail when `CAMPAIGN_DIALING_ENABLED=true`. **Set it to `false` for the run, then restore it.** |

### 19.4 Test-only behaviour to be aware of

- `immediateOnFinal` on `AdaptiveTurnDetector` and the injectable `now()` clock
  exist for deterministic tests.
- Transports that never report energy (`lastCallerEnergyAt === 0`) keep the
  pure-transcript barge-in behaviour — that is the in-process fallback and the
  test harnesses, not production.
- `FinalYesSheetDeps` allows substituting the appender so the database
  idempotency guarantee can be exercised with no network call or credential.
- `bootstrapProviderRegistry(registry)` accepts an existing registry for tests.

### 19.5 Running tests safely

```bash
# 1. turn dialing OFF in .env.local first — edit the single line, do not rewrite the file
#    CAMPAIGN_DIALING_ENABLED=false
# 2. run suites ONE AT A TIME — the 15s-deadline suites flake under parallel load
npm run test:continuity
npm run test:barge-in
npm run test:attention
# 3. typecheck without the incremental cache
npx tsc --noEmit --incremental false
# 4. restore CAMPAIGN_DIALING_ENABLED to its previous value
```

---
<div class="page-break"></div>

## 20. Deployment and environment configuration

### 20.1 Commands

| Task | Command |
|---|---|
| Dev server (custom, with WS bridges) | `npm run dev` → `tsx server.ts` |
| Production start | `npm run start` → `NODE_ENV=production tsx server.ts` |
| Next build | `npm run build` |
| Lint | `npm run lint` → `next lint` |
| Typecheck | `npm run typecheck`; **if it looks too clean**, `npx tsc --noEmit --incremental false` |
| DB migrations | `npm run db:migrate` |
| Verify DB constraints | `npm run db:verify` |
| Production preflight | `npm run preflight:prod -- <campaignId>` |
| Post-run audit | `npm run campaign:audit -- <campaignId>` |
| Script hashes | `npx tsx src/campaign/tests/script-hash-report.ts` |

> `npm run start` uses `tsx`, not a compiled bundle. `next build` produces the
> Next assets, but the server itself is always run through `tsx`.

### 20.2 Environment variables — **names only**

| Group | Keys |
|---|---|
| App | `APP_PUBLIC_BASE_URL`, `NEXT_PUBLIC_APP_URL`, `PORT`, `DATABASE_URL` |
| Kill switch / limits | `CAMPAIGN_DIALING_ENABLED`, `CAMPAIGN_STAGE_MAX_CALLS`, `CAMPAIGN_GLOBAL_MAX_CONCURRENCY`, `CAMPAIGN_GLOBAL_CPS`, `CAMPAIGN_CONCURRENCY_<PROVIDER>`, `CAMPAIGN_CPS_<PROVIDER>`, `CAMPAIGN_MAX_CALLS_PER_DID` |
| Watchdogs | `CAMPAIGN_RING_TIMEOUT_SECONDS`, `CAMPAIGN_MAX_CALL_SECONDS`, `CAMPAIGN_MAX_SILENCE_SECONDS` |
| Dispatcher | `CAMPAIGN_CLAIM_BATCH_SIZE`, `CAMPAIGN_POLL_INTERVAL_MS`, `CAMPAIGN_DISPATCHER_ID`, `CAMPAIGN_LOCK_STALE_SECONDS` |
| Retries | `CAMPAIGN_RETRY_MAX_ATTEMPTS`, `CAMPAIGN_RETRY_REGISTRATION_MAX_ATTEMPTS`, `CAMPAIGN_RETRY_NO_ANSWER_DELAY_MINUTES`, `CAMPAIGN_RETRY_BUSY_DELAY_MINUTES`, `CAMPAIGN_RETRY_CALLBACK_DELAY_MINUTES`, `CAMPAIGN_RETRY_UNRESOLVED_DELAY_MINUTES`, `CAMPAIGN_RETRY_TEMPORARY_BACKOFF_MINUTES`, `CAMPAIGN_RETRY_ON_REJECTED`, `CAMPAIGN_RETRY_ON_USER_HANGUP`, `CAMPAIGN_RETRY_ON_UNRESOLVED_REGISTRATION` |
| Import | `CAMPAIGN_CSV_MAX_BYTES`, `CAMPAIGN_CSV_MAX_ROWS`, `CAMPAIGN_DEFAULT_REGION` |
| Sheets | `CAMPAIGN_SHEET_SPREADSHEET_ID`, `CAMPAIGN_SHEET_TAB_NAME`, `GOOGLE_SERVICE_ACCOUNT_JSON` (or the two flat client-email / private-key variables) |
| Telephony — Vobiz | `VOBIZ_AUTH_ID`, `VOBIZ_AUTH_TOKEN`, `VOBIZ_FROM_NUMBER`, `VOBIZ_ANSWER_URL`, `VOBIZ_API_BASE_URL` |
| Telephony — Plivo | `PLIVO_AUTH_ID`, `PLIVO_AUTH_TOKEN`, `PLIVO_FROM_NUMBER`, `PLIVO_ANSWER_URL` |
| STT | `DEEPGRAM_API_KEY`, `DEEPGRAM_MODEL` |
| LLM | `OPENAI_API_KEY`, `OPENAI_MODEL`, `GEMMA_API_KEY`, `GEMMA_MODEL` |
| TTS — ElevenLabs | `ELEVENLABS_API_KEY`, `ELEVENLABS_DEFAULT_VOICE_ID`, `ELEVENLABS_MODEL_ID`, `ELEVENLABS_SAMPLE_RATE_HZ` |
| TTS — Cartesia | `CARTESIA_API_KEY`, `CARTESIA_DEFAULT_VOICE_ID`, `CARTESIA_MODEL_ID`, `CARTESIA_SAMPLE_RATE_HZ` |
| TTS — Sarvam | `SARVAM_API_KEY`, `SARVAM_DEFAULT_SPEAKER`, `SARVAM_TTS_MODEL`, `SARVAM_BASE_URL`, `SARVAM_SAMPLE_RATE_HZ`, `SARVAM_STREAM_IDLE_GAP_MS`, `SARVAM_STREAM_START_TIMEOUT_MS` |
| TTS — Smallest AI | `SMALLEST_AI_API_KEY`, `SMALLEST_AI_DEFAULT_VOICE_ID`, `SMALLEST_AI_BASE_URL`, `SMALLEST_AI_STREAM_BASE_URL`, `SMALLEST_AI_SAMPLE_RATE_HZ` |

**All env access goes through `src/providers/shared/env`**. The module exports
exactly four helpers — `requireEnv`, `optionalEnv`, `optionalEnvNumber` and
`readSettingsString`. There is **no** `requireEnvNumber`: a numeric value that
must be present has no helper today, so it is read through `optionalEnvNumber`
with a default. Never touch
`process.env` directly — `VoiceAgentLabEnv` augments `ProcessEnv`, so a typo is
a compile error. *(The one deliberate exception is
`registerIfConfigured` in `bootstrap.ts`, which probes `process.env[name]` by
dynamic key to decide whether to register a provider at all.)*

### 20.3 Provider registration is env-driven

`bootstrapProviderRegistry()` registers a provider **only when every required
env var is present**, so a deployment can run a subset of providers without the
other adapters throwing at startup. Unregistered providers are logged as
`[voice-agent-lab] provider not registered: CATEGORY/id — Missing environment
variable(s): …`.

| Provider | Required vars |
|---|---|
| Plivo | `PLIVO_AUTH_ID`, `PLIVO_AUTH_TOKEN`, `PLIVO_FROM_NUMBER`, `PLIVO_ANSWER_URL` |
| Vobiz | `VOBIZ_AUTH_ID`, `VOBIZ_AUTH_TOKEN`, `VOBIZ_FROM_NUMBER`, `VOBIZ_ANSWER_URL` |
| Deepgram | `DEEPGRAM_API_KEY` |
| GPT-5.1 | `OPENAI_API_KEY` |
| Gemma 4 | `GEMMA_API_KEY` |
| ElevenLabs | `ELEVENLABS_API_KEY`, `ELEVENLABS_DEFAULT_VOICE_ID` |
| Cartesia | `CARTESIA_API_KEY`, `CARTESIA_DEFAULT_VOICE_ID` |
| Sarvam | `SARVAM_API_KEY`, `SARVAM_DEFAULT_SPEAKER` |
| Smallest AI | `SMALLEST_AI_API_KEY`, `SMALLEST_AI_DEFAULT_VOICE_ID` |

### 20.4 `.env.local` handling — read this before editing it

- **Never rewrite `.env.local` wholesale.** It holds live credentials and has
  been corrupted once already.
- **Multi-line values must be quoted** or they truncate at the first newline.
  An unquoted `GOOGLE_SERVICE_ACCOUNT_JSON` truncates to `{`. The symptom is an
  auth failure that looks like a bad key.
- **Duplicate keys are last-win.**
- Edit the single line you need and leave the rest byte-identical.

### 20.5 Load ladder

The effective call ceiling is the **smallest** of `CAMPAIGN_STAGE_MAX_CALLS`,
the campaign's `pilot_stage` rung, and any per-campaign ceiling. The start
response says which one bound. **Every control can only ever lower the call
count.**

| Rung | Calls | `pilot_stage` | `CAMPAIGN_STAGE_MAX_CALLS` |
|---|---|---|---|
| 1 | 10 | 0 | 10 |
| 2 | 50 | 1 | 50 |
| 3 | 100 | 2 | 100 |
| 4 | 500 | 3 | 500 — **only after carrier limits are confirmed** |
| 5 | 2,000+ | 4 | set explicitly, against measurements |

Never advance two rungs at once. Never advance on a red gate (Phase 6 §H).

### 20.6 Safe run procedure

1. `npm run db:verify`
2. `npm run preflight:prod -- <campaignId>` — must be clean
3. Confirm the effective ceiling from the start response
4. Start the run; watch logs for `[campaign-db]` errors and `pump burst capped`
5. `npm run campaign:audit -- <campaignId>`
6. Check the Phase 6 §H gates before advancing a rung

### 20.7 Deployment

- Deployed base URL per `MEMORY.md`: `https://voice-agent-lab.onrender.com`
  (Render). Read from `APP_PUBLIC_BASE_URL`.
- **No deployment manifest is committed** — no `render.yaml`, `Dockerfile`,
  `Procfile`, `fly.toml`.
- Render **region, plan, CPU and memory: Not confirmed from repository.** No
  `RENDER_*` env var is read anywhere.
- CI/CD pipeline: **Not confirmed from repository.** There is no
  `.github/workflows` directory.
- The **answer URLs and the WebSocket URLs must point at the same process** that
  owns the in-memory session — a multi-instance deployment without sticky
  routing would break session correlation. **Not confirmed from repository:**
  whether the Render service runs a single instance.

---
<div class="page-break"></div>

## 21. Known issues

Labelled by kind, as requested. **Nothing in this section was fixed while
producing this document.**

### 21.1 Production issues / accepted limitations

| # | Issue | Detail |
|---|---|---|
| P-1 | **There is no AMD / voicemail detection at the carrier.** | "Answered" means *the media stream opened* — true for a human, a voicemail greeting and an IVR alike. `external-limits.ts` records answering-machine detection as **unavailable** on both providers. The pipeline's `voicemail-detection.ts` is a **transcript heuristic only**: matching a marker is evidence, never proof, and failing to match is not evidence of a human. It is bounded to `turnIndex === 0` within a 20 s window. |
| P-2 | **A single caller ID is a production blocker for volume.** | `VOBIZ_FROM_NUMBER` is one number, read once, sent verbatim on every call. No pool, no rotation. A run whose ceiling exceeds `CAMPAIGN_MAX_CALLS_PER_DID` (500) is **BLOCKED** by readiness check 8. Unblocking needs the DID list from Vobiz, not more code (decision D-06). |
| P-3 | **Carrier concurrency ceiling is 3.** | Exceeding it means carrier-side teardown of live conversations, indistinguishable at our end from a random disconnect. |
| P-4 | **Vobiz bridge has no outbound backpressure.** | `plivo-media-bridge.ts` bounds its queue at a 2.8 s high-water mark; `vobiz-media-bridge.ts` does not. On the live lane the outbound queue is unbounded within the process. |
| P-5 | **Plivo bridge's energy-only barge-in is ungated.** | `vobiz-media-bridge.ts` suppresses the 700 ms energy-only fallback while STT is demonstrably alive (`STT_UNHEALTHY_AFTER_MS = 30_000`); `plivo-media-bridge.ts` has no such gate. |
| P-6 | **Call recordings are not tracked.** | Vobiz-only, mp3, started fire-and-forget from the answer webhook. `recording_id` and `url` are logged and discarded — no DB column, no retrieval path, no transcript association (see §14). |
| P-7 | **The `backchannel` 4 s gate is effectively dead on real bridges.** | `remainingSpeechMs()` is pinned near the transport's high-water mark, so it rarely crosses 4,000 ms mid-block. `!replyFullyQueued` is what actually carries the rule during a block. The 4 s threshold is still the *end-of-block* rule and is load-bearing for FINAL_YES. |
| P-8 | **STT lag is a vendor floor.** | 41.9% of average latency; on noisy lines release waits for `utterance_end_ms: 1000`, Deepgram's documented minimum (§17.2). |
| P-9 | **OpenAI SDK retries are silent.** | `maxRetries = 2`, retries log at `info` while the default level is `warn`, and `campaign:audit`'s `rateLimitedAttempts` reads `call_attempts.failure_reason` — i.e. call-level failures only, structurally blind to a retry that succeeded. Bounded by data at 2.0% of warm turns. `maxRetries` deliberately not changed. |
| P-10 | **Render CPU / event-loop starvation is neither confirmed nor refuted.** | Zero local log material. Resolvable in one Render dashboard log search. |

### 21.2 The documented classifier edge case — **do not fix as part of documentation work**

> **`gate → "No." → [NO] closing line → caller "Okay, thanks."` currently
> settles as `interested_not_confirmed` / UNRESOLVED instead of `declined` /
> FINAL_NO.**
>
> Rule 6 in `classifyOutcome` ("a no that nothing positive followed") is
> defeated by the courtesy "okay", which is not at the gate but **is positioned
> after** the no. It is the same family as the two 2026-09-04 fixes (a courtesy
> token read as an answer) but in the **opposite direction**. It was
> deliberately left for its own investigation so that pass stayed within its
> approved scope. **This is still present at HEAD and is intentionally
> unresolved.**

### 21.3 Test-only issues

| # | Issue |
|---|---|
| T-1 | `test:phase7b` — **9 of 24 fail**, all `script-adherence` *report* assertions, none about outcome. Same set since 2026-08-19. `script-adherence` is diagnostic and consulted by no decision rule. |
| T-2 | `test:silence-recovery` — the suite waits 3,000 ms; the production interval is `SILENCE_RECOVERY_INTERVAL_MS = 10_000`. **Stale test, correct code.** |
| T-3 | `test:continuity` — 15 s deadlines flake under parallel load; a *different* test fails each run. Run it alone and re-run once before blaming a change. |
| T-4 | `test:stt-clock` C1 — a 15 s deadline races a 14.4 s drain. One failure ≠ regression. |
| T-5 | Campaign suites produce ~3 failures when `CAMPAIGN_DIALING_ENABLED=true`. Turn it off for the run, then restore it. |
| T-6 | `npm run typecheck` can pass on a file that does not parse, from a stale `tsconfig.tsbuildinfo`. Use `npx tsc --noEmit --incremental false` when a result looks too clean. |

### 21.4 Historical / reverted — labelled so they are not mistaken for current behaviour

| # | Item |
|---|---|
| H-1 | **`8265c24` "latency fix 1"** — reverted by `ffcf969`. Nothing reintroduced. |
| H-2 | **`92fb511` "latency fix 2"** — reverted by `a24c50a`. Nothing reintroduced. |
| H-3 | `HANDOFF.md` § *PROPOSED P0 FIX — audited, NOT IMPLEMENTED* — that proposal was **subsequently implemented** on 2026-09-04 as the `drainPlayback` buffered-turn poll. The section text predates the fix. |
| H-4 | `HANDOFF.md` § *FIX #3 PHASE C — SARVAM HANDSHAKE: INVESTIGATED, DELIBERATELY NOT IMPLEMENTED* — Sarvam socket pooling was investigated and **rejected**: utterance A cannot be distinguished from utterance B on one socket. |
| H-5 | Comments inside `conversation-pipeline.ts` still carry pre-audit LLM latency figures (`1.4–3.6 s`, `1326 ms warm / 2726 ms cold`). The 2026-09-03 audit measured 767 ms p50 / 898 ms mean. Trust the audit. |
| H-6 | The Sarvam descriptor reports `version: "bulbul-v3"` while the default model (`SARVAM_TTS_MODEL`) is `bulbul:v2`. A cosmetic inconsistency in the descriptor string only — the request always uses the env value. |
| H-7 | **`smallest-ai.provider.ts`'s own file-header comment is stale.** It documents the batch endpoint as `POST https://waves-api.smallest.ai/api/v1/lightning/get_speech`. The code actually calls `${SMALLEST_AI_BASE_URL}/waves/v1/tts` for batch and `${SMALLEST_AI_STREAM_BASE_URL}/api/v1/lightning-v3.1/stream` for SSE — two different hosts, as a later comment in the same file correctly explains. **Trust the code, not that header.** |

### 21.5 Unresolved edge cases

| # | Case |
|---|---|
| E-1 | A **two-word self-echo** ("Nice. Thanks." for "Nice, thanks.") is deliberately **not** suppressed — nothing distinguishes it from a real two-word caller turn. Accepted: a missed echo costs one confused exchange; a suppressed caller turn loses their words entirely. |
| E-2 | An **interim-only utterance** is not used for supersession. If Deepgram owes a final it never delivers, a discarded reply with no turn to replace it would be silence — a worse failure than a stale sentence. |
| E-3 | `unspokenTail()` returns `""` when the spoken and heard strings diverge on a non-whitespace character (speech formatting is applied both per utterance and to the whole reply). Resume then does nothing, deliberately. |
| E-4 | The Plivo answer route claims a **pending** session by `CallUUID` — if no pending session is waiting, the call is politely hung up rather than bridged. |
| E-5 | `campaign:audit`'s `rateLimitedAttempts` cannot see a vendor retry that succeeded (see P-9). |

---
<div class="page-break"></div>

## 22. Engineering "do not break" rules

> **Read this section before your first change.** Every rule below traces to a
> specific production failure that has already happened once.

### 22.1 Architecture invariants

| # | Rule | Why |
|---|---|---|
| A-1 | **Never change an existing provider-interface signature.** Append **optional** members only. | Rewriting the signatures would invalidate all nine concrete providers at once (D-02). |
| A-2 | **The Dashboard may call only `VoiceSessionManager`.** `pushInboundAudio` / `onOutboundAudio` / `signalBargeIn` stay off the interface. | D-01, D-03. Provider swaps must remain a data change. |
| A-3 | **Preserve the provider registry and its env-driven bootstrap.** A provider is registered only when its env vars exist. | A deployment must be able to configure a subset without other adapters throwing at startup. |
| A-4 | **Keep folder names, interface names and existing member signatures.** | The layering *is* the architecture. |
| A-5 | **All env access through `src/providers/shared/env`.** | `VoiceAgentLabEnv` augments `ProcessEnv`, so a typo is a compile error. |

### 22.2 Voice / media layer — the highest-risk code in the repo

| # | Rule | What breaks if you ignore it |
|---|---|---|
| V-1 | **Do not casually change turn detection.** Every window, grace and bound in `turn-detection.ts` is calibrated against measured behaviour, and several are explicitly bounded so a pathological line still gets a reply. | Replies land on top of the caller mid-sentence, or a caller who trails off never gets one. |
| V-2 | **Do not change endpointing (`endpointing: 400`, `utterance_end_ms: 1000`) without testing real calls.** | 300 ms finalises so eagerly that a caller drawing breath arrives as several finals and drags the adaptive threshold to its floor. 1000 ms is Deepgram's documented minimum for the utterance-end signal. |
| V-3 | **Do not alter barge-in without checking telephony playback clearing.** The bridges match the transition reason with `/barge.?in/i` and only clear when `signalBargeIn()` returned `true`. | Clearing the queue on a *declined* barge-in leaves the caller in silence with nothing left to play and no reply on the way. |
| V-4 | **Do not break self-echo protection.** Keep the bigram test, the ≥ 4-word floor, and the bound on `heardSoFarText()` — not on `SPEAKING`. | The agent answers its own voice. The echo's final lands *after* `drainPlayback` leaves SPEAKING, which is exactly the hole a state gate reopens. |
| V-5 | **Do not make every "Hello" an interruption.** `isBareAcknowledgement` deliberately **excludes** "hello" (over playing audio it means the line went bad and must interrupt), but `BARE_GREETING_ONLY` covers it while THINKING and before playback starts. | A "hello" that cancels a reply with nothing heard commits nothing to memory, so the next request regenerates the identical line — once per "hello". |
| V-6 | **Do not queue hearing acknowledgements behind long TTS.** The `drainPlayback` poll + `bufferedTurnDemandsAttention` exist so a repeated "Hello?" is answered at once, not 18 s later. | Measured: a caller said hello again and waited through an 18 s block before being asked whether they could hear. |
| V-7 | **Do not change silence recovery casually.** `SILENCE_RECOVERY_INTERVAL_MS = 10_000`, max 2 prompts, armed only while idle in LISTENING, cancelled by any activity. | Either dead air until the watchdog hangs up, or the agent talking over a caller who was about to speak. |
| V-8 | **Do not remove the STT stream-clock re-basing.** `sttStreamMsOf()` + `sttClockOffsetMs` + `STT_CLOCK_REWIND_TOLERANCE_MS`. | A Deepgram reconnect restarts its word clock at zero and **barge-in dies silently for the rest of the call** — the segment still reaches the detector, so nothing looks wrong in the logs. |
| V-9 | **Do not end the STT segment stream on a socket `close`/`error`.** Only *this generator deciding the call is over* ends it. | One transient socket event killed transcription, froze `lastConversationActivityAt`, and the watchdog hung up a live conversation ~20 s later. |
| V-10 | **Do not subscribe to `onTurnEnd` from a polling site.** Use the read-only accessors. | `emitTurnEnd` buffers only while `listeners.size === 0`; an extra subscriber consumes the event and the main loop never sees the turn. |
| V-11 | **Do not commit an interrupted reply in full.** Only `cancelledHeardText`. | It puts a sentence the caller never let us finish between their own two utterances and feeds it to the next request as a real exchange. |
| V-12 | **Do not let `!greetingDone` stop gating barge-in.** | A "hello" on pickup truncated the opening line ~120 ms in; saying "hello" again cancelled the next reply too, and the call could livelock. |
| V-13 | **Keep speculative LLM start off during attention episodes and while a script position is held.** The `attentionEpisodeOpen` / `heldScriptRemainder` guards in `startSpeculation()`. | The attention/continuity suites assert a resume spends **zero** LLM requests. |
| V-14 | **Do not touch the outbound frame size, pump cadence, pre-roll or `contentType` spelling.** 160 bytes / 20 ms; `"audio/x-mulaw"` **bare** in `playAudio` with `sampleRate` separate; `";rate=8000"` **only** on the `<Stream>` XML attribute. | Wrong spelling silently produces no audio; wrong framing desynchronises the pump. |
| V-15 | **Preserve `drainPlayback`.** SPEAKING must stay open until the audio has really played. | Without it, SPEAKING ended when the last byte was *queued* — so `state === SPEAKING` was false, barge-in never fired, and a new turn's audio appended behind the previous turn's backlog. |
| V-16 | **Preserve call connect/disconnect behaviour.** `confirmCallAnswered()` on the bridge `start` event; Vobiz sends **no** `stop` (close = end-of-stream); hang-up only through `manager.end()`. | Anything else leaves half-open sessions and orphaned carrier legs. |
| V-17 | **Preserve conversation continuity** — the 20-pair window, `CURRENT_TURN_NOTE`, `previewRecentHistory` sharing `window()` with `recentHistory`. | At 6 pairs the model re-introduced itself and re-opened the pitch. Without the marker it answers the wrong user turn. Without the shared window, speculative adoption stops matching. |

### 22.3 Campaign layer

| # | Rule | Why |
|---|---|---|
| C-1 | **Do not let old confirmations leak into later gate questions.** `answersACommitQuestion` looks **backward only**, stops at any other question, and steps over an assistant turn **only** when `isBareAcknowledgement` says so. **Length is not the test.** | A 27-character "Yes, it's completely free." was stepped over and turned a courtesy "Okay." into a registration and a Google Sheet row. |
| C-2 | **Never re-word a script without updating `COMMIT_ANCHORS`.** | Silently kills FINAL_YES detection — and with it the sheet row and the auto-hangup (D-08). Run `script-hash-report.ts` after any script edit. |
| C-3 | **Do not act on a live FINAL_YES while the agent's latest turn is a question.** | The runner hung up while a re-asked gate question was on the line. |
| C-4 | **Never raise a load limit to make something pass.** `load-guardrails.ts` refusing a run is the feature, not a bug (D-05). | `CPS = 0` means *no rate limit*, not *no calls*; `MAX_CONCURRENCY = 0` silently never dials. A clamp would hide both. |
| C-5 | **Do not raise concurrency above 3** without new written confirmation from Vobiz (D-04). | Carrier-side teardown of live conversations. |
| C-6 | **Do not weaken the dialing kill switch.** `CAMPAIGN_DIALING_ENABLED` is checked **before** a session can exist. | A rehearsal must not be able to reach the telephony provider. |
| C-7 | **Keep the campaign layer out of the voice/media layer.** `call-runner.ts` is the only campaign module that *drives* the voice agent, and only through public methods on a structural `ManagerLike`. The two read-only shared-table imports (§15.3) are the deliberate exception; do not add a third kind. | Timing-sensitive code must have exactly one owner. |
| C-8 | **Keep the sheet sync non-throwing and last.** | A sheet problem must never reach the retry planner, the disposition, the attempt row or the campaign state. |
| C-9 | **Keep the three provider-lock layers.** Immutable column + claim-query filter + attempt trigger. | A cross-provider reassignment must remain a transaction that *cannot commit*, not a bug we try to avoid writing. |
| C-10 | **Do not reintroduce the reverted latency experiments** (`8265c24`, `92fb511`). | They were reverted deliberately; nothing from them is in the tree. |

### 22.4 Process

| # | Rule |
|---|---|
| Pr-1 | **Real calls are live.** Say so before running anything that can dial. |
| Pr-2 | **Do not rewrite `.env.local`.** Edit one line; multi-line values must stay quoted; duplicate keys are last-win. |
| Pr-3 | **Do not trust a clean `npm run typecheck`.** Use `npx tsc --noEmit --incremental false`. |
| Pr-4 | **Do not present known pre-existing test failures as production bugs** (see §21.3). |
| Pr-5 | **Keep the "why" comment at the top of every non-trivial file.** It is the house style and it is the reason this codebase is debuggable. |
| Pr-6 | **Update `HANDOFF.md` at the end of a working session; update `MEMORY.md` only on a structural change** (D-10). |

---
<div class="page-break"></div>

## 23. Important files / code map

### 23.1 Codebase map

| Area | Important files | Responsibility |
|---|---|---|
| **Process entry** | `server.ts` | Custom Node HTTP server; delegates HTTP to Next; terminates the two telephony WebSocket upgrades; graceful shutdown incl. PG pool |
| **Runtime bootstrap** | `src/server/runtime.ts` | The one `ProviderRegistry` + `DefaultVoiceSessionManager`, on `globalThis` |
| **Provider registry** | `src/providers/registry/bootstrap.ts`, `in-memory-provider-registry.ts` | Env-driven registration; the only place an id maps to a concrete class |
| **Provider contracts** | `src/interfaces/providers/*.interface.ts` | Telephony / STT / LLM / TTS contracts; streaming members are optional and additive |
| **Session orchestration** | `src/core/session/voice-session-manager.impl.ts` | Session lifecycle, state transitions, warm-up, `end()`, plus the three non-interface transport hooks |
| **Session state** | `src/core/session/session-record.ts`, `src/constants/session-states.constants.ts` | Per-session mutable state; declarative transition table |
| **The conversation pipeline** | `src/core/session/conversation-pipeline.ts` (~4,970 lines) | The whole LISTENING→THINKING→SPEAKING loop: STT consumption, all barge-in filters, attention/hearing handling, silence recovery, speculation, chunking, TTS, playback accounting |
| **Turn detection** | `src/core/session/turn-detection.ts` | `AdaptiveTurnDetector`; `isBareAcknowledgement` (shared with the classifier) |
| **Conversation memory** | `src/core/session/conversation-memory.ts` | Turn history, 20-pair window, `previewRecentHistory` |
| **System prompt** | `src/core/session/system-prompt.ts` (68 KB) | Master prompt, `openingLineFor`, `languageHintFor`, `currentTurnNote` |
| **Chunking / formatting** | `sentence-chunker.ts`, `src/utils/speech-formatter.ts`, `speech-pronunciation.ts` | Sentence cuts for TTS; markdown stripping; numeral/currency pronunciation per language |
| **Metrics / cost** | `metrics-collector.ts`, `cost-estimator.ts` | Per-turn latency + per-vendor cost in each vendor's own billing unit |
| **Support** | `barge-in-controller.ts`, `async-queue.ts`, `abort-utils.ts`, `audio-utils.ts`, `error-recovery.ts`, `language-detector.ts`, `voicemail-detection.ts` | Cancellation, back-pressured queue, signal combination, retry classification, per-turn language, the shared voicemail table |
| **Media bridges** | `src/server/vobiz-media-bridge.ts`, `plivo-media-bridge.ts` | Byte movement, 20 ms pump, energy gates, `clearAudio` |
| **Audio** | `src/server/audio-codec.ts`, `vad-segmenter.ts` | μ-law codec, anti-aliased resampler, exact framing; two-threshold energy VAD |
| **Answer webhooks** | `src/app/api/voice/{vobiz,plivo}/answer/route.ts`, `src/server/plivo-xml.ts`, `pending-call.ts`, `public-url.ts` | `<Stream>` XML, session correlation, **Vobiz recording kick-off** |
| **Telephony adapters** | `src/providers/telephony/{vobiz,plivo}.provider.ts` | Call control + `startRecording` (Vobiz) |
| **STT adapter** | `src/providers/speech-to-text/deepgram.provider.ts` | Live socket, `transcriptEventFromMessage`, keep-alive, reconnect survival |
| **LLM adapters** | `src/providers/language-model/{openai-gpt,gemma}.provider.ts` | Streaming completions; usage telemetry; Gemma `thought`-part filtering |
| **TTS adapters** | `src/providers/text-to-speech/{elevenlabs,cartesia,sarvam,smallest-ai}.provider.ts` | Batch + streaming synthesis; Sarvam `prepareSession`; Smallest AI edge-silence trim |
| **Shared provider utils** | `src/providers/shared/{env,http,audio,health}.ts` | Typed env access, HTTP helpers, WAV decode, health probes |
| **HTTP tuning** | `src/server/http-keepalive.ts` | Undici global dispatcher keep-alive so vendor connections survive inter-turn gaps |
| **Campaign config** | `src/campaign/config/{dispatch,campaign,sheet,calling-window}.config.ts` | Every limit, read from env; nothing invented |
| **Dispatcher** | `src/campaign/dispatch/{dispatcher,concurrency,run-launcher,load-guardrails,control-watcher,calling-window-watcher,session-observer}.ts` | Lanes, semaphores, token buckets, refusals, pause/resume/stop |
| **Call runner** | `src/campaign/dispatch/call-runner.ts` (44 KB) | One call end-to-end; the watchdog; `definitiveAnswerIn`; `agentClosedIn`; `finalize` |
| **Retry** | `src/campaign/dispatch/retry-planner.ts` | Retry vs terminal, per-reason delays, definitive-outcome override |
| **Outcome** | `src/campaign/outcome/{classifier,conversation-events,disposition,outcome-types,script-adherence,transcript}.ts` | Phrase tables, `COMMIT_ANCHORS`, answer readability, the 11 outcome types, the 5 dispositions |
| **Import** | `src/campaign/import/{csv-parser,column-mapper,phone-normalizer,validator,importer,provider-allocator}.ts` | CSV → contacts, phone normalization, provider lane allocation |
| **Persistence** | `src/campaign/db/{client,migrate,verify-constraints}.ts`, `db/migrations/*.sql`, `db/repositories/*.repo.ts` | Pool, migrations, DB-enforced invariants, all queries |
| **Results** | `src/campaign/results/{campaign-results,results.repo,export-csv,results-types}.ts` | Aggregation and CSV export |
| **Integrations** | `src/campaign/integrations/{final-yes-sheet,google-sheets.client,contact-email}.ts` | FINAL_YES → Google Sheet, idempotent and non-throwing |
| **Readiness / audit** | `src/campaign/{preflight,production-readiness,external-limits,observability/campaign-audit}.ts`, `*-cli.ts` | Gate checks, the external-limits register, post-run audit |
| **Scripts** | `src/campaign/script/**` | 7 registered scripts, content hashing, variable validation, conversation policy |
| **Tests** | `src/campaign/tests/*.ts` (~950 KB) | 30+ standalone `tsx` suites |
| **API routes** | `src/app/api/**` | Campaign CRUD/control, session lifecycle, provider catalog, SSE events, voice webhooks |
| **UI** | `src/components/dashboard/*`, `src/components/campaign/*`, `src/components/ui/*`, `src/hooks/*` | Benchmark dashboard and campaign console |
| **Docs** | `CLAUDE.md`, `MEMORY.md`, `HANDOFF.md`, `docs/DECISIONS.md`, `docs/RUNBOOK.md`, `docs/phases/*` | Entry point, persistent truth, current state, decision log, operations |

### 23.2 The ten files to read first, in order

1. `MEMORY.md` — persistent project truth
2. `docs/DECISIONS.md` — why things are the way they are (D-01 … D-10)
3. `docs/RUNBOOK.md` — commands, env, safe run procedure
4. `server.ts` — how the process starts and how a WebSocket gets in
5. `src/core/session/voice-session-manager.impl.ts` — the session lifecycle
6. `src/core/session/conversation-pipeline.ts` — **the file**; read the header,
   then the constants block (lines ~285–1100), then `run()`
7. `src/core/session/turn-detection.ts` — every window and grace, with reasons
8. `src/server/vobiz-media-bridge.ts` — the live transport
9. `src/campaign/dispatch/call-runner.ts` — one campaign call end-to-end
10. `src/campaign/outcome/classifier.ts` — what a call meant

---
<div class="page-break"></div>

## 24. Getting started for a new engineer

### 24.1 Local setup

```bash
git clone <repo>
cd voice-agent-lab
npm install                 # Node >= 20

# Create .env.local. You need at minimum:
#   DATABASE_URL, APP_PUBLIC_BASE_URL
#   DEEPGRAM_API_KEY, OPENAI_API_KEY
#   at least one TTS provider's key + voice id
#   CAMPAIGN_DIALING_ENABLED=false        <-- start here
# Providers whose vars are absent simply do not register.

npm run db:migrate
npm run db:verify
npm run dev                 # http://localhost:3000
```

The dashboard renders with **zero** providers registered — `src/lib/mock/`
supplies a catalog and a simulated session, so the UI is explorable before any
credential exists.

### 24.2 Understanding a live call without dialling

1. `npm run test:barge-in` — the suite reproduces the pilot defects through the
   real pipeline.
2. `npm run test:attention` — the "Hello? Hello? Hello?" flow end to end.
3. `npm run test:wire-trace` — real Deepgram wire captures: clean line vs noise
   vs background voice.
4. Read the log prefixes in those runs: `[PIPELINE:…]`, `[TURN:…]`,
   `[PLAYBACK:…]`, `[TIMING:…]`, `[SPECULATE:…]`. They are the same lines
   production emits.

### 24.3 Making your first change safely

1. **Find the block comment** above the code you want to change. It usually
   names the defect the current shape exists to prevent.
2. **Check §22** — if your change touches turn detection, endpointing,
   barge-in, self-echo, silence recovery, the commit anchors or the load
   guardrails, expect the change to be adversarial.
3. **Identify the suite that owns it** (§19.2) and run it **before** your
   change, so you know its baseline. Several suites have known pre-existing
   failures (§21.3).
4. Make the change. Keep the house style: named exports, `readonly` fields,
   barrel files, env through `providers/shared/env`, and a "why" comment.
5. `npx tsc --noEmit --incremental false`
6. Re-run the owning suite **plus** its neighbours — barge-in, continuity,
   attention and buffered-turn are tightly coupled. Run them **one at a time**.
7. Update `HANDOFF.md`.

### 24.4 A mental model that will save you time

Three ideas explain most of the surprising code in this repository:

1. **Everything the microphone hears is not the caller.** One mixed mono
   telephony channel carries the caller, the room, the television, and our own
   audio echoing out of their earpiece. Every filter in §11 exists to answer
   *"was that actually the person we are talking to?"*, and each one is
   deliberately conservative in a specific direction.

2. **A transcript is late, and a claim about it may be later still.** Deepgram's
   words arrive 0.4–1.7 s after they were spoken, and its *endpoint claim* can
   arrive in a separate message after that — or never, on a noisy line. Every
   clock in the pipeline exists because two timestamps that look comparable are
   measured from different origins.

3. **What was heard is not what was generated.** Streaming TTS hands the whole
   reply to the transport far faster than real time, so "the assistant said X"
   is only true of the part that reached the play head. `heardSoFarText()`,
   `cancelledHeardText`, `unspokenTail()` and `spokenUtterances` all exist to
   keep memory, the classifier and the Google Sheet honest about that
   difference.

### 24.5 Where to ask

- **"Why is this constant this number?"** → the block comment above it. Almost
  every one records the measurement.
- **"Why is it built this way?"** → `docs/DECISIONS.md`.
- **"What was happening last?"** → `HANDOFF.md` (top section).
- **"What must not change?"** → `MEMORY.md` §6 and §22 of this document.
- **"How do I run a campaign safely?"** → `docs/RUNBOOK.md`.

---

## Appendix A — Facts that could not be established from the repository

These are stated as **"Not confirmed from repository"** in the body above and
collected here for convenience.

| Topic | Status |
|---|---|
| Render region, plan, CPU, memory | Not confirmed from repository. No deployment manifest is committed and no `RENDER_*` env var is read anywhere in `src/`. |
| CI/CD pipeline | Not confirmed from repository. No `.github/workflows` directory exists. |
| Whether the Render service runs a single instance | Not confirmed from repository. Session correlation requires the answer webhook and the media WebSocket to reach the process that owns the in-memory session. |
| Contracted vendor rates | Not confirmed from repository. `cost-estimator.ts` explicitly labels its telephony rates as list-price placeholders and its Gemma rate as unverified. |
| Legal / consent handling for call recording | Not confirmed from repository. Every answered Vobiz call is recorded with no per-campaign or per-contact gate. |
| Vobiz DID pool / per-DID daily limit | Not confirmed from repository — recorded as an external blocker (D-06). |
| Whether recordings are retained, and for how long, on the Vobiz side | Not confirmed from repository. |
| Current live values of `.env.local` limits | Deliberately not inspected or reproduced. Only variable **names** appear in this document. |
| Live re-verification of the test results in §19.3 | Not performed. The figures are as recorded in `HANDOFF.md` at HEAD. |

---

*End of document.*
