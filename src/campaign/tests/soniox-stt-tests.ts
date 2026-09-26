/**
 * soniox-stt-tests.ts — `npm run test:soniox`
 *
 * Soniox real-time STT adapter. Every case runs against a MOCK socket:
 * no Soniox key, no network, no call, no vendor request.
 *
 * The properties that matter are not "does it parse JSON" but:
 *
 *   - Deepgram remains the default and Soniox is unreachable unless
 *     someone asks for it by id with a key configured;
 *   - Soniox's `<end>` token becomes this codebase's PROVIDER-NEUTRAL
 *     end-of-speech marker, and a Soniox word-final is explicitly NOT
 *     an endpoint claim (which is where a Deepgram assumption would
 *     have leaked in);
 *   - mu-law 8 kHz is forwarded byte-for-byte, and anything else is
 *     refused rather than silently transcoded;
 *   - a missing key makes the provider UNHEALTHY, never a crash that
 *     would take the Deepgram registration down with it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const {
  SonioxSpeechToTextProvider,
  segmentsFromSonioxMessage,
  loadSonioxEnvConfig,
  SONIOX_REALTIME_URL,
  SONIOX_DEFAULT_MODEL,
  SONIOX_AUDIO_FORMAT,
  SONIOX_SAMPLE_RATE_HZ,
  SONIOX_END_TOKEN,
  SONIOX_DEFAULT_MAX_ENDPOINT_DELAY_MS,
  SONIOX_DEFAULT_LATENCY_ADJUSTMENT_LEVEL,
  SONIOX_DEFAULT_ENDPOINT_SENSITIVITY,
  SONIOX_DEFAULT_LANGUAGE_HINTS_STRICT,
  SONIOX_CONTEXT,
  sonioxLanguageHints,
} = await import("../../providers/speech-to-text/soniox.provider");
const { bootstrapProviderRegistry } = await import("../../providers/registry/bootstrap");
const { resolveCallProviderStack, resolveSttProviderId, STT_PROVIDER_OVERRIDE_ENV } =
  await import("../../campaign/dispatch/call-runner");
const { SPEECH_TO_TEXT_PROVIDER_IDS } = await import("../../constants/providers.constants");
const { ProviderCategory, SupportedLanguage } = await import("../../types/enums");
const { SessionMetricsCollector } = await import("../../core/session/metrics-collector");
const { ConfigurationError } = await import("../../core/errors");
const { CAMPAIGN_STT_PROVIDERS, DEFAULT_CAMPAIGN_STT_PROVIDER, isCampaignSttProvider } =
  await import("../domain/campaign-types");

import type { SonioxSocketLike } from "../../providers/speech-to-text/soniox.provider";
import type { AudioPayload, TranscriptSegment } from "../../types/provider.types";
import type { ProviderStackSelection, SessionId } from "../../types/session.types";

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  [FAIL] ${name}`);
    console.log(
      `         ${(error instanceof Error ? error.message : String(error)).split("\n").slice(0, 8).join("\n         ")}`,
    );
  }
}
const section = (t: string) => console.log(`\n${t}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function withEnv(
  vars: Readonly<Record<string, string | undefined>>,
  fn: () => void | Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    previous.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of previous) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ── Mock socket ──────────────────────────────────────────────────────
class MockSocket implements SonioxSocketLike {
  readyState = 1;
  readonly sentText: string[] = [];
  readonly sentBinary: Uint8Array[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  private readonly handlers = new Map<string, Array<(arg: unknown) => void>>();

  send(data: string | Uint8Array): void {
    if (typeof data === "string") this.sentText.push(data);
    else this.sentBinary.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closeCalls.push({ ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) });
    this.readyState = 3;
  }
  on(event: string, listener: (...args: unknown[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(listener as (arg: unknown) => void);
    this.handlers.set(event, list);
  }
  emit(event: string, arg?: unknown): void {
    for (const h of this.handlers.get(event) ?? []) h(arg);
  }
  /** Deliver a Soniox result frame. */
  deliver(message: unknown): void {
    this.emit("message", JSON.stringify(message));
  }
  get config(): Record<string, unknown> | undefined {
    const first = this.sentText[0];
    return first ? (JSON.parse(first) as Record<string, unknown>) : undefined;
  }
}

const frame = (n = 160): AudioPayload => ({
  data: new Uint8Array(n),
  encoding: "MULAW",
  sampleRateHz: 8000,
});

function streamOf(
  provider: InstanceType<typeof SonioxSpeechToTextProvider>,
  audio: AsyncIterable<AudioPayload>,
  signal?: AbortSignal,
): { segments: TranscriptSegment[]; done: Promise<void> } {
  const segments: TranscriptSegment[] = [];
  const done = (async () => {
    for await (const s of provider.transcribeStream({
      sessionId: "soniox-test" as SessionId,
      audio,
      language: SupportedLanguage.ENGLISH,
      ...(signal ? { signal } : {}),
    })) {
      segments.push(s);
    }
  })();
  return { segments, done };
}

/** Audio source that stays open until released, so the socket stays live. */
function heldAudio() {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const iterable = (async function* () {
    yield frame();
    await gate;
  })();
  return { iterable, release: () => release() };
}

const CONFIGURED = {
  apiKey: "test-key-never-real",
  model: SONIOX_DEFAULT_MODEL,
  enableEndpointDetection: true,
  languageHintsStrict: SONIOX_DEFAULT_LANGUAGE_HINTS_STRICT,
  maxEndpointDelayMs: SONIOX_DEFAULT_MAX_ENDPOINT_DELAY_MS,
  endpointLatencyAdjustmentLevel: SONIOX_DEFAULT_LATENCY_ADJUSTMENT_LEVEL,
  endpointSensitivity: SONIOX_DEFAULT_ENDPOINT_SENSITIVITY,
};

// ═════════════════════════════════════════════════════════════════
section("A. Construction, configuration, health");

await test("1. provider construction exposes the expected descriptor", () => {
  const p = new SonioxSpeechToTextProvider(CONFIGURED, () => new MockSocket());
  assert.equal(p.descriptor.id, "soniox");
  assert.equal(p.descriptor.category, ProviderCategory.SPEECH_TO_TEXT);
  assert.equal(p.descriptor.displayName, "Soniox");
  assert.equal(p.descriptor.version, "stt-rt-v5");
});

await test("2. missing API key => UNHEALTHY, not a throw", async () => {
  const p = new SonioxSpeechToTextProvider({ ...CONFIGURED, apiKey: "" }, () => new MockSocket());
  const health = await p.checkHealth();
  assert.equal(health.isHealthy, false);
  assert.match(String(health.message), /missing_api_key/);
  // and the key must not be invented from somewhere else
  assert.ok(!String(health.message).includes("test-key"));
});

await test("2b. missing API key => transcribeStream rejects with ConfigurationError", async () => {
  const p = new SonioxSpeechToTextProvider({ ...CONFIGURED, apiKey: "" }, () => new MockSocket());
  await assert.rejects(
    async () => {
      for await (const _s of p.transcribeStream({
        sessionId: "s" as SessionId,
        audio: (async function* () { yield frame(); })(),
        language: SupportedLanguage.ENGLISH,
      })) { void _s; }
    },
    ConfigurationError,
  );
});

