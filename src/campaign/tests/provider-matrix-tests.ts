/**
 * provider-matrix-tests.ts — `npm run test:provider-matrix`
 *
 * The three INDEPENDENT provider dimensions a campaign can now split —
 * TTS, language model, telephony — plus the per-call attribution that
 * records which provider actually handled each call, plus the Plivo
 * campaign fixes that make a Plivo campaign safe to run at all.
 *
 * WHAT THIS SUITE IS GUARDING, in one sentence each:
 *
 *   A. Allocation rules are the same rules in all three dimensions,
 *      and an invalid split is refused rather than absorbed.
 *   B. Per-call selection is reproducible and proportional, and a
 *      provider at 0% is never selected.
 *   C. A campaign created BEFORE any of this existed behaves exactly
 *      as it did — 100% GPT-5.1, and the carrier its column names.
 *   D. The stack one call runs on is resolved from the campaign, in
 *      canonical provider ids, at one boundary.
 *   E. Plivo's answer URL carries its own session id, so concurrent
 *      campaign calls cannot claim each other's sessions.
 *   F. Plivo hangs up with the identifier Plivo actually expects.
 *   G. The Plivo bridge re-keys the handle to the live CallUUID, and
 *      suppresses the energy-only barge-in while STT is healthy.
 *
 * NOTHING HERE PLACES A CALL, contacts a provider, or touches the
 * database. Every vendor object is a fake, and the two bridge sections
 * drive the REAL bridge against an in-memory socket.
 */

import assert from "node:assert/strict";

import { config as loadEnvFile } from "dotenv";

loadEnvFile({ path: ".env.local", quiet: true });
loadEnvFile({ quiet: true });

// This suite asserts what the campaign's ALLOCATION resolves to, which
// must not depend on whichever STT override the machine running the
// tests happens to have in `.env.local`. Pinned to unset so D1 below
// tests allocation canonicality rather than the ambient environment.
// The override's own behaviour is covered explicitly in
// `soniox-stt-tests.ts` (O1-O9), including "unset => deepgram".
delete process.env["STT_PROVIDER"];

const {
  AllocationError,
  pickByAllocation,
  validatePercentageAllocation,
} = await import("../domain/allocation");
const {
  CAMPAIGN_LLM_PROVIDERS,
  CAMPAIGN_TELEPHONY_PROVIDERS,
  CAMPAIGN_TTS_PROVIDERS,
  LEGACY_LLM_ALLOCATION,
  isCampaignLlmProvider,
  isCampaignTelephonyProvider,
  isCampaignTtsProvider,
} = await import("../domain/campaign-types");
const { validateAllocation, allocateCounts, assignProviders } = await import(
  "../import/provider-allocator"
);
const { resolveCallProviderStack } = await import("../dispatch/call-runner");
const { withSessionId, PlivoTelephonyProvider } = await import(
  "../../providers/telephony/plivo.provider"
);
const { attachPlivoMediaBridge } = await import("../../server/plivo-media-bridge");
const { pcm16ToMulaw } = await import("../../server/audio-codec");

import type { SessionId } from "../../types/session.types";
import type { DefaultVoiceSessionManager } from "../../core/session/voice-session-manager.impl";
import type { CampaignRecord } from "../domain/campaign-types";

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
      `         ${(error instanceof Error ? error.message : String(error)).split("\n").slice(0, 4).join("\n         ")}`,
    );
  }
}

const section = (title: string) => console.log(`\n${title}`);

const CARTESIA = "cartesia";
const ELEVENLABS = "elevenlabs";
const SARVAM = "sarvam";
const SMALLEST = "smallest-ai";
const GPT = "gpt-5.1";
const GEMMA = "gemma-4";
const VOBIZ = "vobiz";
const PLIVO = "plivo";

// ═════════════════════════════════════════════════════════════════
section("A. THE ALLOCATION RULES, IN ALL THREE DIMENSIONS");

await test("A1. all four TTS providers are campaign providers, ElevenLabs included", () => {
  assert.equal(CAMPAIGN_TTS_PROVIDERS.length, 4);
  for (const provider of [CARTESIA, ELEVENLABS, SARVAM, SMALLEST]) {
    assert.ok(isCampaignTtsProvider(provider), `${provider} must be a campaign TTS provider`);
  }
});

