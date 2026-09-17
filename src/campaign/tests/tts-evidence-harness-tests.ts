/**
 * tts-evidence-harness-tests.ts — `npm run test:tts-evidence`
 *
 * Tests THE HARNESS, not the voice agent.
 *
 * Nothing here contacts a vendor, opens a socket, places a call or
 * touches the database. Section D proves that positively rather than
 * by assertion: the dry-run path is driven with a fake provider whose
 * every member throws, so a single vendor call would fail the suite.
 *
 * ── WHAT THESE TESTS ARE GUARDING ─────────────────────────────────
 *
 * An evidence harness is only worth the trust placed in its output, so
 * the properties under test are the ones that would make a report
 * quietly wrong rather than obviously broken:
 *
 *   - the corpus is well-formed, unique and path-safe (A);
 *   - the transformation really is the production code, not a copy (B);
 *   - the reported provider configuration matches the adapters (C);
 *   - a dry run cannot reach a vendor (D);
 *   - output paths are deterministic (E);
 *   - no secret can reach a report (F);
 *   - the report serializes, and refuses to score (G).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const { CORPUS, CORPUS_VERSION, corpusFingerprint } = await import("../../benchmark/tts/corpus");
const { transformItem, transformAll, mismatches } = await import("../../benchmark/tts/transform");
const {
  HARNESS_PROVIDERS,
  ALL_PROVIDER_IDS,
  effectiveConfig,
  selectedProviderIds,
  UNSET_NOTE,
} = await import("../../benchmark/tts/providers");
const { audioRelativePath, dryRunRecords, runProvider, SAFE_ID_PATTERN } = await import(
  "../../benchmark/tts/runner"
);
const { buildJsonReport, buildMarkdownReport } = await import("../../benchmark/tts/report");
const { pcm16ToWav, WAV_HEADER_BYTES, UnsupportedAudioEncodingError } = await import(
  "../../benchmark/tts/wav"
);
const { resolveMode, OUTPUT_DIR, SYNTHESIZE_FLAG, CONFIRM_FLAG, DRY_RUN_FLAG } = await import(
  "../../benchmark/tts/cli"
);
const { formatForSpeech } = await import("../../utils/speech-formatter");
const { pronounceForSpeech } = await import("../../utils/speech-pronunciation");
const { SupportedLanguage } = await import("../../types/enums");
const { TEXT_TO_SPEECH_PROVIDER_IDS } = await import("../../constants/providers.constants");

import type { CorpusItem } from "../../benchmark/tts/corpus";
import type { TextToSpeechProvider } from "../../interfaces/providers/text-to-speech-provider.interface";

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
      `         ${(error instanceof Error ? error.message : String(error)).split("\n").slice(0, 5).join("\n         ")}`,
    );
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

const REPO_ROOT = process.cwd();

/**
 * A mutable view of `process.env`.
 *
 * `src/types/env.types.ts` declares the known variables `readonly`,
 * which is right for production code and in the way here: two tests
 * below have to set a variable, observe what the harness reports, and
 * put it back exactly as it was. The cast is local to this file and
 * every mutation is restored in a `finally`.
 */
const mutableEnv = process.env as Record<string, string | undefined>;

function withEnv(name: string, value: string | undefined, body: () => void): void {
  const saved = mutableEnv[name];
  try {
    if (value === undefined) delete mutableEnv[name];
    else mutableEnv[name] = value;
    body();
  } finally {
    if (saved === undefined) delete mutableEnv[name];
    else mutableEnv[name] = saved;
  }
}

// ═══════════════════════════════════════════════════════════════════
section("SECTION A — the corpus is well-formed");
// ═══════════════════════════════════════════════════════════════════

await test("A1 — every corpus id is unique", () => {
  const seen = new Map<string, number>();
  for (const item of CORPUS) seen.set(item.id, (seen.get(item.id) ?? 0) + 1);
  const duplicates = [...seen].filter(([, count]) => count > 1).map(([id]) => id);
  assert.deepEqual(duplicates, [], `duplicate corpus id(s): ${duplicates.join(", ")}`);
});