await test("3. configuration validation: env defaults are the documented ones", async () => {
  await withEnv({ SONIOX_API_KEY: undefined, SONIOX_MODEL: undefined }, () => {
    const c = loadSonioxEnvConfig();
    assert.equal(c.apiKey, "", "absent key must read as empty, never throw");
    assert.equal(c.model, "stt-rt-v5");
    assert.equal(c.enableEndpointDetection, true);
  });
  await withEnv({ SONIOX_API_KEY: "k", SONIOX_MODEL: "stt-rt-v5-preview" }, () => {
    assert.equal(loadSonioxEnvConfig().model, "stt-rt-v5-preview");
  });
});

await test("3b. the config frame carries the documented fields and the mu-law format", async () => {
  const sock = new MockSocket();
  const p = new SonioxSpeechToTextProvider(CONFIGURED, () => sock);
  const held = heldAudio();
  const run = streamOf(p, held.iterable);
  sock.emit("open");
  await sleep(10);
  const cfg = sock.config;
  assert.ok(cfg, "a config frame must be sent first");
  assert.equal(cfg["model"], "stt-rt-v5");
  assert.equal(cfg["audio_format"], SONIOX_AUDIO_FORMAT);
  assert.equal(cfg["audio_format"], "mulaw");
  assert.equal(cfg["sample_rate"], SONIOX_SAMPLE_RATE_HZ);
  assert.equal(cfg["num_channels"], 1);
  assert.equal(cfg["enable_endpoint_detection"], true);
  assert.equal(cfg["api_key"], "test-key-never-real");
  held.release();
  await run.done;
});

await test("3c. the endpoint URL is the documented real-time one", () => {
  assert.equal(SONIOX_REALTIME_URL, "wss://stt-rt.soniox.com/transcribe-websocket");
});

// ═════════════════════════════════════════════════════════════════
section("A2. Low-latency endpoint configuration");

await test("L1. the config frame sends all three latency knobs explicitly", async () => {
  const sock = new MockSocket();
  const p = new SonioxSpeechToTextProvider(CONFIGURED, () => sock);
  const held = heldAudio();
  const run = streamOf(p, held.iterable);
  sock.emit("open");
  await sleep(10);
  const cfg = sock.config!;
  // Left unset, Soniox would apply 2000 / 0 / 0.0 — a two-second
  // endpoint wait against a Deepgram path configured at 400ms.
  assert.equal(cfg["max_endpoint_delay_ms"], 1500);
  assert.equal(cfg["endpoint_latency_adjustment_level"], 2);
  assert.equal(cfg["endpoint_sensitivity"], 0.3);
  held.release();
  await run.done;
});

await test("L2. defaults are the vendor's documented low-latency profile, not its defaults", async () => {
  await withEnv({
    SONIOX_API_KEY: "k",
    SONIOX_MAX_ENDPOINT_DELAY_MS: undefined,
    SONIOX_ENDPOINT_LATENCY_ADJUSTMENT_LEVEL: undefined,
    SONIOX_ENDPOINT_SENSITIVITY: undefined,
  }, () => {
    const c = loadSonioxEnvConfig();
    assert.equal(c.maxEndpointDelayMs, 1500, "vendor default is 2000 — we must not inherit it");
    assert.equal(c.endpointLatencyAdjustmentLevel, 2, "vendor default is 0");
    assert.equal(c.endpointSensitivity, 0.3, "vendor default is 0.0");
  });
});

await test("L3. each knob is overridable from the environment", async () => {
  await withEnv({
    SONIOX_API_KEY: "k",
    SONIOX_MAX_ENDPOINT_DELAY_MS: "800",
    SONIOX_ENDPOINT_LATENCY_ADJUSTMENT_LEVEL: "3",
    SONIOX_ENDPOINT_SENSITIVITY: "-0.5",
  }, () => {
    const c = loadSonioxEnvConfig();
    assert.equal(c.maxEndpointDelayMs, 800);
    assert.equal(c.endpointLatencyAdjustmentLevel, 3);
    assert.equal(c.endpointSensitivity, -0.5);
  });
});

await test("L4. out-of-range values are REFUSED, never clamped", async () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["SONIOX_MAX_ENDPOINT_DELAY_MS", "400"],
    ["SONIOX_MAX_ENDPOINT_DELAY_MS", "3001"],
    ["SONIOX_ENDPOINT_LATENCY_ADJUSTMENT_LEVEL", "4"],
    ["SONIOX_ENDPOINT_LATENCY_ADJUSTMENT_LEVEL", "-1"],
    ["SONIOX_ENDPOINT_SENSITIVITY", "1.5"],
    ["SONIOX_ENDPOINT_SENSITIVITY", "-2"],
  ];
  for (const [name, bad] of cases) {
    await withEnv({ SONIOX_API_KEY: "k", [name]: bad }, () => {
      assert.throws(() => loadSonioxEnvConfig(), ConfigurationError, `${name}=${bad} must be refused`);
    });
  }
});

await test("L5. a bad Soniox knob cannot break the DEEPGRAM registration", async () => {
  await withEnv({ SONIOX_API_KEY: "k", SONIOX_ENDPOINT_SENSITIVITY: "99" }, () => {
    const { outcomes, registry } = bootstrapProviderRegistry();
    const soniox = outcomes.find((x) => x.identifier.id === "soniox");
    assert.ok(soniox);
    assert.equal(soniox.registered, false, "the bad knob must leave soniox unregistered");
    assert.match(String(soniox.reason), /SONIOX_ENDPOINT_SENSITIVITY/);
    // ...and Deepgram must be entirely unaffected.
    const dg = outcomes.find((x) => x.identifier.id === "deepgram");
    assert.ok(dg);
    if (dg.registered) {
      assert.equal(registry.resolve(ProviderCategory.SPEECH_TO_TEXT, "deepgram").descriptor.id, "deepgram");
    }
  });
});