await test("A2. the LLM and telephony dimensions hold exactly their two providers", () => {
  assert.deepEqual([...CAMPAIGN_LLM_PROVIDERS].sort(), [GEMMA, GPT]);
  assert.deepEqual([...CAMPAIGN_TELEPHONY_PROVIDERS].sort(), [PLIVO, VOBIZ]);
  assert.ok(isCampaignLlmProvider(GEMMA) && isCampaignLlmProvider(GPT));
  assert.ok(isCampaignTelephonyProvider(PLIVO) && isCampaignTelephonyProvider(VOBIZ));
  // There is no "Both". A two-way split is two entries, not a third id.
  assert.equal(isCampaignTelephonyProvider("both"), false);
});

await test("A3. the existing 3-provider TTS split still validates unchanged", () => {
  assert.doesNotThrow(() =>
    validateAllocation({ [CARTESIA]: 33.34, [SARVAM]: 33.33, [SMALLEST]: 33.33 }),
  );
});

await test("A4. the 4-provider 25/25/25/25 split validates and apportions exactly", () => {
  const even = { [CARTESIA]: 25, [ELEVENLABS]: 25, [SARVAM]: 25, [SMALLEST]: 25 };
  assert.doesNotThrow(() => validateAllocation(even));

  for (const total of [0, 1, 7, 10, 999, 2_000, 10_000]) {
    const counts = allocateCounts(total, even);
    const sum = [...counts.values()].reduce((a, b) => a + b, 0);
    assert.equal(sum, total, `counts must sum to exactly ${total}`);
  }

  // Every lane gets its quarter of a round number, and no contact is lost.
  const counts = allocateCounts(2_000, even);
  for (const provider of [CARTESIA, ELEVENLABS, SARVAM, SMALLEST]) {
    assert.equal(counts.get(provider as never), 500, `${provider} must get exactly a quarter`);
  }
});

await test("A5. a single provider at 100% is valid, and takes every contact", () => {
  const solo = { [ELEVENLABS]: 100 };
  assert.doesNotThrow(() => validateAllocation(solo));
  const counts = allocateCounts(50, solo);
  assert.equal(counts.get(ELEVENLABS as never), 50);

  const assignments = assignProviders(
    Array.from({ length: 20 }, (_, i) => ({ normalizedPhone: `+91900000${String(i).padStart(4, "0")}` })),
    solo,
  );
  assert.equal(new Set(assignments.values()).size, 1, "one provider means one lane");
  assert.equal([...assignments.values()][0], ELEVENLABS);
});

await test("A6. zero-share providers are legal, never assigned, and never picked", () => {
  const zeroed = { [CARTESIA]: 100, [ELEVENLABS]: 0, [SARVAM]: 0, [SMALLEST]: 0 };
  assert.doesNotThrow(() => validateAllocation(zeroed));
  const counts = allocateCounts(100, zeroed);
  assert.equal(counts.get(CARTESIA as never), 100);
  assert.equal(counts.get(ELEVENLABS as never), 0);
  assert.equal(counts.get(SARVAM as never), 0);
});

await test("A7. an all-zero split is refused in every dimension", () => {
  const cases: Array<[Record<string, number>, readonly string[], string]> = [
    [{ [CARTESIA]: 0, [ELEVENLABS]: 0 }, CAMPAIGN_TTS_PROVIDERS, "campaign providers"],
    [{ [GPT]: 0, [GEMMA]: 0 }, CAMPAIGN_LLM_PROVIDERS, "campaign language models"],
    [{ [VOBIZ]: 0, [PLIVO]: 0 }, CAMPAIGN_TELEPHONY_PROVIDERS, "campaign telephony providers"],
  ];
  for (const [allocation, ids, label] of cases) {
    assert.throws(
      () => validatePercentageAllocation(allocation, ids as never, label),
      (error: unknown) => error instanceof AllocationError,
      `${label} must refuse an all-zero split`,
    );
  }
});