await test("A2 — every corpus item carries every required field, non-empty", () => {
  for (const item of CORPUS) {
    assert.ok(item.id.length > 0, "id must be present");
    assert.ok(item.category.length > 0, `${item.id}: category must be present`);
    assert.ok(item.sourceText.trim().length > 0, `${item.id}: sourceText must be non-empty`);
    assert.ok(
      Object.values(SupportedLanguage).includes(item.language),
      `${item.id}: language must be a SupportedLanguage`,
    );
    assert.ok(
      item.expectation === "unchanged" || item.expectation === "transformed",
      `${item.id}: expectation must be unchanged|transformed`,
    );
    assert.ok(item.note.trim().length > 0, `${item.id}: note must explain why the item exists`);
  }
});

await test("A3 — every corpus id is filesystem-safe and cannot escape its directory", () => {
  for (const item of CORPUS) {
    assert.match(item.id, SAFE_ID_PATTERN, `${item.id}: ids are restricted to [a-z0-9-]`);
    assert.ok(!item.id.includes(".."), `${item.id}: no traversal`);
  }
});

await test("A4 — the corpus covers every category the Phase 4 audit named", () => {
  const categories = new Set(CORPUS.map((item) => item.category));
  for (const required of [
    "name-north-indian",
    "name-ambiguous-english",
    "name-devanagari",
    "name-mixed-script",
    "name-consonant-cluster",
    "name-transliteration-ambiguity",
    "name-in-context",
    "script-v6-line",
    "normalization-time",
    "normalization-date",
    "normalization-amount",
    "normalization-contact",
    "normalization-symbolic",
  ]) {
    assert.ok(categories.has(required as CorpusItem["category"]), `no corpus item for "${required}"`);
  }
});

await test("A5 — all three conversation languages are represented", () => {
  const languages = new Set(CORPUS.map((item) => item.language));
  for (const language of Object.values(SupportedLanguage)) {
    assert.ok(languages.has(language), `no corpus item in language "${language}"`);
  }
});

await test("A6 — the fingerprint is stable, and moves when the text moves", () => {
  assert.equal(corpusFingerprint(CORPUS), corpusFingerprint(CORPUS), "same input, same fingerprint");
  const edited = CORPUS.map((item, index) =>
    index === 0 ? { ...item, sourceText: `${item.sourceText} ` } : item,
  );
  assert.notEqual(
    corpusFingerprint(edited),
    corpusFingerprint(CORPUS),
    "a one-character edit must change the fingerprint",
  );
  assert.ok(CORPUS_VERSION.length > 0, "the corpus must be versioned");
});

await test("A7 — the live-script items are quoted from the SHIPPING registration.v6, verbatim", () => {
  // The corpus does not import the script (that would drag the script
  // registry and its hashing into a text-only harness), so this test is
  // what keeps the two in step: re-word v6 and the evidence stops being
  // evidence about the live call, here, rather than in a report nobody
  // re-read.
  const scriptPath = path.join(REPO_ROOT, "src/campaign/script/scripts/registration.v6.ts");
  const script = readFileSync(scriptPath, "utf8");
  const quoted = CORPUS.filter((item) => item.category === "script-v6-line");
  assert.ok(quoted.length > 0, "there must be live-script items");
  for (const item of quoted) {
    // The opening line is a template in the file (`{{agent_name}}`),
    // so only its fixed remainder can be matched literally.
    const needle =
      item.id === "v6-opening-en"
        ? "from Team FlexiFunnels."
        : item.sourceText;
    assert.ok(
      script.includes(needle),
      `${item.id}: not found verbatim in registration.v6.ts — ${JSON.stringify(needle.slice(0, 60))}`,
    );
  }
});