await test("L6. Deepgram's own latency config is NOT altered by any of this", () => {
  const dg = readFileSync("src/providers/speech-to-text/deepgram.provider.ts", "utf8");
  assert.ok(/utterance_end_ms:\s*"1000"/.test(dg), "utterance_end_ms must remain 1000");
  assert.ok(!/endpointing:\s*"(?!400)/.test(dg), "no hard-coded endpointing other than 400");
  assert.ok(/interim_results:\s*"true"/.test(dg), "interim_results must stay true (utterance_end_ms requires it)");
  assert.ok(!/no_delay/.test(dg), "no_delay must NOT have been introduced without measurement");
});

// ═════════════════════════════════════════════════════════════════
section("B. Registration and selection");

await test("4. provider registration requires SONIOX_API_KEY", async () => {
  await withEnv({ SONIOX_API_KEY: undefined }, () => {
    const { outcomes } = bootstrapProviderRegistry();
    const o = outcomes.find((x) => x.identifier.id === "soniox");
    assert.ok(o, "an outcome must be reported for soniox");
    assert.equal(o.registered, false);
    assert.match(String(o.reason), /SONIOX_API_KEY/);
  });
  await withEnv({ SONIOX_API_KEY: "test-key" }, () => {
    const { outcomes } = bootstrapProviderRegistry();
    const o = outcomes.find((x) => x.identifier.id === "soniox");
    assert.ok(o);
    assert.equal(o.registered, true, "with a key present it must register");
  });
});

await test("5. provider selection: resolvable by id only when configured", async () => {
  await withEnv({ SONIOX_API_KEY: "test-key" }, () => {
    const { registry } = bootstrapProviderRegistry();
    const p = registry.resolve(ProviderCategory.SPEECH_TO_TEXT, "soniox");
    assert.equal(p.descriptor.id, "soniox");
  });
  await withEnv({ SONIOX_API_KEY: undefined }, () => {
    const { registry } = bootstrapProviderRegistry();
    assert.throws(
      () => registry.resolve(ProviderCategory.SPEECH_TO_TEXT, "soniox"),
      /soniox|not found|not registered/i,
    );
  });
});

await test("15. DEFAULT STT provider remains Deepgram", async () => {
  await withEnv({ SONIOX_API_KEY: "test-key" }, () => {
    // Even with Soniox registered, the campaign's stack resolver still
    // returns the Deepgram literal it always has.
    const stack = resolveCallProviderStack(
      { id: "c", campaignType: "registration", telephonyProvider: "vobiz" } as never,
      "contact-key",
    );
    assert.equal(stack.speechToText, SPEECH_TO_TEXT_PROVIDER_IDS.DEEPGRAM);
    assert.equal(stack.speechToText, "deepgram");
  });
});

await test("16. Soniox is never ALLOCATED — only an explicit override can select it", async () => {
  // The override now exists, so the invariant is no longer "call-runner
  // never says soniox". It is the stronger, behavioural one: with the
  // override absent, NO selection key can reach Soniox.
  await withEnv({ SONIOX_API_KEY: "test-key", STT_PROVIDER: undefined }, () => {
    for (const key of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
      const stack = resolveCallProviderStack(
        { id: "c", campaignType: "registration", telephonyProvider: "vobiz" } as never,
        key,
      );
      assert.equal(stack.speechToText, "deepgram", `key "${key}" must resolve to deepgram`);
    }
  });
  // And Soniox must not have acquired a percentage/hash dimension.
  const runner = readFileSync("src/campaign/dispatch/call-runner.ts", "utf8");
  assert.ok(
    !/pickByAllocation\([\s\S]{0,80}soniox/i.test(runner),
    "soniox must never be reachable through an allocation",
  );
  assert.ok(
    !/stt:\$\{selectionKey\}|speechToText:\s*pickByAllocation/.test(runner),
    "STT must not gain a per-contact allocation dimension",
  );
});

// ═════════════════════════════════════════════════════════════════
section("B2. STT_PROVIDER override — the only path to Soniox");

const CAMPAIGN = { id: "c", campaignType: "registration", telephonyProvider: "vobiz" } as never;
const stackWith = () => resolveCallProviderStack(CAMPAIGN, "contact-key");

await test("O1. UNSET => Deepgram (the shipped default)", async () => {
  await withEnv({ [STT_PROVIDER_OVERRIDE_ENV]: undefined }, () => {
    assert.equal(resolveSttProviderId(), "deepgram");
    assert.equal(stackWith().speechToText, "deepgram");
  });
});

await test("O2. EMPTY / whitespace => Deepgram", async () => {
  for (const raw of ["", "   ", "\t"]) {
    await withEnv({ [STT_PROVIDER_OVERRIDE_ENV]: raw }, () => {
      assert.equal(resolveSttProviderId(), "deepgram", `${JSON.stringify(raw)} must mean unset`);
      assert.equal(stackWith().speechToText, "deepgram");
    });
  }
});

await test("O3. STT_PROVIDER=soniox => Soniox", async () => {
  await withEnv({ [STT_PROVIDER_OVERRIDE_ENV]: "soniox" }, () => {
    assert.equal(resolveSttProviderId(), "soniox");
    assert.equal(stackWith().speechToText, "soniox");
  });
});

await test("O3b. case and surrounding whitespace are tolerated", async () => {
  for (const raw of ["Soniox", "SONIOX", "  soniox  "]) {
    await withEnv({ [STT_PROVIDER_OVERRIDE_ENV]: raw }, () => {
      assert.equal(resolveSttProviderId(), "soniox", `${JSON.stringify(raw)} must select soniox`);
    });
  }
});

await test("O4. STT_PROVIDER=deepgram is explicit and still Deepgram", async () => {
  await withEnv({ [STT_PROVIDER_OVERRIDE_ENV]: "deepgram" }, () => {
    assert.equal(resolveSttProviderId(), "deepgram");
  });
});

await test("O5. an INVALID value falls back to Deepgram and is NOT silent", async () => {
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    for (const bad of ["deepgramm", "whisper", "qwen", "true", "1", "sonio"]) {
      await withEnv({ [STT_PROVIDER_OVERRIDE_ENV]: bad }, () => {
        // Resolved ONCE — the warning count below is the assertion, so
        // a second call here would inflate it.
        const resolved = resolveSttProviderId();
        assert.equal(
          resolved,
          "deepgram",
          `"${bad}" must fall back to deepgram, never to some other provider`,
        );
        assert.notEqual(resolved, "soniox");
      });
    }
  } finally {
    console.warn = realWarn;
  }
  assert.equal(warnings.length, 6, "every unrecognised value must be reported, not swallowed");
  assert.ok(warnings.every((w) => w.includes(STT_PROVIDER_OVERRIDE_ENV)));
  assert.ok(warnings.some((w) => w.includes("deepgramm")), "the bad value must be named");
});

await test("O6. no production traffic can move to Soniox without the override", async () => {
  // Every campaign shape, every selection key, override absent.
  await withEnv({ [STT_PROVIDER_OVERRIDE_ENV]: undefined, SONIOX_API_KEY: "test-key" }, () => {
    for (const key of ["contact-1", "contact-2", "x", "y", "z", "0", "9", "aaa"]) {
      assert.equal(resolveCallProviderStack(CAMPAIGN, key).speechToText, "deepgram");
    }
  });
});

await test("O7. the override does not disturb the OTHER allocated dimensions", async () => {
  const before = await (async () => {
    let v: { telephony: string; languageModel: string } | undefined;
    await withEnv({ [STT_PROVIDER_OVERRIDE_ENV]: undefined }, () => {
      const s = resolveCallProviderStack(CAMPAIGN, "stable-key");
      v = { telephony: s.telephony, languageModel: s.languageModel };
    });
    return v!;
  })();
  await withEnv({ [STT_PROVIDER_OVERRIDE_ENV]: "soniox" }, () => {
    const s = resolveCallProviderStack(CAMPAIGN, "stable-key");
    assert.equal(s.telephony, before.telephony, "telephony allocation must be untouched");
    assert.equal(s.languageModel, before.languageModel, "LLM allocation must be untouched");
    assert.equal(s.speechToText, "soniox");
  });
});

await test("O8. selecting soniox still REQUIRES SONIOX_API_KEY to resolve", async () => {
  await withEnv({ [STT_PROVIDER_OVERRIDE_ENV]: "soniox", SONIOX_API_KEY: undefined }, () => {
    // The override picks the id, but an unregistered provider still
    // cannot be resolved — the call fails loudly at session creation
    // rather than quietly running on something else.
    assert.equal(resolveSttProviderId(), "soniox");
    const { registry } = bootstrapProviderRegistry();
    assert.throws(() => registry.resolve(ProviderCategory.SPEECH_TO_TEXT, "soniox"));
  });
  await withEnv({ [STT_PROVIDER_OVERRIDE_ENV]: "soniox", SONIOX_API_KEY: "test-key" }, () => {
    const { registry } = bootstrapProviderRegistry();
    assert.equal(registry.resolve(ProviderCategory.SPEECH_TO_TEXT, "soniox").descriptor.id, "soniox");
  });
});

await test("O9. the override is read ONLY at the stack-resolution point", () => {
  const runner = readFileSync("src/campaign/dispatch/call-runner.ts", "utf8");
  const occurrences = (runner.match(/STT_PROVIDER_OVERRIDE_ENV/g) ?? []).length;
  assert.ok(occurrences > 0, "the constant must exist");
  // Declared once, read once inside the resolver, named in one warning.
  assert.ok(occurrences <= 5, `read in too many places (${occurrences})`);
  for (const f of [
    "src/core/session/conversation-pipeline.ts",
    "src/core/session/voice-session-manager.impl.ts",
    "src/providers/speech-to-text/deepgram.provider.ts",
    "src/providers/speech-to-text/soniox.provider.ts",
  ]) {
    // CODE only — prose may legitimately explain the override (the
    // Soniox adapter's header documents that it is unreachable without
    // it), and documenting a guarantee must not be what breaks it.
    const code = readFileSync(f, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*/g, "");
    assert.ok(!code.includes("STT_PROVIDER"), `${f} must not read the override`);
  }
});

// ═════════════════════════════════════════════════════════════════
section("A3. Language hints — the Punjabi fix");

await test("H1. hints are derived from the session language", () => {
  // 2026-09-21: an ENGLISH campaign hints both. Every campaign on this
  // deployment is stored as `en` while the calls are answered in
  // English, Hindi and Hinglish; with `["en"]` alone the model resolved
  // short Hindi utterances to Malayalam / Gurmukhi / Kannada / Urdu
  // scripts on real calls. Hints bias, they do not restrict.
  assert.deepEqual(sonioxLanguageHints(SupportedLanguage.ENGLISH), ["hi", "en"]);
  assert.deepEqual(sonioxLanguageHints(SupportedLanguage.HINDI), ["hi"]);
  // Hinglish mixes both INSIDE one sentence, so hinting one biases
  // against the other half of the same utterance.
  assert.deepEqual(sonioxLanguageHints(SupportedLanguage.HINGLISH), ["hi", "en"]);
});

await test("H2. no hint set ever contains a language we do not speak", () => {
  for (const lang of [SupportedLanguage.ENGLISH, SupportedLanguage.HINDI, SupportedLanguage.HINGLISH]) {
    const hints = sonioxLanguageHints(lang);
    assert.ok(hints.length > 0, "an empty hint list is what caused the Punjabi transcripts");
    for (const h of hints) {
      assert.ok(["hi", "en"].includes(h), `unexpected hint "${h}"`);
      assert.notEqual(h, "pa", "Punjabi must never be hinted");
    }
  }
});

await test("H3. the config frame actually SENDS the hints", async () => {
  const frames: Record<string, unknown>[] = [];
  for (const [lang, expected] of [
    [SupportedLanguage.HINDI, ["hi"]],
    [SupportedLanguage.ENGLISH, ["hi", "en"]],
    [SupportedLanguage.HINGLISH, ["hi", "en"]],
  ] as const) {
    const sock = new MockSocket();
    const p2 = new SonioxSpeechToTextProvider(CONFIGURED, () => sock);
    const held = heldAudio();
    const segments: TranscriptSegment[] = [];
    const done = (async () => {
      for await (const seg of p2.transcribeStream({
        sessionId: "lang-test" as SessionId,
        audio: held.iterable,
        language: lang,
      })) segments.push(seg);
    })();
    sock.emit("open");
    await sleep(10);
    assert.deepEqual(sock.config!["language_hints"], expected, `language ${lang}`);
    frames.push(sock.config!);
    held.release();
    await done;
  }
  // H4. The hint is the ONLY thing the session language changes about
  // the config frame: every other option is identical across the three
  // languages, so widening the English hint moved nothing else.
  const withoutHints = (frame: Record<string, unknown>) => {
    const { language_hints: _hints, ...rest } = frame;
    return rest;
  };
  assert.deepEqual(withoutHints(frames[1]!), withoutHints(frames[0]!), "English frame differs from Hindi only in hints");
  assert.deepEqual(withoutHints(frames[2]!), withoutHints(frames[0]!), "Hinglish frame differs from Hindi only in hints");
  assert.ok("model" in frames[0]! && "audio_format" in frames[0]! && "enable_endpoint_detection" in frames[0]!, "the connection options are still sent");
});

// ═════════════════════════════════════════════════════════════════
section("A4. Language RESTRICTION — the wrong-script fix");

await test("H5. the config frame sends language_hints_strict, on, for every session language", async () => {
  for (const lang of [SupportedLanguage.HINDI, SupportedLanguage.ENGLISH, SupportedLanguage.HINGLISH] as const) {
    const sock = new MockSocket();
    const p2 = new SonioxSpeechToTextProvider(CONFIGURED, () => sock);
    const held = heldAudio();
    const done = (async () => {
      for await (const _seg of p2.transcribeStream({
        sessionId: "strict-test" as SessionId,
        audio: held.iterable,
        language: lang,
      })) void _seg;
    })();
    sock.emit("open");
    await sleep(10);
    // Hints BIAS. Only this RESTRICTS — and the bias alone is what
    // failed: English came back as Devanagari, Gurmukhi, Bengali,
    // Malayalam, Telugu, Urdu and Kannada under hints that never
    // named any of them.
    assert.equal(
      sock.config!["language_hints_strict"],
      true,
      `language ${lang} must restrict, not merely bias`,
    );
    held.release();
    await done;
  }
});

await test("H5b. keyword boosting: `context` is sent when enabled, and absent when not", async () => {
  const frameFor = async (contextEnabled: boolean | undefined) => {
    const sock = new MockSocket();
    const p2 = new SonioxSpeechToTextProvider({ ...CONFIGURED, contextEnabled }, () => sock);
    const held = heldAudio();
    const done = (async () => {
      for await (const _seg of p2.transcribeStream({
        sessionId: "context-test" as SessionId,
        audio: held.iterable,
        language: SupportedLanguage.ENGLISH,
      })) void _seg;
    })();
    sock.emit("open");
    await sleep(10);
    const frame = sock.config!;
    held.release();
    await done;
    return frame;
  };
  const on = await frameFor(true);
  assert.deepEqual(on["context"], SONIOX_CONTEXT, "the context is sent verbatim");
  const terms = (SONIOX_CONTEXT.terms as readonly string[]);
  for (const word of ["okay", "yes", "right", "speaking", "FlexiFunnels", "webinar"]) {
    assert.ok(terms.includes(word), `"${word}" is boosted`);
  }
  assert.equal("context" in (await frameFor(false)), false, "the rollback lever removes it");
  assert.equal("context" in (await frameFor(undefined)), false, "a hand-built config without the flag is unchanged");
});

await test("H6. the restricted set always contains the caller's OTHER language", () => {
  // The whole reason two languages are restricted rather than one.
  // English campaigns are answered in Hindi and Hinglish too, so
  // restricting to ["en"] would transcribe a Hindi caller into Latin
  // nonsense; restricting to ["hi"] would do the reverse. Both
  // languages inside the restriction is what lets a mixed sentence
  // keep each word in its own script.
  assert.deepEqual([...sonioxLanguageHints(SupportedLanguage.ENGLISH)].sort(), ["en", "hi"]);
  assert.deepEqual([...sonioxLanguageHints(SupportedLanguage.HINGLISH)].sort(), ["en", "hi"]);
  // A Hindi campaign is the single-language mode the vendor calls most
  // robust, and English is deliberately NOT added to it: that campaign
  // is conducted in Hindi and its script is Devanagari throughout.
  assert.deepEqual([...sonioxLanguageHints(SupportedLanguage.HINDI)], ["hi"]);
});

await test("H7. strict defaults to on and is the one documented rollback lever", async () => {
  await withEnv({ SONIOX_API_KEY: "k", SONIOX_LANGUAGE_HINTS_STRICT: undefined }, () => {
    assert.equal(loadSonioxEnvConfig().languageHintsStrict, true, "default must be ON");
  });
  await withEnv({ SONIOX_API_KEY: "k", SONIOX_LANGUAGE_HINTS_STRICT: "false" }, () => {
    assert.equal(loadSonioxEnvConfig().languageHintsStrict, false, "operators can revert without a deploy");
  });
  await withEnv({ SONIOX_API_KEY: "k", SONIOX_LANGUAGE_HINTS_STRICT: "true" }, () => {
    assert.equal(loadSonioxEnvConfig().languageHintsStrict, true);
  });
});

await test("H8. reverting the lever sends strict=false and changes NOTHING else", async () => {
  const frameFor = async (strict: boolean): Promise<Record<string, unknown>> => {
    const sock = new MockSocket();
    const p2 = new SonioxSpeechToTextProvider({ ...CONFIGURED, languageHintsStrict: strict }, () => sock);
    const held = heldAudio();
    const done = (async () => {
      for await (const _seg of p2.transcribeStream({
        sessionId: "lever-test" as SessionId,
        audio: held.iterable,
        language: SupportedLanguage.ENGLISH,
      })) void _seg;
    })();
    sock.emit("open");
    await sleep(10);
    const cfg = sock.config!;
    held.release();
    await done;
    return cfg;
  };
  const on = await frameFor(true);
  const off = await frameFor(false);
  assert.equal(on["language_hints_strict"], true);
  assert.equal(off["language_hints_strict"], false);
  const withoutStrict = (frame: Record<string, unknown>) => {
    const { language_hints_strict: _s, ...rest } = frame;
    return rest;
  };
  // Including the hints themselves: the array is NOT narrowed when
  // strict is on, so reverting the lever restores exactly the previous
  // bias-only connection.
  assert.deepEqual(withoutStrict(on), withoutStrict(off), "the lever moves one field and no other");
  assert.deepEqual(on["language_hints"], ["hi", "en"], "strict does not narrow the array");
});

// ═════════════════════════════════════════════════════════════════
section("B3. Per-campaign STT selection");

const campaignWith = (stt?: string) =>
  ({ id: "c", campaignType: "registration", telephonyProvider: "vobiz",
     ...(stt !== undefined ? { sttProvider: stt } : {}) }) as never;

await test("C1. a campaign with NO choice resolves to Deepgram", async () => {
  await withEnv({ [STT_PROVIDER_OVERRIDE_ENV]: undefined }, () => {
    assert.equal(resolveCallProviderStack(campaignWith(), "k").speechToText, "deepgram");
    assert.equal(DEFAULT_CAMPAIGN_STT_PROVIDER, "deepgram");
  });
});

await test("C2. a campaign that chose soniox gets soniox", async () => {
  await withEnv({ [STT_PROVIDER_OVERRIDE_ENV]: undefined }, () => {
    assert.equal(resolveCallProviderStack(campaignWith("soniox"), "k").speechToText, "soniox");
  });
});

await test("C3. the campaign's choice OUTRANKS the env override", async () => {
  await withEnv({ [STT_PROVIDER_OVERRIDE_ENV]: "soniox" }, () => {
    assert.equal(
      resolveCallProviderStack(campaignWith("deepgram"), "k").speechToText,
      "deepgram",
      "an explicit per-campaign decision beats a process-wide switch",
    );
  });
  await withEnv({ [STT_PROVIDER_OVERRIDE_ENV]: "deepgram" }, () => {
    assert.equal(resolveCallProviderStack(campaignWith("soniox"), "k").speechToText, "soniox");
  });
});

await test("C4. the env override still applies when the campaign made no choice", async () => {
  await withEnv({ [STT_PROVIDER_OVERRIDE_ENV]: "soniox" }, () => {
    assert.equal(resolveCallProviderStack(campaignWith(), "k").speechToText, "soniox");
  });
});

await test("C5. an unsupported stored value falls back to Deepgram, not to soniox", async () => {
  await withEnv({ [STT_PROVIDER_OVERRIDE_ENV]: undefined }, () => {
    const realWarn = console.warn;
    console.warn = () => {};
    try {
      for (const bad of ["whisper", "qwen", "", "  ", "deepgramm"]) {
        assert.equal(
          resolveCallProviderStack(campaignWith(bad), "k").speechToText,
          "deepgram",
          `stored "${bad}" must not dial through an unsupported recognizer`,
        );
      }
    } finally {
      console.warn = realWarn;
    }
  });
});

await test("C6. STT stays a SINGLE choice — never a per-contact allocation", async () => {
  await withEnv({ [STT_PROVIDER_OVERRIDE_ENV]: undefined }, () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      ids.add(resolveCallProviderStack(campaignWith("soniox"), `contact-${i}`).speechToText);
    }
    assert.deepEqual([...ids], ["soniox"], "every contact must get the same recognizer");
  });
});