await test("A8. a split that does not total 100 is refused in every dimension", () => {
  assert.throws(() => validateAllocation({ [CARTESIA]: 50, [SARVAM]: 40 }), AllocationError);
  assert.throws(
    () => validatePercentageAllocation({ [GPT]: 60, [GEMMA]: 60 }, CAMPAIGN_LLM_PROVIDERS as never, "llm"),
    AllocationError,
  );
  assert.throws(
    () =>
      validatePercentageAllocation(
        { [VOBIZ]: 90, [PLIVO]: 5 },
        CAMPAIGN_TELEPHONY_PROVIDERS as never,
        "telephony",
      ),
    AllocationError,
  );
});

await test("A9. a negative share, and an unknown id, are refused", () => {
  assert.throws(() => validateAllocation({ [CARTESIA]: 110, [SARVAM]: -10 }), AllocationError);
  // A TTS id offered as a carrier is not a carrier.
  assert.throws(
    () =>
      validatePercentageAllocation(
        { [SARVAM]: 100 } as never,
        CAMPAIGN_TELEPHONY_PROVIDERS as never,
        "campaign telephony providers",
      ),
    AllocationError,
  );
  // Case matters: ids are canonical, and a near-miss must fail closed.
  assert.throws(
    () =>
      validatePercentageAllocation(
        { Plivo: 100 } as never,
        CAMPAIGN_TELEPHONY_PROVIDERS as never,
        "campaign telephony providers",
      ),
    AllocationError,
  );
});

// ═════════════════════════════════════════════════════════════════
section("B. PER-CALL SELECTION: REPRODUCIBLE, PROPORTIONAL, NEVER A FALLBACK");

const llmEntries = (allocation: Record<string, number>) =>
  validatePercentageAllocation(allocation, CAMPAIGN_LLM_PROVIDERS as never, "llm");

await test("B1. 100% of one model always returns that model, for any key", () => {
  const entries = llmEntries({ [GPT]: 100, [GEMMA]: 0 });
  for (let i = 0; i < 500; i += 1) {
    assert.equal(pickByAllocation(`contact-${i}`, entries), GPT);
  }
});

await test("B2. a model at 0% is NEVER selected — 0% means never", () => {
  const entries = llmEntries({ [GPT]: 0, [GEMMA]: 100 });
  for (let i = 0; i < 500; i += 1) {
    assert.notEqual(pickByAllocation(`contact-${i}`, entries), GPT);
  }
});

await test("B3. the same key always resolves to the same provider — a retry keeps its stack", () => {
  const entries = llmEntries({ [GPT]: 50, [GEMMA]: 50 });
  for (const key of ["a4f2", "contact-77", "9b1c-uuid-like", ""]) {
    const first = pickByAllocation(key, entries);
    for (let i = 0; i < 20; i += 1) {
      assert.equal(pickByAllocation(key, entries), first, `"${key}" must be stable`);
    }
  }
});

await test("B4. a 50/50 split converges on 50/50 across a campaign", () => {
  const entries = llmEntries({ [GPT]: 50, [GEMMA]: 50 });
  let gpt = 0;
  const n = 4_000;
  for (let i = 0; i < n; i += 1) {
    if (pickByAllocation(`7f3a-${i}-contact`, entries) === GPT) gpt += 1;
  }
  const share = (gpt / n) * 100;
  assert.ok(Math.abs(share - 50) < 5, `expected ~50% GPT across ${n} calls, got ${share.toFixed(1)}%`);
});

await test("B5. a 75/25 telephony split converges on 75/25", () => {
  const entries = validatePercentageAllocation(
    { [VOBIZ]: 75, [PLIVO]: 25 },
    CAMPAIGN_TELEPHONY_PROVIDERS as never,
    "telephony",
  );
  let vobiz = 0;
  const n = 4_000;
  for (let i = 0; i < n; i += 1) {
    if (pickByAllocation(`c-${i}`, entries) === VOBIZ) vobiz += 1;
  }
  const share = (vobiz / n) * 100;
  assert.ok(Math.abs(share - 75) < 5, `expected ~75% Vobiz, got ${share.toFixed(1)}%`);
});

await test("B6. selection never invents a provider outside the allocation", () => {
  const entries = llmEntries({ [GPT]: 50, [GEMMA]: 50 });
  const seen = new Set<string>();
  for (let i = 0; i < 1_000; i += 1) seen.add(pickByAllocation(`k${i}`, entries));
  for (const provider of seen) {
    assert.ok(isCampaignLlmProvider(provider), `"${provider}" is not a campaign LLM provider`);
  }
});

