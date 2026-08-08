# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Voice Agent Lab — a benchmarking platform for real-time telephony voice agents. A Next.js dashboard places a real phone call, runs a full STT → LLM → TTS conversation loop over the call's audio, and records per-turn latency/cost so different provider stacks can be compared. Any telephony/STT/LLM/TTS vendor is swappable by id at session-creation time.

## Commands

```bash
npm run dev        # tsx server.ts — the ONLY correct way to run locally (see "Custom server")
npm run typecheck  # tsc --noEmit — the real correctness gate in this repo
npm run build      # next build
npm run start      # NODE_ENV=production tsx server.ts
PORT=4000 npm run dev
```

- **No test suite and no ESLint config exist.** `npm run lint` (`next lint`) is a leftover script and is not usable on Next 16. `npm run typecheck` is what to run after every change; the code is written against a very strict tsconfig (see below), so typecheck catches most real mistakes.
- **Never use `next dev` / `next start`.** They cannot terminate the WebSocket upgrade the telephony media stream needs.
- If `typecheck` looks suspiciously clean after edits, delete `tsconfig.tsbuildinfo` and rerun — a stale incremental cache has previously masked genuine errors in this repo.

### Local prerequisites for a real call

`.env.local` is gitignored and there is **no `.env.example`** (several file comments reference one that does not exist; `src/types/env.types.ts` is the closest thing to an authoritative list, though it is itself missing `VOBIZ_*` and `APP_PUBLIC_BASE_URL`). A live call additionally needs `APP_PUBLIC_BASE_URL` set to a publicly reachable https tunnel — the telephony vendor fetches the answer webhook and dials back a `wss://` media stream against it, so localhost cannot work.

## Strict TypeScript conventions

`exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are on. Two consequences that pervade the codebase and must be matched:

- Optional properties are added conditionally by spread, never assigned `undefined`:
  `...(x !== undefined ? { x } : {})`
- Indexed access yields `T | undefined`; existing code uses `?.`, `!`, or explicit guards.

Path alias `@/*` → `src/*` (used by UI code; server/core code mostly uses relative imports).

## Architecture

Strict one-directional layering. The dependency rule is the point of the whole design — do not shortcut it.

```
Dashboard (React)  →  /api/** routes  →  getRuntime()  →  VoiceSessionManager  →  ProviderRegistry  →  4 provider interfaces
                                                                                                        ↑ concrete vendor adapters
```

- `src/interfaces/` — behavioral contracts. `src/types/` — data shapes. `src/constants/` — closed sets of legal values. Nothing in `src/core/` or the dashboard ever imports a concrete provider class or a vendor SDK.
- `src/providers/registry/bootstrap.ts` is the single place where vendor adapters are named. It is **env-gated**: a provider whose required env vars are absent is simply not registered (a warning is logged at startup), so the dashboard's provider catalog and `createSession` reflect only what is actually configured. A missing id surfaces as `ProviderNotFoundError` from `createSession`, not later.
- `src/server/runtime.ts` — process-wide singleton (`registry` + `manager`) stashed on `globalThis` so Next's dev-mode module reloading cannot orphan an in-flight call. Every API route and the WebSocket bridge must obtain both via `getRuntime()`; never construct a registry or manager anywhere else.

### Custom server (`server.ts`)

Next App Router routes cannot hold a WebSocket open, but telephony media streams *are* WebSockets. `server.ts` delegates all HTTP to Next and handles exactly two upgrade paths, dispatched through a `bridgeForPath` map:

- `/api/voice/plivo/stream?sessionId=…` → `attachPlivoMediaBridge`
- `/api/voice/vobiz/stream?sessionId=…` → `attachVobizMediaBridge`

Adding a third telephony vendor means one more entry in that map plus one more bridge module — nothing else in the server changes.

### End-to-end call flow (outbound, Plivo)

1. Dashboard → `POST /api/sessions` → `POST /api/sessions/[id]/warmup` → `POST /api/sessions/[id]/start` (`src/hooks/use-live-session.ts` drives this).
2. `warmUpProviders` health-checks all four providers concurrently; any unhealthy one sends the session to `ERROR` instead of `READY`.
3. `start()` → `PlivoTelephonyProvider.startCall()` places the call via REST. That only confirms the call was *placed* — the phone is still ringing, so the pipeline is **not** started here.
4. `src/server/pending-call.ts` correlates "the session that just called start()" with "the next answer webhook", via a single-slot FIFO plus a CallUUID map (the dashboard only runs one call at a time). The start route registers the pending session *before* calling `start()`.
5. Vendor POSTs/GETs the answer webhook (`src/app/api/voice/plivo/answer/route.ts`) → claims the pending session → replies with `<Stream>` XML pointing at the `wss://` path with `?sessionId=`.
6. Vendor opens the media stream WebSocket → `server.ts` upgrades it → bridge attaches.
7. The bridge's `start` event calls `manager.confirmCallAnswered(sessionId)` — *this* is what moves `CALLING → LISTENING` and constructs the `ConversationPipeline`.
8. Socket close (including a remote hangup, which has no other webhook) calls `manager.end()`, so the state machine and the dashboard's SSE stream always learn the call is over.

The dashboard receives live state via SSE at `/api/sessions/[id]/events`, which pushes `{session, transcript, metrics}` on every state transition plus a 15s heartbeat.

### Session state machine

`SESSION_STATE_TRANSITIONS` (`src/constants/session-states.constants.ts`) is the single source of truth, as data. `DefaultVoiceSessionManager.transition()` throws `InvalidSessionStateTransitionError` on any illegal move, so **adding a new control-flow path usually requires adding the edge to that table first** (e.g. `THINKING → LISTENING` exists only to allow error recovery mid-turn). `WARMING_PROVIDERS` is deliberately its own state so warm-up latency is separately observable in the transition history.

### ConversationPipeline (`src/core/session/conversation-pipeline.ts`)

Owns one session's `LISTENING → THINKING → SPEAKING` loop, and is the largest, most subtle file in the repo.

- **Capability feature-detection, not branching by vendor.** The four provider interfaces each carry one *optional* streaming member (`transcribeStream?`, `generateCompletionStream?`, `synthesizeStream?`, `openMediaStream?`). The pipeline checks for each at runtime and degrades to whole-turn request/response when absent. Never add a vendor-specific `if` here; add or implement an optional interface member instead.
- Streaming path: one continuous STT connection for the whole call, with turn boundaries from `AdaptiveTurnDetector` (adapts its silence timeout to the speaker, 250–1200ms). Non-streaming path: each acquired `AudioPayload` is treated as one complete turn.
- LLM token deltas are sentence-chunked (`SentenceChunker`) so TTS on sentence 1 overlaps generation of sentence 2.
- **Barge-in:** a transcript segment arriving while state is `SPEAKING` triggers `BargeInController`, which aborts in-flight LLM/TTS and returns to `LISTENING` without losing the interrupting utterance. The bridge distinguishes barge-in from normal turn completion by pattern-matching `transition.reason` — on barge-in it flushes its queue and sends `clearAudio`; on normal completion it lets the pump drain, or the tail of every utterance gets cut.
- The pipeline opens with a greeting phase that injects a synthetic user turn. LLM output is markdown-stripped and screened by `isContaminatedOutput` (prompt echo); contaminated or failed output falls back to a fixed greeting rather than being spoken.
- Errors are classified: `RecoverableTurnError` recovers to `LISTENING` and continues the loop; anything else calls `markError` and ends the session.

### Audio format contract

The one place vendor-fixed formats meet vendor-neutral types, and historically the source of the nastiest bugs — read the comments in `src/server/audio-codec.ts` and the bridges before touching audio.

- Inbound from telephony: G.711 μ-law, 8 kHz mono, 20 ms / 160-byte frames.
- Outbound from TTS providers: `PCM_16` at each provider's own configured sample rate. The bridge resamples + μ-law-encodes, with a seam crossfade because each streamed TTS chunk is resampled in isolation.
- Outbound frames are paced by a 20 ms `setInterval` pump with drift correction capped at 3 frames/tick, so event-loop starvation cannot burst-flood the vendor's playback buffer.
- **`playAudio` events must use a bare `contentType: "audio/x-mulaw"`** with the rate in the separate `sampleRate` field. The `;rate=8000` form is valid *only* on the `<Stream>` XML attribute; putting it in the JSON event makes the vendor fall back to L16 and reinterpret μ-law bytes as PCM — the classic "loud crackly voice that still has the rhythm of speech" symptom.
- ElevenLabs streaming needs raw HTTP chunks re-accumulated to even byte lengths; an odd-length yield splits a PCM_16 sample and shifts every subsequent one.
- Inbound handling currently differs by bridge: the **Vobiz** bridge feeds frames through `MulawVadSegmenter` (energy-based VAD → utterance chunks), while the **Plivo** bridge pushes raw frames straight to `pushInboundAudio` (its segmenter instance is left unused on the media path) because Deepgram's live socket does its own endpointing. Keep this in mind before "fixing" one bridge to match the other.

### Manager methods outside the interface

`DefaultVoiceSessionManager` implements `VoiceSessionManager` exactly, plus four additive members that are invisible to anything typed against the interface (the dashboard) and exist so transports can plug in without changing the architecture: `pushInboundAudio`, `onOutboundAudio`, `signalBargeIn`, `confirmCallAnswered`, and the read-only `getTranscript`.

## Adding a provider

1. Add the id to the relevant map in `src/constants/providers.constants.ts`.
2. Write the adapter in `src/providers/<category>/`, implementing the existing interface (plus its optional streaming member if the vendor supports it). Read config through `src/providers/shared/env.ts` helpers only.
3. Add one `registerIfConfigured(...)` entry in `src/providers/registry/bootstrap.ts` listing its required env vars.
4. Add the env keys to `src/types/env.types.ts`.

Nothing in `VoiceSessionManager`, the pipeline, the API routes, or the dashboard should need to change.

## Known rough edges

- `README.md` and `PHASE1_VOICE_SESSION_MANAGER_NOTES.md` describe earlier phases and are **stale**: the README claims there is no UI, no SDK integration, no API routes and no streaming code; all four now exist. The layering rules and the "why this scales" reasoning in the README are still accurate and worth honoring.
- The dashboard still falls back to `src/lib/mock/**` descriptors when `/api/providers` hasn't loaded or lacks an id, so a UI showing providers is not proof that any are actually registered. `src/hooks/use-simulated-session.ts` is the unused mock counterpart to `use-live-session.ts`.
- The code is instrumented with very verbose tagged `console.log` lines (`[plivo-bridge:…]`, `[PIPELINE:…]`, `[session-mgr:…]`, `[STT:deepgram]`) — this is deliberate call-debugging infrastructure, not leftover cruft. Match the existing tag style when adding logs.