await test("C7. the supported set is exactly Deepgram and Soniox", () => {
  assert.deepEqual([...CAMPAIGN_STT_PROVIDERS].sort(), ["deepgram", "soniox"]);
  assert.ok(isCampaignSttProvider("deepgram"));
  assert.ok(isCampaignSttProvider("soniox"));
  assert.ok(!isCampaignSttProvider("whisper"));
  assert.ok(!isCampaignSttProvider("Soniox"), "the guard is exact — callers lowercase first");
});

// ═════════════════════════════════════════════════════════════════
section("C. Audio forwarding");

await test("6. mu-law 8kHz frames are forwarded byte-for-byte, unconverted", async () => {
  const sock = new MockSocket();
  const p = new SonioxSpeechToTextProvider(CONFIGURED, () => sock);
  const payload = new Uint8Array([1, 2, 3, 4, 5]);
  const run = streamOf(p, (async function* () {
    yield { data: payload, encoding: "MULAW", sampleRateHz: 8000 } as AudioPayload;
  })());
  sock.emit("open");
  await run.done;
  assert.equal(sock.sentBinary.length, 1);
  assert.deepEqual([...sock.sentBinary[0]!], [1, 2, 3, 4, 5], "bytes must be identical");
});

await test("6b. a non-mulaw payload is REFUSED, never transcoded", async () => {
  const sock = new MockSocket();
  const p = new SonioxSpeechToTextProvider(CONFIGURED, () => sock);
  const run = streamOf(p, (async function* () {
    yield { data: new Uint8Array(8), encoding: "PCM_16", sampleRateHz: 16000 } as AudioPayload;
  })());
  sock.emit("open");
  await run.done;
  assert.equal(sock.sentBinary.length, 0, "no audio may reach the vendor in an unsupported format");
});