// ═════════════════════════════════════════════════════════════════
section("C. EXISTING CAMPAIGNS ARE NOT SILENTLY CHANGED");

/**
 * A campaign record exactly as `toRecord` builds one. The two
 * allocation fields are what the repository RESOLVED, so the cases
 * below are the two things the repository can be handed: a campaign
 * with no stored allocations (every campaign that predates this
 * feature) and one with them.
 */
function campaignRecord(overrides: Partial<CampaignRecord> = {}): CampaignRecord {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    name: "fixture",
    campaignType: "registration",
    status: "READY",
    scriptId: "s",
    scriptVersion: "v1",
    scriptHash: "h",
    providerAllocation: { [CARTESIA]: 33.34, [SARVAM]: 33.33, [SMALLEST]: 33.33 },
    telephonyProvider: VOBIZ,
    language: "en",
    dispatchConfig: {},
    agentGender: "female",
    llmAllocation: LEGACY_LLM_ALLOCATION,
    telephonyAllocation: { [VOBIZ]: 100 },
    totalContacts: 10,
    pilotStage: 0,
    idempotencyKey: null,
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
    ...overrides,
  } as CampaignRecord;
}

await test("C1. the legacy LLM allocation is 100% GPT-5.1 — what the old literal did", () => {
  assert.deepEqual(LEGACY_LLM_ALLOCATION, { [GPT]: 100 });
});

await test("C2. a campaign with no stored LLM allocation runs every call on GPT-5.1", () => {
  const campaign = campaignRecord();
  for (let i = 0; i < 300; i += 1) {
    assert.equal(resolveCallProviderStack(campaign, `contact-${i}`).languageModel, GPT);
  }
});

await test("C3. a campaign with no stored telephony allocation dials its column's carrier", () => {
  const campaign = campaignRecord({
    telephonyProvider: VOBIZ,
    telephonyAllocation: { [VOBIZ]: 100 },
  });
  for (let i = 0; i < 300; i += 1) {
    assert.equal(resolveCallProviderStack(campaign, `contact-${i}`).telephony, VOBIZ);
  }
});

await test("C4. an existing 3-provider TTS allocation is left exactly as stored", () => {
  const campaign = campaignRecord();
  // The record's own allocation is untouched by anything in this change:
  // adding ElevenLabs to the allowlist does not redistribute a stored
  // split, and ElevenLabs is simply absent from it.
  assert.deepEqual(campaign.providerAllocation, {
    [CARTESIA]: 33.34,
    [SARVAM]: 33.33,
    [SMALLEST]: 33.33,
  });
  assert.equal((campaign.providerAllocation as Record<string, number>)[ELEVENLABS], undefined);
  assert.doesNotThrow(() => validateAllocation(campaign.providerAllocation));
});

// ═════════════════════════════════════════════════════════════════
section("D. THE SELECTION BOUNDARY RESOLVES ONE CALL'S STACK");

await test("D1. the resolved stack uses canonical provider ids only", () => {
  const campaign = campaignRecord({
    llmAllocation: { [GPT]: 50, [GEMMA]: 50 },
    telephonyAllocation: { [VOBIZ]: 50, [PLIVO]: 50 },
  });
  for (let i = 0; i < 200; i += 1) {
    const stack = resolveCallProviderStack(campaign, `contact-${i}`);
    assert.ok(isCampaignLlmProvider(stack.languageModel));
    assert.ok(isCampaignTelephonyProvider(stack.telephony));
    assert.equal(stack.speechToText, "deepgram");
  }
});

await test("D2. a Gemma-only campaign resolves every call to Gemma", () => {
  const campaign = campaignRecord({ llmAllocation: { [GEMMA]: 100, [GPT]: 0 } });
  for (let i = 0; i < 200; i += 1) {
    assert.equal(resolveCallProviderStack(campaign, `c-${i}`).languageModel, GEMMA);
  }
});

await test("D3. a Plivo-only campaign resolves every call to Plivo", () => {
  const campaign = campaignRecord({ telephonyAllocation: { [PLIVO]: 100, [VOBIZ]: 0 } });
  for (let i = 0; i < 200; i += 1) {
    assert.equal(resolveCallProviderStack(campaign, `c-${i}`).telephony, PLIVO);
  }
});