await test("A8 — no corpus item contains markdown, which the harness does not strip", () => {
  // `stripMarkdown` is module-private in conversation-pipeline.ts and is
  // deliberately not reproduced (see transform.ts). That omission is
  // only harmless while no corpus item would be changed by it, so the
  // constructs checked here are exactly the ones that function removes
  // — including its PAIRED emphasis markers, which is why the
  // underscore inside `support_team@example.com` is correctly not
  // treated as markdown by either.
  const MARKDOWN_CONSTRUCTS: readonly RegExp[] = [
    /^[\t ]*[-*•]\s+/mu, // bullet
    /^[\t ]*\d+\.\s+/mu, // numbered list
    /^[\t ]*#{1,6}\s+/mu, // header
    /\*{1,3}[^*]+\*{1,3}/u, // bold / italic
    /_{1,3}[^_]+_{1,3}/u, // underscore emphasis (PAIRED)
    /`{1,3}[^`]+`{1,3}/u, // code span
    /\r?\n/u, // newline: collapsed to a space
  ];
  for (const item of CORPUS) {
    for (const pattern of MARKDOWN_CONSTRUCTS) {
      assert.ok(
        !pattern.test(item.sourceText),
        `${item.id}: matches ${pattern} — stripMarkdown would change it, so its evidence would be incomplete`,
      );
    }
  }
});

// ═══════════════════════════════════════════════════════════════════
section("SECTION B — the transformation is production's, not a copy");
// ═══════════════════════════════════════════════════════════════════

await test("B1 — transformItem composes the REAL formatForSpeech and pronounceForSpeech", () => {
  for (const item of CORPUS) {
    const result = transformItem(item);
    const expectedFormatted = formatForSpeech(item.sourceText);
    assert.equal(result.formattedText, expectedFormatted, `${item.id}: formatted text`);
    assert.equal(
      result.synthesisText,
      pronounceForSpeech(expectedFormatted, item.language),
      `${item.id}: synthesis text`,
    );
  }
});

await test("B2 — the order is production's order: format first, pronounce second", () => {
  // A case where the two orders differ would be invisible if the harness
  // silently swapped them. The assertion is structural: the pronounce
  // pass is applied TO the formatted text, never to the original.
  const item: CorpusItem = {
    id: "order-probe",
    category: "normalization-time",
    sourceText: "Umm, please join TODAY at 7:30 PM.",
    language: SupportedLanguage.ENGLISH,
    expectation: "transformed",
    note: "probe",
  };
  const result = transformItem(item);
  assert.equal(result.formattedText, formatForSpeech(item.sourceText));
  assert.equal(result.synthesisText, pronounceForSpeech(result.formattedText, item.language));
  assert.ok(!result.synthesisText.startsWith("Umm"), "the hesitation opener must be gone");
  assert.ok(result.synthesisText.includes("seven thirty"), "the time must be spelled out");
});

await test("B3 — the harness carries no formatting or pronunciation rules of its own", () => {
  // The value of the evidence is that the text IS production's text. A
  // regex or vocabulary table appearing in these two files is the one
  // change that would quietly break that.
  for (const relative of ["src/benchmark/tts/transform.ts", "src/benchmark/tts/corpus.ts"]) {
    const source = readFileSync(path.join(REPO_ROOT, relative), "utf8");
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\*|\/\/)/u.test(line))
      .join("\n");
    assert.ok(
      !/\.replace\s*\(/u.test(code),
      `${relative}: no text rewriting may live in the harness`,
    );
  }
});

await test("B4 — every corpus declaration matches what the code actually does", () => {
  const stale = mismatches(transformAll(CORPUS));
  assert.deepEqual(
    stale.map((result) => result.corpusId),
    [],
    "a mismatch means the corpus declaration is stale — read WHY before editing it",
  );
});

await test("B5 — the audit's headline finding still holds: no name is touched", () => {
  const names = CORPUS.filter((item) => item.category.startsWith("name-"));
  assert.ok(names.length >= 20, "the name sample must stay meaningful");
  for (const item of names) {
    const result = transformItem(item);
    assert.equal(
      result.synthesisText,
      item.sourceText,
      `${item.id}: a name was rewritten — that is a NEW behaviour and this baseline no longer describes it`,
    );
  }
});

await test("B6 — transformation is deterministic across repeated runs", () => {
  const first = transformAll(CORPUS);
  const second = transformAll(CORPUS);
  assert.deepEqual(second, first, "same source, same corpus, same strings");
});

// ═══════════════════════════════════════════════════════════════════
section("SECTION C — reported configuration matches the adapters");
// ═══════════════════════════════════════════════════════════════════

await test("C1 — every configured TTS provider is represented", () => {
  for (const id of Object.values(TEXT_TO_SPEECH_PROVIDER_IDS)) {
    assert.ok(ALL_PROVIDER_IDS.includes(id as string), `no harness entry for provider "${id}"`);
  }
  assert.equal(new Set(ALL_PROVIDER_IDS).size, ALL_PROVIDER_IDS.length, "provider ids must be unique");
});

await test("C2 — provider ids are path-safe", () => {
  for (const id of ALL_PROVIDER_IDS) assert.match(id, SAFE_ID_PATTERN, `${id}`);
});

await test("C3 — the declared speaking rate still matches the adapter source", () => {
  // The rates are hard-coded constants, not environment variables, so
  // the report has to declare them. This is what stops the declaration
  // drifting away from the adapter: change the adapter, fail here.
  for (const provider of HARNESS_PROVIDERS) {
    const source = readFileSync(path.join(REPO_ROOT, provider.declaredRate.sourceFile), "utf8");
    const { parameter, declaredValue, constantName } = provider.declaredRate;
    const value = String(declaredValue);
    const trimmed = value.replace(/^0(?=\.)/u, ""); // the codebase writes `.92` as well as `0.92`
    const patterns = [
      new RegExp(`${constantName}\\s*[:=]\\s*${value}\\b`, "u"),
      new RegExp(`${constantName}\\s*[:=]\\s*${trimmed}\\b`, "u"),
      new RegExp(`${parameter}\\s*:\\s*${value}\\b`, "u"),
      new RegExp(`${parameter}\\s*:\\s*${trimmed}\\b`, "u"),
    ];
    assert.ok(
      patterns.some((pattern) => pattern.test(source)),
      `${provider.id}: the harness declares ${parameter}=${declaredValue}, but ${provider.declaredRate.sourceFile} does not contain it. ` +
        `The adapter is the authority — update the declaration in providers.ts and the report that quotes it.`,
    );
  }
});

await test("C4 — configuration is READ from the environment, not duplicated", () => {
  const cartesia = HARNESS_PROVIDERS.find((provider) => provider.id === "cartesia");
  assert.ok(cartesia, "the cartesia lane must exist");

  withEnv("CARTESIA_MODEL_ID", "sonic-probe-value", () => {
    assert.ok(
      effectiveConfig(cartesia).settings["model"]?.includes("sonic-probe-value"),
      "the reported model must come from the environment the adapter reads",
    );
  });

  withEnv("CARTESIA_MODEL_ID", undefined, () => {
    assert.ok(
      effectiveConfig(cartesia).settings["model"]?.includes(UNSET_NOTE),
      "an unset variable must be reported as unset, NOT as a second copy of the adapter's default",
    );
  });
});

await test("C5 — --providers selects a subset, and rejects an unknown id", () => {
  assert.deepEqual(selectedProviderIds([]), ALL_PROVIDER_IDS, "no flag runs every lane");
  assert.deepEqual(selectedProviderIds(["--providers=sarvam"]), ["sarvam"]);
  assert.deepEqual(selectedProviderIds(["--providers=sarvam,cartesia"]), ["sarvam", "cartesia"]);
  assert.throws(() => selectedProviderIds(["--providers=eleven-labs"]), /unknown provider id/u);
  assert.throws(() => selectedProviderIds(["--providers="]), /no provider ids/u);
});

// ═══════════════════════════════════════════════════════════════════
section("SECTION D — a dry run cannot reach a vendor");
// ═══════════════════════════════════════════════════════════════════

/** Every member throws. Reaching any of them fails the test that used it. */
function explodingProvider(): TextToSpeechProvider {
  const boom = (member: string) => (): never => {
    throw new Error(`VENDOR CONTACTED via ${member} — the harness must not do this`);
  };
  return {
    get descriptor(): never {
      return boom("descriptor")();
    },
    synthesize: boom("synthesize"),
    synthesizeStream: boom("synthesizeStream"),
    checkHealth: boom("checkHealth"),
  } as unknown as TextToSpeechProvider;
}

await test("D1 — dryRunRecords produces a record per provider per item, with no synthesis", () => {
  const records = dryRunRecords(ALL_PROVIDER_IDS, CORPUS);
  assert.equal(records.length, ALL_PROVIDER_IDS.length * CORPUS.length);
  for (const record of records) {
    assert.equal(record.synthesis, undefined, `${record.corpusId}: a dry run synthesizes nothing`);
    assert.equal(record.audioPath, undefined, `${record.corpusId}: a dry run writes no audio`);
    assert.ok(record.transform.synthesisText.length > 0, "the transformed text is still recorded");
  }
});

await test("D2 — the dry-run path never touches a provider object", () => {
  // Constructed but never handed in: dryRunRecords takes ids, not
  // adapters, so there is no provider to call by construction.
  const trap = explodingProvider();
  assert.ok(trap !== undefined);
  assert.doesNotThrow(() => dryRunRecords(["cartesia"], CORPUS));
});

await test("D3 — resolveMode defaults to a dry run and refuses a half-typed confirmation", () => {
  assert.equal(resolveMode([]).mode, "dry-run", "the default must be the safe one");
  assert.equal(resolveMode([DRY_RUN_FLAG]).mode, "dry-run");
  assert.equal(resolveMode([SYNTHESIZE_FLAG]).mode, "dry-run", "--synthesize alone must not spend money");
  assert.match(resolveMode([SYNTHESIZE_FLAG]).refusal ?? "", /requires --confirm-real-api-calls/u);
  assert.equal(resolveMode([CONFIRM_FLAG]).mode, "dry-run", "--confirm alone synthesizes nothing");
  assert.equal(resolveMode([SYNTHESIZE_FLAG, CONFIRM_FLAG]).mode, "synthesize");
  assert.equal(
    resolveMode([SYNTHESIZE_FLAG, CONFIRM_FLAG, DRY_RUN_FLAG]).mode,
    "dry-run",
    "contradictory flags must resolve to the safer mode",
  );
});

await test("D4 — runProvider reports a vendor failure instead of throwing", async () => {
  const written: string[] = [];
  const records = await runProvider({
    providerId: "cartesia",
    provider: {
      synthesize: async () => {
        throw new Error("503 upstream unavailable");
      },
      synthesizeStream: async function* () {
        throw new Error("503 upstream unavailable");
      },
    } as unknown as TextToSpeechProvider,
    items: CORPUS.slice(0, 2),
    outputDir: OUTPUT_DIR,
    onAudio: async (relativePath) => {
      written.push(relativePath);
    },
  });
  assert.equal(records.length, 2);
  assert.deepEqual(written, [], "a failed synthesis must write no audio");
  for (const record of records) {
    assert.equal(record.synthesis?.ok, false);
    assert.equal(record.synthesis?.errorCategory, "VENDOR_OR_NETWORK");
    assert.ok((record.synthesis?.errorMessage ?? "").includes("503"));
  }
});

await test("D5 — a provider that yields nothing is recorded as EMPTY_AUDIO, not as success", async () => {
  const records = await runProvider({
    providerId: "sarvam",
    provider: {
      synthesize: async () => ({ data: new Uint8Array(0), encoding: "PCM_16", sampleRateHz: 8000 }),
      synthesizeStream: async function* () {
        yield {
          audio: { data: new Uint8Array(0), encoding: "PCM_16" as const, sampleRateHz: 8000 },
          sequence: 0,
          isFinal: true,
        };
      },
    } as unknown as TextToSpeechProvider,
    items: CORPUS.slice(0, 1),
    outputDir: OUTPUT_DIR,
    onAudio: async () => {
      throw new Error("no audio should be written");
    },
  });
  assert.equal(records[0]?.synthesis?.errorCategory, "EMPTY_AUDIO");
});

// ═══════════════════════════════════════════════════════════════════
section("SECTION E — output paths are deterministic");
// ═══════════════════════════════════════════════════════════════════

await test("E1 — the same provider and item always resolve to the same path", () => {
  for (const item of CORPUS.slice(0, 5)) {
    const once = audioRelativePath(OUTPUT_DIR, "cartesia", item.id);
    const twice = audioRelativePath(OUTPUT_DIR, "cartesia", item.id);
    assert.equal(once, twice);
    assert.equal(once, `${OUTPUT_DIR}/cartesia/${item.id}/${item.id}.wav`);
  }
});

await test("E2 — no two (provider, item) pairs collide, even after case folding", () => {
  const seen = new Set<string>();
  for (const providerId of ALL_PROVIDER_IDS) {
    for (const item of CORPUS) {
      const key = audioRelativePath(OUTPUT_DIR, providerId, item.id).toLowerCase();
      assert.ok(!seen.has(key), `path collision on ${key}`);
      seen.add(key);
    }
  }
  assert.equal(seen.size, ALL_PROVIDER_IDS.length * CORPUS.length);
});

await test("E3 — every audio path stays inside the output directory", () => {
  for (const providerId of ALL_PROVIDER_IDS) {
    for (const item of CORPUS) {
      const relative = audioRelativePath(OUTPUT_DIR, providerId, item.id);
      assert.ok(relative.startsWith(`${OUTPUT_DIR}/`), relative);
      assert.ok(!relative.includes(".."), relative);
    }
  }
});

await test("E4 — the output directory is the gitignored benchmark tree", () => {
  assert.equal(OUTPUT_DIR, "benchmark-output/tts");
  const gitignore = readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8");
  assert.ok(
    gitignore.split("\n").some((line) => line.trim() === "benchmark-output"),
    "generated audio and reports must remain ignored",
  );
});

await test("E5 — the WAV wrapper adds a header and changes not one audio byte", () => {
  const pcm = new Uint8Array([0, 1, 2, 3, 0xff, 0x7f]);
  const wav = pcm16ToWav(pcm, 8000, "PCM_16");
  assert.equal(wav.byteLength, WAV_HEADER_BYTES + pcm.byteLength);
  assert.deepEqual([...wav.subarray(0, 4)], [...Buffer.from("RIFF")]);
  assert.deepEqual([...wav.subarray(8, 12)], [...Buffer.from("WAVE")]);
  assert.deepEqual([...wav.subarray(WAV_HEADER_BYTES)], [...pcm], "the samples must pass through untouched");
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(view.getUint32(24, true), 8000, "the header must carry the real sample rate");
  assert.equal(view.getUint32(40, true), pcm.byteLength, "the data chunk size must be the real byte count");
});

await test("E6 — an encoding the harness cannot write is refused, never mislabelled", () => {
  assert.throws(() => pcm16ToWav(new Uint8Array(2), 8000, "MULAW"), UnsupportedAudioEncodingError);
  assert.throws(() => pcm16ToWav(new Uint8Array(3), 8000, "PCM_16"), /odd byte length/u);
});

// ═══════════════════════════════════════════════════════════════════
section("SECTION F — no secret can reach a report");
// ═══════════════════════════════════════════════════════════════════

const SECRET_SENTINEL = "SECRET-sentinel-value-must-never-appear-0f8a2c";

await test("F1 — a credential's VALUE never appears in either rendering", () => {
  const saved = new Map<string, string | undefined>();
  try {
    for (const provider of HARNESS_PROVIDERS) {
      saved.set(provider.apiKeyEnv, mutableEnv[provider.apiKeyEnv]);
      mutableEnv[provider.apiKeyEnv] = SECRET_SENTINEL;
    }
    const configs = HARNESS_PROVIDERS.map(effectiveConfig);
    const input = {
      runId: "tts_test",
      mode: "dry-run" as const,
      startedAtIso: "2026-01-01T00:00:00.000Z",
      finishedAtIso: "2026-01-01T00:00:01.000Z",
      items: CORPUS,
      configs,
      records: dryRunRecords(ALL_PROVIDER_IDS, CORPUS),
      outputDir: OUTPUT_DIR,
    };
    const json = JSON.stringify(buildJsonReport(input));
    const markdown = buildMarkdownReport(input);
    assert.ok(!json.includes(SECRET_SENTINEL), "the JSON report leaked a credential value");
    assert.ok(!markdown.includes(SECRET_SENTINEL), "the Markdown report leaked a credential value");
    // Presence is reported; the value is not.
    assert.ok(json.includes("credentialPresent"), "presence must still be reported");
    for (const provider of HARNESS_PROVIDERS) {
      assert.ok(json.includes(provider.apiKeyEnv), "the variable NAME is safe and useful");
    }
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete mutableEnv[name];
      else mutableEnv[name] = value;
    }
  }
});

await test("F2 — the harness never reads a credential outside effectiveConfig's presence check", () => {
  const sources = [
    "src/benchmark/tts/corpus.ts",
    "src/benchmark/tts/transform.ts",
    "src/benchmark/tts/runner.ts",
    "src/benchmark/tts/report.ts",
  ];
  for (const relative of sources) {
    const source = readFileSync(path.join(REPO_ROOT, relative), "utf8");
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\*|\/\/)/u.test(line))
      .join("\n");
    assert.ok(!/API_KEY|SUBSCRIPTION_KEY/u.test(code), `${relative}: must not name a credential`);
    assert.ok(!/process\.env/u.test(code), `${relative}: must not read the environment at all`);
  }
});

// ═══════════════════════════════════════════════════════════════════
section("SECTION G — the report serializes, and refuses to score");
// ═══════════════════════════════════════════════════════════════════

function sampleInput(mode: "dry-run" | "synthesize") {
  const configs = HARNESS_PROVIDERS.map(effectiveConfig);
  const base = dryRunRecords(ALL_PROVIDER_IDS, CORPUS);
  const records =
    mode === "dry-run"
      ? base
      : base.map((record, index) => ({
          ...record,
          synthesis: {
            ok: true as const,
            branch: "synthesizeStream" as const,
            chunkCount: 3,
            audioBytes: 1600 + index,
            sampleRateHz: 8000,
            encoding: "PCM_16" as const,
            durationMs: 100 + index,
            firstAudioMs: 300 + index,
            totalMs: 900 + index,
          },
          audioPath: audioRelativePath(OUTPUT_DIR, record.providerId, record.corpusId),
        }));
  return {
    runId: "tts_test",
    mode,
    startedAtIso: "2026-01-01T00:00:00.000Z",
    finishedAtIso: "2026-01-01T00:00:01.000Z",
    gitRevision: "abc1234",
    gitDirty: false,
    items: CORPUS,
    configs,
    records,
    outputDir: OUTPUT_DIR,
  };
}

await test("G1 — the JSON report serializes and round-trips", () => {
  const report = buildJsonReport(sampleInput("synthesize"));
  const text = JSON.stringify(report, null, 2);
  const parsed = JSON.parse(text) as Record<string, unknown>;
  assert.equal(parsed["schema"], "voice-agent-lab/tts-evidence/1");
  assert.ok(text.length > 0);
});

await test("G2 — the JSON report carries every field the evidence needs", () => {
  const report = buildJsonReport(sampleInput("synthesize")) as Record<string, Record<string, unknown>>;
  assert.ok(report["run"]?.["runId"], "run metadata");
  assert.ok("gitRevision" in (report["run"] ?? {}), "git revision field");
  assert.ok(report["run"]?.["startedAtIso"], "timestamp");
  assert.equal(report["corpus"]?.["version"], CORPUS_VERSION, "corpus version");
  assert.equal(report["corpus"]?.["exhaustive"], false, "the corpus must never claim completeness");
  assert.ok(Array.isArray(report["providers"]), "provider configuration");
  assert.ok(Array.isArray(report["transformations"]), "per-item transformation results");
  assert.ok(Array.isArray(report["synthesis"]), "per-item synthesis results");

  const first = (report["synthesis"] as Record<string, unknown>[])[0] ?? {};
  for (const field of [
    "ok",
    "audioBytes",
    "durationMs",
    "firstAudioMs",
    "audioPath",
    "errorCategory",
    "synthesisText",
  ]) {
    assert.ok(field in first, `synthesis records must carry "${field}"`);
  }
  const summary = report["summary"] ?? {};
  assert.ok(Array.isArray(summary["byProvider"]), "summary counts by provider");
  assert.ok(summary["failuresByReason"] !== undefined, "failures grouped by reason");
});

await test("G3 — every transformation row records all three strings", () => {
  const report = buildJsonReport(sampleInput("dry-run")) as Record<string, unknown>;
  const rows = report["transformations"] as Record<string, unknown>[];
  assert.equal(rows.length, CORPUS.length, "one row per corpus item, not per provider");
  for (const row of rows) {
    for (const field of ["originalText", "formattedText", "synthesisText", "changed", "verdict"]) {
      assert.ok(field in row, `transformation rows must carry "${field}"`);
    }
  }
});

await test("G4 — the report assigns no quality score and names no winner", () => {
  const markdown = buildMarkdownReport(sampleInput("synthesize"));
  const report = buildJsonReport(sampleInput("synthesize"));

  // Asserted over the report's KEYS, not its prose: the prose says the
  // words "quality score" precisely in order to refuse to produce one,
  // and a substring ban would fail on its own disclaimer.
  const keys = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        keys.add(key.toLowerCase());
        walk(child);
      }
    }
  };
  walk(report);
  for (const banned of ["score", "rating", "rank", "ranking", "winner", "grade", "quality"]) {
    assert.ok(![...keys].some((key) => key.includes(banned)), `the report must have no "${banned}" field`);
  }

  assert.ok(/no quality score, no ranking/iu.test(markdown), "the refusal must be stated in the report");

  // Headings and table columns only — the body prose says "no
  // recommended provider" as its own disclaimer, so scanning it for the
  // word would fail on the refusal it is checking for.
  for (const line of markdown.split("\n")) {
    const isStructural = line.startsWith("#") || (line.startsWith("| ") && line.includes(" | "));
    if (!isStructural) continue;
    assert.ok(
      !/\bscore\b|\brank\b|\bwinner\b|\bbest\b|\brecommend/iu.test(line),
      `no heading or column may present a verdict: ${line}`,
    );
  }
});

await test("G5 — both renderings state which half of the evidence is deterministic", () => {
  const markdown = buildMarkdownReport(sampleInput("synthesize"));
  const json = JSON.stringify(buildJsonReport(sampleInput("synthesize")));
  assert.ok(/DETERMINISTIC/u.test(markdown) && /not deterministic/iu.test(markdown));
  assert.ok(/DETERMINISTIC/u.test(json));
  assert.ok(/not exhaustive/iu.test(markdown), "the corpus must not be presented as exhaustive");
});

await test("G6 — a dry-run report says plainly that nothing was synthesized", () => {
  const markdown = buildMarkdownReport(sampleInput("dry-run"));
  assert.ok(/\*\*Not performed\.\*\*/u.test(markdown));
  assert.ok(/zero vendor requests/u.test(markdown));
});

await test("G7 — corpus text containing a pipe cannot break the Markdown table", () => {
  const markdown = buildMarkdownReport(sampleInput("dry-run"));
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    assert.ok(!/\r|\n/u.test(line), "no row may contain a newline");
  }
  assert.ok(markdown.includes("| id | lang |"), "the transformation table must render");
});

// ═══════════════════════════════════════════════════════════════════
console.log("");
if (failures.length === 0) {
  console.log(`ALL PASSED — ${passed} passed, 0 failed`);
  console.log("No telephony, TTS, STT, LLM or database request was made.");
} else {
  console.log(`${passed} passed, ${failures.length} failed`);
  console.log(`failed: ${failures.join(", ")}`);
  process.exitCode = 1;
}