await test("6c. audio that arrives before open is buffered, not dropped", async () => {
  const sock = new MockSocket();
  sock.readyState = 0; // connecting
  const p = new SonioxSpeechToTextProvider(CONFIGURED, () => sock);
  const held = heldAudio();
  const run = streamOf(p, held.iterable);
  await sleep(10);
  assert.equal(sock.sentBinary.length, 0, "nothing sent while connecting");
  sock.readyState = 1;
  sock.emit("open");
  await sleep(10);
  assert.equal(sock.sentBinary.length, 1, "buffered frame flushed on open");
  held.release();
  await run.done;
});

// ═════════════════════════════════════════════════════════════════
section("D. Transcript normalization");

const EN = SupportedLanguage.ENGLISH;

await test("7. interim tokens => one interim segment", () => {
  const segs = segmentsFromSonioxMessage(
    { tokens: [{ text: "hel", is_final: false }, { text: "lo", is_final: false }] },
    EN,
  );
  assert.equal(segs.length, 1);
  assert.equal(segs[0]!.isFinal, false);
  assert.equal(segs[0]!.text, "hello");
  assert.equal(segs[0]!.isSpeechFinal, false);
});

await test("8. final tokens => one final segment that is NOT an endpoint claim", () => {
  const segs = segmentsFromSonioxMessage(
    { tokens: [{ text: "yes", is_final: true }, { text: " please", is_final: true }] },
    EN,
  );
  assert.equal(segs.length, 1);
  assert.equal(segs[0]!.isFinal, true);
  assert.equal(segs[0]!.text, "yes please");
  assert.equal(
    segs[0]!.isSpeechFinal,
    false,
    "a Soniox word-final says nothing about the speaker stopping — this is the Deepgram assumption that must not leak",
  );
  assert.ok(!segs[0]!.isEndOfSpeechMarker);
});