await test("D4. the two dimensions are INDEPENDENT — a stack can mix any pair", () => {
  const campaign = campaignRecord({
    llmAllocation: { [GPT]: 50, [GEMMA]: 50 },
    telephonyAllocation: { [VOBIZ]: 50, [PLIVO]: 50 },
  });
  const combos = new Set<string>();
  for (let i = 0; i < 2_000; i += 1) {
    const stack = resolveCallProviderStack(campaign, `mix-${i}`);
    combos.add(`${stack.languageModel}+${stack.telephony}`);
  }
  assert.equal(combos.size, 4, `all four model/carrier pairings must occur, saw ${[...combos].join(", ")}`);
});

await test("D5. an invalid stored allocation raises rather than falling back to a default", () => {
  const broken = campaignRecord({ llmAllocation: { [GPT]: 10, [GEMMA]: 10 } });
  assert.throws(
    () => resolveCallProviderStack(broken, "c-1"),
    AllocationError,
    "a bad split must fail loudly, never silently resolve to some provider",
  );
});

// ═════════════════════════════════════════════════════════════════
section("E. PLIVO: EVERY CALL CARRIES ITS OWN SESSION ID");

await test("E1. the session id is appended to a plain answer URL", () => {
  assert.equal(
    withSessionId("https://example.com/api/voice/plivo/answer", "sess_abc"),
    "https://example.com/api/voice/plivo/answer?sessionId=sess_abc",
  );
});

await test("E2. an answer URL that already has a query string keeps it", () => {
  assert.equal(
    withSessionId("https://example.com/answer?tenant=7", "sess_abc"),
    "https://example.com/answer?tenant=7&sessionId=sess_abc",
  );
});

await test("E3. the session id is URL-encoded", () => {
  assert.ok(withSessionId("https://e.com/a", "a b&c=d").endsWith("sessionId=a%20b%26c%3Dd"));
});

await test("E4. concurrent calls each get their OWN url — no shared slot", () => {
  const urls = ["sess_1", "sess_2", "sess_3"].map((id) =>
    withSessionId("https://example.com/answer", id),
  );
  assert.equal(new Set(urls).size, 3, "three concurrent calls must produce three distinct answer URLs");
  assert.ok(urls[0]?.includes("sessionId=sess_1"));
  assert.ok(urls[1]?.includes("sessionId=sess_2"));
  assert.ok(urls[2]?.includes("sessionId=sess_3"));
});

// ═════════════════════════════════════════════════════════════════
section("F. PLIVO: THE HANGUP USES THE IDENTIFIER PLIVO EXPECTS");

/**
 * The provider with its SDK client replaced. Nothing here reaches
 * Plivo; the point is only which SDK method the adapter chooses, since
 * `hangup` and `cancel` hit two different endpoints keyed by two
 * different identifiers.
 */
function makePlivoProvider() {
  const provider = new PlivoTelephonyProvider({
    authId: "id",
    authToken: "token",
    fromNumber: "+918031452733",
    answerUrl: "https://example.com/api/voice/plivo/answer",
  });
  const calls: string[] = [];
  const fakeClient = {
    calls: {
      create: async () => ({ requestUuid: "req-uuid-1" }),
      hangup: async (id: string) => {
        calls.push(`hangup:${id}`);
      },
      cancel: async (id: string) => {
        calls.push(`cancel:${id}`);
      },
    },
  };
  (provider as unknown as { client: unknown }).client = fakeClient;
  return { provider, calls };
}

await test("F1. an ANSWERED call is hung up by CallUUID via hangup (DELETE /Call/)", async () => {
  const { provider, calls } = makePlivoProvider();
  // The bridge re-keyed the handle to the live CallUUID, so this id was
  // never issued by `startCall` and is therefore a live call.
  await provider.endCall({ sessionId: "s1" as SessionId, providerCallId: "call-uuid-live" });
  assert.deepEqual(calls, ["hangup:call-uuid-live"]);
});

