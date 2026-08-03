# Voice Agent Lab — Core Architecture

This package contains **only** the core architecture for Voice Agent Lab: shared
types, provider interfaces, the Provider Registry contract, the Voice Session
Manager contract, constants, enums, environment typing, and a structured error
hierarchy.

There is intentionally **no UI, no provider SDK integration, no API routes, no
streaming/WebSocket code, and no business logic**. Every provider method is a
contract (an interface), not an implementation.

## Folder Structure

```
voice-agent-lab/
├── package.json
├── tsconfig.json
├── README.md
└── src/
    ├── index.ts                                 # root barrel export
    │
    ├── types/                                   # pure data shapes
    │   ├── enums.ts                              # SessionState (incl. WARMING_PROVIDERS),
    │   │                                          # ProviderCategory, SupportedLanguage,
    │   │                                          # CallDirection, ErrorSeverity,
    │   │                                          # RuntimeEnvironment
    │   ├── provider.types.ts                     # ProviderIdentifier, ProviderDescriptor,
    │   │                                          # AudioPayload, TranscriptSegment,
    │   │                                          # ConversationTurn, SynthesisRequest...
    │   ├── session.types.ts                      # SessionId, ProviderStackSelection,
    │   │                                          # SessionCreationRequest, SessionSnapshot,
    │   │                                          # ProviderWarmupStatus, SessionWarmupResult...
    │   ├── benchmark.types.ts                    # SttLatencyMetric, LlmLatencyMetric,
    │   │                                          # TtsLatencyMetric, TotalLatencyMetric,
    │   │                                          # CallDurationMetric, EstimatedCostMetric,
    │   │                                          # TurnLatencyBreakdown, BenchmarkMetrics
    │   ├── config.types.ts                       # AppConfig, ProviderConfigEntry,
    │   │                                          # ProviderStackPreset...
    │   ├── env.types.ts                          # VoiceAgentLabEnv + ProcessEnv augmentation
    │   └── index.ts
    │
    ├── interfaces/                               # behavioral contracts (no impl)
    │   ├── providers/
    │   │   ├── telephony-provider.interface.ts    # TelephonyProvider
    │   │   ├── speech-to-text-provider.interface.ts # SpeechToTextProvider
    │   │   ├── language-model-provider.interface.ts # LanguageModelProvider
    │   │   ├── text-to-speech-provider.interface.ts # TextToSpeechProvider
    │   │   └── index.ts
    │   ├── provider-registry.interface.ts         # ProviderRegistry
    │   ├── voice-session-manager.interface.ts     # VoiceSessionManager
    │   └── index.ts
    │
    ├── constants/                                 # locked, closed-set data
    │   ├── providers.constants.ts                 # locked provider ids
    │   │                                           # (Plivo, Deepgram, GPT-5.1,
    │   │                                           #  Gemma 4, ElevenLabs, Cartesia,
    │   │                                           #  Sarvam, Smallest AI)
    │   ├── languages.constants.ts                 # en / hi / hi-en metadata
    │   ├── session-states.constants.ts            # the state-machine transition graph
    │   └── index.ts
    │
    ├── config/                                    # configuration SHAPES + presets
    │   ├── app.config.ts                          # AppConfig skeleton (reference only)
    │   ├── provider.config.ts                     # example ProviderStackPreset data
    │   └── index.ts
    │
    └── core/
        └── errors/
            ├── voice-agent.error.ts               # VoiceAgentError hierarchy
            └── index.ts
```

## Lifecycle (updated)

```
Idle → Initializing → WarmingProviders → Ready → Calling → Listening
  ↕                                                  ↕         ↕
 Error ←──────────────────────────────────────── Thinking ↔ Speaking → Ending → Idle
```

`WARMING_PROVIDERS` sits between `INITIALIZING` and `READY`. It is the phase
in which `VoiceSessionManager.warmUpProviders` asks the `ProviderRegistry` to
pre-warm every provider in the session's `ProviderStackSelection` (connections,
model priming, etc.) before the session is allowed to become `READY`. The
outcome — including per-provider health — is captured in `SessionWarmupResult`
/ `ProviderWarmupStatus` (`types/session.types.ts`) and retrievable via
`VoiceSessionManager.getWarmupResult`. This keeps warm-up latency separately
observable in `SessionStateTransition` history, feeding directly into
benchmark metrics rather than being hidden inside `INITIALIZING`.

## Benchmark Metrics