await test("8b. a message mixing final and interim yields both, finals last", () => {
  const segs = segmentsFromSonioxMessage(
    { tokens: [{ text: "book", is_final: true }, { text: " it", is_final: false }] },
    EN,
  );
  assert.equal(segs.length, 2);
  assert.equal(segs[0]!.isFinal, false);
  assert.equal(segs[0]!.text, "it");
  assert.equal(segs[1]!.isFinal, true);
  assert.equal(segs[1]!.text, "book");
});

await test("9. token timestamps and confidence are normalized onto the segment", () => {
  const segs = segmentsFromSonioxMessage(
    {
      tokens: [
        { text: "one", is_final: true, start_ms: 600, end_ms: 760, confidence: 0.9 },
        { text: " two", is_final: true, start_ms: 760, end_ms: 980, confidence: 0.8 },
      ],
    },
    EN,
  );
  assert.equal(segs[0]!.startedAtMs, 600, "earliest token start");
  assert.equal(segs[0]!.endedAtMs, 980, "latest token end — the word-end the pipeline reads");
  assert.ok(Math.abs(segs[0]!.confidence - 0.85) < 1e-9, "mean token confidence");
});

await test("9b. absent timings become 0 — this codebase's 'no word timings'", () => {
  const segs = segmentsFromSonioxMessage({ tokens: [{ text: "hi", is_final: true }] }, EN);
  assert.equal(segs[0]!.startedAtMs, 0);
  assert.equal(segs[0]!.endedAtMs, 0);
  assert.equal(segs[0]!.confidence, 0);
});

await test("10. the <end> token becomes a PROVIDER-NEUTRAL end-of-speech marker", () => {
  const segs = segmentsFromSonioxMessage(
    {
      tokens: [
        { text: "register", is_final: true, start_ms: 10, end_ms: 400 },
        { text: " me", is_final: true, start_ms: 400, end_ms: 600 },
        { text: SONIOX_END_TOKEN, is_final: true },
      ],
    },
    EN,
  );
  assert.equal(segs.length, 2, "the words, then the marker");
  assert.equal(segs[0]!.text, "register me");
  assert.ok(!segs[0]!.isEndOfSpeechMarker);

  const marker = segs[1]!;
  assert.equal(marker.isEndOfSpeechMarker, true);
  assert.equal(marker.isFinal, true);
  assert.equal(marker.isSpeechFinal, true);
  assert.equal(marker.text, "", "a marker carries no words");
  assert.equal(marker.startedAtMs, 0);
  assert.equal(marker.endedAtMs, 0);
});

await test("10b. the literal \"<end>\" never appears in transcript text", () => {
  const segs = segmentsFromSonioxMessage(
    { tokens: [{ text: "ok", is_final: true }, { text: SONIOX_END_TOKEN, is_final: true }] },
    EN,
  );
  for (const s of segs) {
    assert.ok(!s.text.includes("<end>"), `"${s.text}" must not contain the signal token`);
  }
});

await test("10c. an <end> with no words yields the marker alone", () => {
  const segs = segmentsFromSonioxMessage({ tokens: [{ text: SONIOX_END_TOKEN, is_final: true }] }, EN);
  assert.equal(segs.length, 1);
  assert.equal(segs[0]!.isEndOfSpeechMarker, true);
});

await test("10d. an empty token list yields nothing", () => {
  assert.equal(segmentsFromSonioxMessage({ tokens: [] }, EN).length, 0);
  assert.equal(segmentsFromSonioxMessage({}, EN).length, 0);
});