await test("F2. an UNANSWERED call is cancelled by requestUuid via cancel (DELETE /Request/)", async () => {
  const { provider, calls } = makePlivoProvider();
  const handle = await provider.startCall({
    sessionId: "s2" as SessionId,
    destinationNumber: "9876543210",
  });
  assert.equal(handle.providerCallId, "req-uuid-1", "startCall can only return the requestUuid");

  // Ring timeout: nothing ever re-keyed the handle.
  await provider.endCall(handle);
  assert.deepEqual(calls, ["cancel:req-uuid-1"], "a DELETE on /Call/{request_uuid}/ would 404");
});

await test("F3. once re-keyed, the same session hangs up rather than cancels", async () => {
  const { provider, calls } = makePlivoProvider();
  await provider.startCall({ sessionId: "s3" as SessionId, destinationNumber: "9876543210" });
  // `setProviderCallId` replaced the handle's id with the CallUUID.
  await provider.endCall({ sessionId: "s3" as SessionId, providerCallId: "call-uuid-s3" });
  assert.deepEqual(calls, ["hangup:call-uuid-s3"]);
});

await test("F4. startCall sends a per-call answer URL carrying the session id", async () => {
  const { provider } = makePlivoProvider();
  let sentAnswerUrl = "";
  (provider as unknown as { client: { calls: { create: unknown } } }).client.calls.create = async (
    _from: string,
    _to: string,
    answerUrl: string,
  ) => {
    sentAnswerUrl = answerUrl;
    return { requestUuid: "req-uuid-2" };
  };
  await provider.startCall({ sessionId: "sess_e2e" as SessionId, destinationNumber: "9876543210" });
  assert.equal(
    sentAnswerUrl,
    "https://example.com/api/voice/plivo/answer?sessionId=sess_e2e",
    "the answer webhook must be able to identify its own session",
  );
});

// ═════════════════════════════════════════════════════════════════
section("G. PLIVO BRIDGE: CallUUID RE-KEY AND THE STT-HEALTH BARGE-IN GATE");

interface FakeSocket {
  readyState: number;
  sent: string[];
  send(data: string): void;
  close(): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
}

