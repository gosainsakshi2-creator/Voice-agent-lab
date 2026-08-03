# Phase 1 — VoiceSessionManager Orchestration

This adds the complete `VoiceSessionManager` implementation on top of the
existing architecture, per your brief: **no folders renamed, no interfaces
renamed, no Dashboard changes, no Provider Layer concrete-class changes, no
API routes, no webhooks.**

## What was added

```
src/types/streaming.types.ts                 (new, additive types)
src/interfaces/providers/*.ts                (4 files — additive optional members only)
src/core/session/                            (new — the VoiceSessionManager implementation)
  ├── voice-session-manager.impl.ts          DefaultVoiceSessionManager (implements VoiceSessionManager exactly)
  ├── conversation-pipeline.ts               LISTENING→THINKING→SPEAKING streaming pipeline
  ├── conversation-memory.ts                 turn history, entities, preferences, repeat-question guard
  ├── language-detector.ts                   per-turn EN / HI / Hinglish detection
  ├── turn-detection.ts                      adaptive silence-timeout endpointing
  ├── barge-in-controller.ts                 cancellation signals for immediate interruption
  ├── metrics-collector.ts                   per-turn latency + BenchmarkMetrics assembly
  ├── cost-estimator.ts                      per-vendor cost heuristics
  ├── system-prompt.ts                       human-like-response + language-switching system prompt
  ├── session-record.ts                      internal per-session state container
  ├── error-recovery.ts                      graceful retry/degrade, never crashes the session
  ├── async-queue.ts / abort-utils.ts / audio-utils.ts / sentence-chunker.ts   (small utilities)
  └── index.ts
src/index.ts                                  +1 line: barrel-exports core/session
src/types/index.ts                            +1 line: barrel-exports streaming.types
```

## The one real architectural conflict, and how it was resolved

The four provider interfaces state explicitly, in their own doc comments,
that streaming is **out of scope for this architecture pass** — `transcribe`,
`generateCompletion`, and `synthesize` are all `Promise<FullResult>`. The
concrete `DeepgramSpeechToTextProvider` backs this up: it calls Deepgram's
*batch* endpoint specifically for this reason.

Your brief asks for real streaming STT/LLM/TTS, full duplex, and barge-in —
none of which a `Promise<FullResult>` contract can express, no matter how
the orchestrator is written.

Per your instruction, each provider interface got **exactly one additive,
optional member** appended (nothing renamed or removed):

| Interface | New optional member |
|---|---|
| `SpeechToTextProvider` | `transcribeStream?(...)` |
| `LanguageModelProvider` | `generateCompletionStream?(...)` |
| `TextToSpeechProvider` | `synthesizeStream?(...)` |
| `TelephonyProvider` | `openMediaStream?(...)` |

None of the concrete provider classes (Plivo/Deepgram/OpenAI/Gemma/ElevenLabs/
Cartesia/Sarvam/Smallest AI) were touched — they remain exactly as valid as
before, since the new members are optional. `DefaultVoiceSessionManager`
feature-detects each one at runtime (`if (provider.transcribeStream)`) and
gets genuine chunk/token-level streaming, sentence-level LLM→TTS overlap, and
real barge-in cancellation wherever a provider implements it — and falls
back to correct (if less latency-optimal) whole-turn request/response
orchestration wherever a provider doesn't. Both modes were verified to work
end-to-end (see "Verification" below).

## Extra, non-interface capabilities

`DefaultVoiceSessionManager` implements `VoiceSessionManager` exactly as
specified — the Dashboard's view of it is unchanged. It also exposes three
extra public methods that are **not** part of `VoiceSessionManager` and are
therefore invisible to anything typed against that interface:

- `pushInboundAudio(sessionId, chunk)` — feeds inbound audio when a
  telephony provider has no `openMediaStream` yet (true today for Plivo).
  A future webhook/media-bridge layer would call this as real audio arrives.
- `onOutboundAudio(sessionId, listener)` — subscribe to synthesized audio as
  it's produced.
- `signalBargeIn(sessionId)` — manually trigger barge-in, for a transport
  that detects speech-onset faster than STT can confirm it, or for tests.

These exist so real-time audio has a concrete place to plug in later without
another architecture change, while keeping today's public contract untouched.

## Verification

A standalone smoke test (not part of this delivery) exercised
`DefaultVoiceSessionManager` against two fake provider stacks — one with no
streaming members (mirroring today's real Provider Layer exactly) and one
with all four streaming members implemented — and confirmed:

- Full lifecycle (create → warm-up → start → converse → end) transitions
  exactly along `SESSION_STATE_TRANSITIONS`.
- Adaptive silence-based turn detection.
- Streaming LLM tokens overlapping with sentence-level TTS synthesis (the
  assistant starts speaking sentence 1 while sentence 2 is still generating).
- Barge-in: TTS stops immediately, state returns to LISTENING instantly, and
  the interrupting utterance is not lost.
- Turn-by-turn language detection switching to Hinglish mid-call.
- `getBenchmarkMetrics` populated with real per-turn latency/cost data.

`npx tsc --noEmit` passes cleanly (the only pre-existing notice is an
unrelated `tsconfig.json` `baseUrl` deprecation warning from the TypeScript
version installed, present before any of these changes).

## Deliberately not done here (per your Phase 1 scope)

- No API routes, no Plivo answer/media webhooks, no Dashboard/UI changes.
- No changes to any concrete Provider Layer class.
- The turn detector's default 700ms silence timeout is a sensible starting
  point, not a tuned production value — it adapts per-call but the initial
  constant is worth revisiting once real call audio is available.

## Addendum — Phase 1 review findings (fixed)

During final review, two real issues were found and corrected — both
internal to the new orchestration code, with zero change to any interface,
contract, or existing file beyond what's already listed above:

1. **`conversation-pipeline.ts`** — the call site was passing
   `detected.language` (just the `SupportedLanguage` value) into
   `runThinkingAndSpeaking`, which expects the full `LanguageDetectionResult`
   object (it reads `.language` off of it internally). This meant the
   per-turn language hint sent to the Language Model would have been
   `undefined` in production. Fixed by passing `detected` directly.
2. **`error-recovery.ts`** — `RecoverableTurnError`'s `cause` constructor
   parameter needed an `override` modifier (it shadows `Error.cause` under
   `noImplicitOverride`).

Both were masked from `tsc --noEmit` by a **stale, pre-existing
`tsconfig.tsbuildinfo`** incremental-build cache file that shipped inside the
original uploaded project (dated before any Phase 1 work began). Once that
cache was deleted and typechecking was re-run cold, both errors surfaced
immediately and were fixed. `npm run build` was not runnable at all during
implementation for an unrelated reason — the vendored `node_modules`
included only a `lightningcss` Windows native binding, not the Linux one
this sandbox needs — until `npm install lightningcss` pulled the correct
platform binary in as part of this review. Neither of these was a defect in
the code delivered; both are now confirmed clean from a fully cold cache.