await test("D-e2e. segments flow through the live stream in order", async () => {
  const sock = new MockSocket();
  const p = new SonioxSpeechToTextProvider(CONFIGURED, () => sock);
  const held = heldAudio();
  const run = streamOf(p, held.iterable);
  sock.emit("open");
  await sleep(5);
  sock.deliver({ tokens: [{ text: "yes", is_final: false }] });
  sock.deliver({ tokens: [{ text: "yes", is_final: true, start_ms: 0, end_ms: 300 }, { text: SONIOX_END_TOKEN, is_final: true }] });
  await sleep(20);
  held.release();
  await run.done;
  assert.deepEqual(
    run.segments.map((s) => `${s.isEndOfSpeechMarker ? "MARK" : s.isFinal ? "FINAL" : "INTERIM"}:${s.text}`),
    ["INTERIM:yes", "FINAL:yes", "MARK:"],
  );
});

// ═════════════════════════════════════════════════════════════════
section("D2. Script fidelity — the adapter never rewrites what Soniox said");

/**
 * WHAT THESE CAN AND CANNOT PROVE.
 *
 * Which SCRIPT Soniox chooses is Soniox's decision, made inside the
 * model from the audio and the restriction; no unit test can assert it
 * without a live socket and a real voice. What these DO pin is the
 * other half of the requirement, and the half this repo owns: that the
 * adapter is a pass-through. Given tokens in a script, the segment
 * carries that script byte for byte — no normalization, no
 * transliteration, no per-segment language flattening, and no
 * collapsing of a code-switched sentence into one script.
 *
 * That matters because it is what makes the provider the only suspect
 * when a transcript comes back in the wrong script, and what makes
 * `language_hints_strict` the only place a fix can live.
 */

await test("S1. English tokens stay English — Latin in, Latin out, byte for byte", () => {
  const segs = segmentsFromSonioxMessage(
    {
      tokens: "Hello, I would like to join the webinar."
        .split(/(?= )/u)
        .map((text) => ({ text, is_final: true, language: "en" })),
    },
    SupportedLanguage.ENGLISH,
  );
  assert.equal(segs.length, 1);
  assert.equal(segs[0]!.text, "Hello, I would like to join the webinar.");
  assert.ok(!/[ऀ-ॿ]/u.test(segs[0]!.text), "no Devanagari may appear in an English transcript");
});

await test("S2. Hindi tokens stay Hindi — Devanagari is never romanized", () => {
  const segs = segmentsFromSonioxMessage(
    {
      tokens: [
        { text: "मुझे", is_final: true, language: "hi" },
        { text: " इस", is_final: true, language: "hi" },
        { text: " वेबिनार", is_final: true, language: "hi" },
        { text: " के", is_final: true, language: "hi" },
        { text: " बारे", is_final: true, language: "hi" },
        { text: " में", is_final: true, language: "hi" },
        { text: " जानना", is_final: true, language: "hi" },
        { text: " है", is_final: true, language: "hi" },
      ],
    },
    SupportedLanguage.ENGLISH,
  );
  assert.equal(segs[0]!.text, "मुझे इस वेबिनार के बारे में जानना है");
});

await test("S3. an English word inside a Hindi sentence survives in LATIN", () => {
  // Requirement B. Both languages are inside the restriction, so
  // Soniox can emit each word in its own script — and the adapter must
  // not flatten the result to either one.
  const segs = segmentsFromSonioxMessage(
    {
      tokens: [
        { text: "मुझे", is_final: true, language: "hi" },
        { text: " इस", is_final: true, language: "hi" },
        { text: " webinar", is_final: true, language: "en" },
        { text: " के", is_final: true, language: "hi" },
        { text: " बारे", is_final: true, language: "hi" },
        { text: " में", is_final: true, language: "hi" },
        { text: " जानना", is_final: true, language: "hi" },
        { text: " है", is_final: true, language: "hi" },
      ],
    },
    SupportedLanguage.ENGLISH,
  );
  assert.equal(segs.length, 1);
  assert.equal(segs[0]!.text, "मुझे इस webinar के बारे में जानना है");
  assert.ok(segs[0]!.text.includes("webinar"), "the English word must not be transliterated into Devanagari");
  assert.ok(segs[0]!.text.includes("मुझे"), "the Hindi words must not be romanized either");
});

await test("S3b. \"मुझे website बनानी है\" keeps `website` in Latin", () => {
  const segs = segmentsFromSonioxMessage(
    {
      tokens: [
        { text: "मुझे", is_final: true, language: "hi" },
        { text: " website", is_final: true, language: "en" },
        { text: " बनानी", is_final: true, language: "hi" },
        { text: " है", is_final: true, language: "hi" },
      ],
    },
    SupportedLanguage.ENGLISH,
  );
  assert.equal(segs[0]!.text, "मुझे website बनानी है");
});

await test("S4. Hindi words inside an English sentence keep Devanagari", () => {
  const segs = segmentsFromSonioxMessage(
    {
      tokens: [
        { text: "I", is_final: true, language: "en" },
        { text: " want", is_final: true, language: "en" },
        { text: " to", is_final: true, language: "en" },
        { text: " अपना", is_final: true, language: "hi" },
        { text: " business", is_final: true, language: "en" },
        { text: " start", is_final: true, language: "en" },
        { text: " करना", is_final: true, language: "hi" },
      ],
    },
    SupportedLanguage.ENGLISH,
  );
  assert.equal(segs[0]!.text, "I want to अपना business start करना");
});

await test("S5. romanized Hinglish is passed through unchanged too", () => {
  // Case 3: when Soniox writes Hinglish in Latin, that is the existing
  // behaviour and the adapter leaves it exactly alone — this fix adds
  // no romanization and no de-romanization in either direction.
  const segs = segmentsFromSonioxMessage(
    {
      tokens: [{ text: "Main webinar ke baare mein jaana chahta hoon.", is_final: true, language: "hi" }],
    },
    SupportedLanguage.HINGLISH,
  );
  assert.equal(segs[0]!.text, "Main webinar ke baare mein jaana chahta hoon.");
});

await test("S6. NO vocabulary, transliteration or translation table exists anywhere in the adapter", () => {
  // The operator ruled these out explicitly, and they are also the
  // wrong layer: a mapping here would mask a provider defect rather
  // than correct it. Pinned so no later 'quick fix' can add one.
  const source = readFileSync(
    new URL("../../providers/speech-to-text/soniox.provider.ts", import.meta.url),
    "utf8",
  );
  // Strip comments: the file DISCUSSES the wrong-script strings it
  // exists to prevent, and must be allowed to.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/^[ \t]*\/\/.*$/gmu, "");
  assert.ok(
    !/[ऀ-ॿ]/u.test(code),
    "no Devanagari literal may appear in adapter CODE — that would be a transliteration table",
  );
  for (const forbidden of ["normalize(", "transliterate", "romanize", "translation"]) {
    assert.ok(!code.includes(forbidden), `the adapter must not ${forbidden}… the transcript`);
  }
});

// ═════════════════════════════════════════════════════════════════
section("E. Errors, close, reconnect");