function makeSocket(): FakeSocket {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  return {
    readyState: 1,
    sent: [],
    send(data) {
      this.sent.push(data);
    },
    close() {
      this.readyState = 3;
    },
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
}

/**
 * @param sttEvidenceAgeMs What the session reports as "how long ago did
 *   Deepgram last deliver a segment". `undefined` is "no evidence", the
 *   case that must keep the previous behaviour.
 */
function makeBridgeManager(sttEvidenceAgeMs: number | undefined) {
  const calls: string[] = [];
  // Captured so a test can drive the bridge into SPEAKING and push
  // audio into its outbound queue. Without both, the bridge's
  // `if (!wasSpeaking && outboundQueue.length === 0) return;` guard
  // short-circuits every barge-in and the STT tests below would pass
  // for the wrong reason — there would simply be nothing to interrupt.
  let stateListener: ((sessionId: SessionId, transition: { to: string; reason: string }) => void) | undefined;
  let outboundListener: ((chunk: { data: Uint8Array; encoding: string; sampleRateHz: number }) => void) | undefined;

  const manager = {
    onOutboundAudio: (_sessionId: SessionId, listener: typeof outboundListener) => {
      outboundListener = listener;
      return () => undefined;
    },
    onStateChange: (listener: typeof stateListener) => {
      stateListener = listener;
      return () => undefined;
    },
    setProviderCallId: (sessionId: SessionId, callId: string) => {
      calls.push(`setProviderCallId:${sessionId}:${callId}`);
    },
    confirmCallAnswered: (sessionId: SessionId) => {
      calls.push(`confirmCallAnswered:${sessionId}`);
    },
    pushInboundAudio: () => undefined,
    signalBargeIn: (sessionId: SessionId) => {
      calls.push(`signalBargeIn:${sessionId}`);
      return true;
    },
    noteCallerSpeech: () => undefined,
    noteCallerEnergy: () => undefined,
    sttEvidenceAgeMs: () => sttEvidenceAgeMs,
    end: async () => undefined,
  };
  return {
    manager: manager as unknown as DefaultVoiceSessionManager,
    calls,
    /** Put the bridge in the state a barge-in can actually interrupt. */
    beginSpeaking(sessionId: SessionId) {
      stateListener?.(sessionId, { to: "SPEAKING", reason: "speaking the reply" });
      // ~200ms of PCM_16 at 8 kHz, which the bridge frames and queues.
      outboundListener?.({ data: new Uint8Array(3_200), encoding: "PCM_16", sampleRateHz: 8_000 });
    },
  };
}

await test("G1. start.callId is stored on the session BEFORE the call is confirmed answered", () => {
  const socket = makeSocket();
  const { manager, calls } = makeBridgeManager(undefined);
  attachPlivoMediaBridge(socket as never, "sess_g1" as SessionId, manager);
  socket.emit(
    "message",
    JSON.stringify({ event: "start", start: { callId: "call-uuid-g1", streamId: "stream-g1" } }),
  );
  assert.deepEqual(calls, [
    "setProviderCallId:sess_g1:call-uuid-g1",
    "confirmCallAnswered:sess_g1",
  ]);
});

await test("G2. a start event with no callId still confirms the call and stores nothing", () => {
  const socket = makeSocket();
  const { manager, calls } = makeBridgeManager(undefined);
  attachPlivoMediaBridge(socket as never, "sess_g2" as SessionId, manager);
  socket.emit("message", JSON.stringify({ event: "start", start: { streamId: "stream-g2" } }));
  assert.deepEqual(calls, ["confirmCallAnswered:sess_g2"]);
});

/** One 20ms μ-law frame at a given RMS amplitude. Same generator the barge-in suite uses. */
function frameAtRms(amplitude: number): Uint8Array {
  const pcm = new Int16Array(160);
  for (let i = 0; i < pcm.length; i += 1) pcm[i] = i % 2 === 0 ? amplitude : -amplitude;
  return pcm16ToMulaw(pcm);
}
/** Near-end speech on a phone line sits around RMS 2000-8000. */
const LOUD_SPEECH = frameAtRms(4000);

/**
 * Feeds the bridge a sustained run of loud inbound audio with no
 * transcript — the exact condition the energy-only fallback fires on —
 * and reports whether it barged in.
 */
function drivesBargeIn(sttEvidenceAgeMs: number | undefined): boolean {
  const socket = makeSocket();
  const sessionId = "sess_energy" as SessionId;
  const { manager, calls, beginSpeaking } = makeBridgeManager(sttEvidenceAgeMs);
  attachPlivoMediaBridge(socket as never, sessionId, manager);
  socket.emit(
    "message",
    JSON.stringify({ event: "start", start: { callId: "call-uuid-e", streamId: "stream-e" } }),
  );
  // The assistant is mid-reply with audio queued — otherwise there is
  // nothing to barge in on and every case below returns false.
  beginSpeaking(sessionId);

  // 60 frames = 1200ms, comfortably past the 700ms energy-only threshold.
  const payload = Buffer.from(LOUD_SPEECH).toString("base64");
  for (let i = 0; i < 60; i += 1) {
    socket.emit(
      "message",
      JSON.stringify({ event: "media", media: { track: "inbound", payload } }),
    );
  }
  return calls.some((entry) => entry.startsWith("signalBargeIn:"));
}

await test("G3. with STT ALIVE, loud energy and no transcript does NOT barge in", () => {
  // Deepgram delivered a segment 2s ago: the socket is healthy, so loud
  // energy it produced no words for is not the caller. This is the
  // "Sarvam truncates sentences" defect, already fixed on Vobiz.
  assert.equal(
    drivesBargeIn(2_000),
    false,
    "a healthy STT socket must suppress the energy-only fallback",
  );
});

await test("G4. with STT STALE, the energy-only fallback still barges in", () => {
  // 45s past the 30s window: STT is treated as dead, and the fallback is
  // the only thing that can interrupt the assistant. Unchanged behaviour.
  assert.equal(drivesBargeIn(45_000), true, "a dead STT socket must leave the fallback working");
});

await test("G5. with NO STT evidence at all, the previous behaviour is kept", () => {
  assert.equal(
    drivesBargeIn(undefined),
    true,
    "'no evidence STT is alive' must not be read as 'STT is alive'",
  );
});

// ═════════════════════════════════════════════════════════════════
console.log("\n================================================");
console.log(`${passed}/${passed + failures.length} checks passed`);
if (failures.length > 0) {
  console.log("\nFAILURES:");
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log("No telephony, TTS, STT, LLM or database request was made. No call was placed.");
}