`types/benchmark.types.ts` defines the shared, provider-agnostic metric shapes
the platform exists to produce — STT / LLM / TTS / total per-turn latency
(`SttLatencyMetric`, `LlmLatencyMetric`, `TtsLatencyMetric`,
`TotalLatencyMetric`), call duration (`CallDurationMetric`), estimated cost
(`EstimatedCostMetric`), and the aggregate `BenchmarkMetrics` record, which
ties every measurement back to the `ProviderStackSelection` and `timestamp`
under test. `VoiceSessionManager.getBenchmarkMetrics` exposes this to the
Dashboard — no implementation, measurement, or persistence logic is included.

## Architectural Flow

```
Dashboard
   │  (SessionCreationRequest, sessionId)
   ▼
VoiceSessionManager           <-- the ONLY thing the Dashboard is allowed to call
   │  (ProviderCategory, ProviderIdentifier)
   ▼
ProviderRegistry              <-- resolves an id to a concrete implementation
   │
   ├──► TelephonyProvider       (Plivo)
   ├──► SpeechToTextProvider    (Deepgram)
   ├──► LanguageModelProvider   (GPT-5.1 / Gemma 4)
   └──► TextToSpeechProvider    (ElevenLabs / Cartesia / Sarvam / Smallest AI)
```

The Dashboard depends on `VoiceSessionManager` only. `VoiceSessionManager`
depends on `ProviderRegistry` and the four provider interfaces — never on a
concrete vendor SDK. Concrete provider classes (e.g. `PlivoTelephonyProvider`)
would live in a separate, not-yet-built implementation package and are
registered into the `ProviderRegistry` at bootstrap.

## Why This Scales

**1. Provider swaps are data changes, not code changes.**
`ProviderStackSelection` is composed entirely of `ProviderIdentifier` values
(`{ category, id }`). Swapping ElevenLabs for Cartesia in a benchmark run means
choosing a different `id` — no call site in `VoiceSessionManager`, and no line
in the Dashboard, needs to change. This is the Open/Closed Principle applied at
the platform level: the system is open to new providers, closed to
modification of orchestration logic.

**2. Single Responsibility per layer.**
- `types/` describes data.
- `interfaces/` describes behavior contracts.
- `constants/` describes closed, locked sets of valid values.
- `config/` describes how those constants compose into presets.
- `core/errors/` describes failure modes uniformly.

No file mixes these concerns, so a change to (say) the STT contract touches
exactly one file plus its barrel export.

**3. Dependency Inversion at the Provider Registry boundary.**
`VoiceSessionManager` depends on the abstractions
(`TelephonyProvider`, `SpeechToTextProvider`, `LanguageModelProvider`,
`TextToSpeechProvider`), never on concrete vendor packages. The
`ProviderRegistry` is the one place that knows how to turn an id into a real
instance, and even it only depends on interfaces for its return types.

**4. Interface Segregation.**
Each provider interface exposes only the operations relevant to its category
(`startCall`/`endCall` for telephony, `transcribe` for STT, `generateCompletion`
for LLM, `synthesize` for TTS) plus a uniform `checkHealth`. A new provider
never has to stub out irrelevant methods.

**5. Liskov-safe substitution guaranteed by narrow contracts.**
Because every provider method returns normalized, vendor-neutral shapes
(`AudioPayload`, `TranscriptSegment`, `ConversationTurn`), any two
implementations of `TelephonyProvider` — or of any other provider interface —
are truly interchangeable from the `VoiceSessionManager`'s point of view.

**6. A declarative, auditable state machine.**
`SESSION_STATE_TRANSITIONS` is a plain data table, not a chain of `if`
statements buried in a manager class. It can be unit-tested exhaustively,
rendered as a diagram for the Dashboard, and referenced by both
`VoiceSessionManager.canTransition` and future analytics tooling without
duplication.

**7. Environment and configuration are typed, not stringly-typed.**
`VoiceAgentLabEnv` augments `NodeJS.ProcessEnv` globally, so every access to
`process.env.DEEPGRAM_API_KEY` (for example) is checked at compile time across
the whole codebase — new engineers can't typo an env var name and fail silently
in production.

**8. Ready for horizontal growth.**
Adding a fifth TTS vendor, a third LLM, or a new language requires:
- one new id constant,
- one new provider implementation (out of scope here) satisfying an existing
  interface,
- one registration call at bootstrap.

Nothing in `VoiceSessionManager`, the Dashboard, or any other provider's code
needs to be touched — the hallmark of an architecture that scales with the
number of providers rather than the complexity of orchestration logic.