await test("11. a provider error frame ends the stream and is classified", async () => {
  const sock = new MockSocket();
  const p = new SonioxSpeechToTextProvider(CONFIGURED, () => sock);
  const held = heldAudio();
  const run = streamOf(p, held.iterable);
  sock.emit("open");
  await sleep(5);
  sock.deliver({ error_code: 401, error_message: "Unauthorized: invalid API key" });
  await sleep(10);
  held.release();
  await run.done;
  const health = await p.checkHealth();
  assert.equal(health.isHealthy, false);
  assert.match(String(health.message), /authentication_failed/);
});

await test("11b. a non-auth error is classified as provider_unavailable", async () => {
  const sock = new MockSocket();
  const p = new SonioxSpeechToTextProvider(CONFIGURED, () => sock);
  const held = heldAudio();
  const run = streamOf(p, held.iterable);
  sock.emit("open");
  await sleep(5);
  sock.deliver({ error_code: 500, error_message: "internal error" });
  await sleep(10);
  held.release();
  await run.done;
  assert.match(String((await p.checkHealth()).message), /provider_unavailable/);
});

await test("12. finished:true closes the stream cleanly", async () => {
  const sock = new MockSocket();
  const p = new SonioxSpeechToTextProvider(CONFIGURED, () => sock);
  const held = heldAudio();
  const run = streamOf(p, held.iterable);
  sock.emit("open");
  await sleep(5);
  sock.deliver({ tokens: [{ text: "bye", is_final: true }], finished: true });
  await sleep(10);
  held.release();
  await run.done;
  assert.equal(run.segments.length, 1);
  assert.ok(sock.closeCalls.length >= 1, "the socket must be closed");
});

await test("13. reconnect is BOUNDED — never an infinite loop", async () => {
  let created = 0;
  const sockets: MockSocket[] = [];
  const p = new SonioxSpeechToTextProvider(CONFIGURED, () => {
    created += 1;
    const s = new MockSocket();
    sockets.push(s);
    // Every socket closes immediately without ever opening.
    setTimeout(() => s.emit("close"), 1);
    return s;
  });
  const held = heldAudio();
  const run = streamOf(p, held.iterable);
  await sleep(600);
  held.release();
  await run.done;
  assert.ok(created >= 2, "it must retry at least once");
  assert.ok(created <= 5, `bounded at 5 attempts, saw ${created}`);
  assert.match(String((await p.checkHealth()).message), /provider_unavailable/);
});

await test("13b. abort cleans up: socket closed, stream ended", async () => {
  const sock = new MockSocket();
  const p = new SonioxSpeechToTextProvider(CONFIGURED, () => sock);
  const controller = new AbortController();
  const held = heldAudio();
  const run = streamOf(p, held.iterable, controller.signal);
  sock.emit("open");
  await sleep(5);
  controller.abort();
  await sleep(10);
  held.release();
  await run.done;
  assert.ok(sock.closeCalls.length >= 1, "abort must close the socket");
});

await test("13c. a socket factory that throws does not spin or crash the caller", async () => {
  let created = 0;
  const p = new SonioxSpeechToTextProvider(CONFIGURED, () => {
    created += 1;
    throw new Error("connect refused");
  });
  const held = heldAudio();
  const run = streamOf(p, held.iterable);
  await sleep(200);
  held.release();
  await run.done;
  assert.equal(created, 1, "a construction failure must not retry in a loop");
  assert.match(String((await p.checkHealth()).message), /provider_unavailable/);
});

// ═════════════════════════════════════════════════════════════════
section("F. Metrics attribution");

const STACK = {
  telephony: { category: ProviderCategory.TELEPHONY, id: "vobiz" },
  speechToText: { category: ProviderCategory.SPEECH_TO_TEXT, id: "soniox" },
  languageModel: { category: ProviderCategory.LANGUAGE_MODEL, id: "gpt-5.1" },
  textToSpeech: { category: ProviderCategory.TEXT_TO_SPEECH, id: "cartesia" },
} as unknown as ProviderStackSelection;

await test("14. metrics record provider identity and the exact model", () => {
  const p = new SonioxSpeechToTextProvider(CONFIGURED, () => new MockSocket());
  const collector = new SessionMetricsCollector("sess-soniox" as SessionId, STACK);
  // Exactly what the session manager does: descriptor.version -> sttModel.
  collector.noteSttModel(p.descriptor.version);
  const metrics = collector.build();
  assert.equal(metrics.sttModel, "stt-rt-v5");
  assert.equal(metrics.providerStack.speechToText.id, "soniox");
});

await test("14b. no Deepgram-specific value is fabricated for Soniox", () => {
  // CODE only. The file's prose deliberately NAMES the Deepgram
  // concepts in order to say it does not use them, so comments are
  // stripped before the assertion — otherwise the doc that documents
  // the guarantee would be what fails it.
  const raw = readFileSync("src/providers/speech-to-text/soniox.provider.ts", "utf8");
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
  for (const forbidden of ["speech_final", "utterance_end_ms", "UtteranceEnd", "nova-3"]) {
    assert.ok(
      !new RegExp(`["'\`]${forbidden}`).test(src),
      `the Soniox adapter must not emit or configure "${forbidden}"`,
    );
  }
});

await test("14c. the API key is never logged and never leaves the config frame", async () => {
  const src = readFileSync("src/providers/speech-to-text/soniox.provider.ts", "utf8");
  // Every console call in the file, checked for the key.
  for (const m of src.match(/console\.(log|warn|error)\([\s\S]*?\);/g) ?? []) {
    assert.ok(!/apiKey/.test(m), `a log statement references apiKey:\n${m.slice(0, 160)}`);
  }
  const sock = new MockSocket();
  const p = new SonioxSpeechToTextProvider(CONFIGURED, () => sock);
  const held = heldAudio();
  const run = streamOf(p, held.iterable);
  sock.emit("open");
  await sleep(5);
  held.release();
  await run.done;
  // The key appears in exactly one place: the config frame.
  const withKey = sock.sentText.filter((t) => t.includes("test-key-never-real"));
  assert.equal(withKey.length, 1, "the key may appear only in the config frame");
});

// ═════════════════════════════════════════════════════════════════
section("G. Production safety");

await test("G1. Deepgram's own configuration is untouched by this work", async () => {
  const dg = readFileSync("src/providers/speech-to-text/deepgram.provider.ts", "utf8");
  assert.ok(/utterance_end_ms:\s*"1000"/.test(dg), "utterance_end_ms must remain 1000");
  assert.ok(!/endpointing:\s*"(?!400)/.test(dg), "no hard-coded endpointing other than 400");
  assert.ok(!/soniox/i.test(dg), "the Deepgram adapter must not reference Soniox");
});

await test("G2. no environment mutation leaked from this suite", () => {
  assert.equal(process.env["SONIOX_API_KEY"], undefined, "the suite must not leave a key set");
});

// ═════════════════════════════════════════════════════════════════
console.log(
  `\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`,
);
for (const name of failures) console.log(`  - ${name}`);
console.log("No Soniox key, socket, network request, telephony call or database access was used.");
process.exit(failures.length === 0 ? 0 : 1);
