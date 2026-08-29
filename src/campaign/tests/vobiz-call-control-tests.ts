/**
 * vobiz-call-control-tests.ts — `npm run test:vobiz-call-control`
 *
 * TWO REPORTED PRODUCTION DEFECTS, ONE TELEPHONY PROVIDER.
 *
 *   1. THE CALL RECORDING STOPPED AT ~60 SECONDS while the call went on.
 *      Recording is not done here at all: it is Vobiz's server-side
 *      `POST .../Call/{call_uuid}/Record/`, whose `time_limit` parameter
 *      is documented as "Maximum recording duration in seconds. Default:
 *      60." The request omitted it, so every recording was cut at the
 *      vendor default. Section A pins the parameter to the request.
 *
 *   2. THE CALL STAYED UP AFTER THE AGENT'S CLOSING LINE, although the
 *      campaign watchdog detected the closing and called `manager.end()`
 *      exactly as designed. `end()` -> `endCall(handle)` -> Vobiz
 *      `DELETE .../Call/{handle.providerCallId}/`, and `providerCallId`
 *      was the `request_uuid` from placing the call — Vobiz's hangup API
 *      is keyed by the `call_uuid`, a different identifier that only
 *      exists once the callee answers. Every programmatic hangup was a
 *      404 that `endCall` logged as "call may already have ended". The
 *      `call_uuid` arrives as `start.callId` on the media WebSocket;
 *      Sections B and C pin that it is captured and that the existing
 *      hangup path then uses it.
 *
 * NOT RE-TESTED HERE, DELIBERATELY. "The final reply finishes before the
 * hangup" and "barge-in is unchanged" are owned by `test:agent-hangup`
 * (A1/A2: the closing ends the call after its audio has drained, never
 * during it) and `test:barge-in`. Neither fix touches the code those
 * suites exercise — the hangup DECISION and the playback drain are
 * untouched; only the identifier in the DELETE request changed.
 *
 * NOTHING HERE PLACES A CALL OR TOUCHES THE DATABASE. `fetch` is stubbed
 * for Section A; Sections B and C drive the real bridge and the real
 * session manager against in-memory fakes.
 */

import assert from "node:assert/strict";

import { config as loadEnvFile } from "dotenv";

loadEnvFile({ path: ".env.local", quiet: true });
loadEnvFile({ quiet: true });

const { VobizTelephonyProvider, VOBIZ_RECORDING_TIME_LIMIT_SECONDS } = await import(
  "../../providers/telephony/vobiz.provider"
);
const { attachVobizMediaBridge } = await import("../../server/vobiz-media-bridge");
const { DefaultVoiceSessionManager } = await import("../../core/session/voice-session-manager.impl");
const { getDispatchConfig } = await import("../config/dispatch.config");

import { CallDirection, ProviderCategory, SupportedLanguage } from "../../types/enums";
import type { SessionId } from "../../types/session.types";
import type {
  TelephonyCallHandle,
  TelephonyCallParams,
} from "../../interfaces/providers/telephony-provider.interface";

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

const section = (t: string) => console.log(`\n${t}`);

const providerConfig = {
  authId: "AUTH_ID",
  authToken: "AUTH_TOKEN",
  fromNumber: "+910000000000",
  baseUrl: "https://vobiz.test",
  answerUrl: "https://app.test/api/voice/vobiz/answer",
};

// ═════════════════════════════════════════════════════════════════
section("A. RECORDING: THE START-RECORDING REQUEST CARRIES A time_limit");

interface CapturedFetch {
  url: string;
  method: string | undefined;
  body: Record<string, unknown>;
}

async function captureStartRecording(callUuid: string): Promise<CapturedFetch> {
  const originalFetch = globalThis.fetch;
  let captured: CapturedFetch | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    captured = {
      url: String(input),
      method: init?.method,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    };
    return new Response(JSON.stringify({ recording_id: "rec-1", url: "https://vobiz.test/rec-1.mp3" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await new VobizTelephonyProvider(providerConfig).startRecording(callUuid);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(captured, "startRecording must issue exactly one request");
  return captured;
}

await test("A1. startRecording sends time_limit, so Vobiz's 60s default no longer applies", async () => {
  const request = await captureStartRecording("call-uuid-a1");
  assert.equal(request.method, "POST");
  assert.equal(request.url, "https://vobiz.test/api/v1/Account/AUTH_ID/Call/call-uuid-a1/Record/");
  assert.equal(request.body["time_limit"], VOBIZ_RECORDING_TIME_LIMIT_SECONDS);
  assert.equal(typeof request.body["time_limit"], "number");
  assert.ok(
    (request.body["time_limit"] as number) > 60,
    "the limit must exceed the vendor default that produced the 60s cutoff",
  );
});

await test("A2. the recording format is unchanged: mp3", async () => {
  const request = await captureStartRecording("call-uuid-a2");
  assert.equal(request.body["file_format"], "mp3");
  assert.deepEqual(Object.keys(request.body).sort(), ["file_format", "time_limit"]);
});

await test("A3. the limit is a value Vobiz documents and covers the longest campaign call", () => {
  // Vobiz's Start-Recording documentation names 300 and 900 as the
  // values to use "for longer calls" and states no maximum; 900 is the
  // largest documented value. The campaign watchdog bounds a call at
  // `maxCallSeconds`, so recording lifetime == call lifetime for every
  // campaign call — the recording stops when the call ends, never before.
  assert.equal(VOBIZ_RECORDING_TIME_LIMIT_SECONDS, 900);
  const { maxCallSeconds } = getDispatchConfig();
  assert.ok(
    VOBIZ_RECORDING_TIME_LIMIT_SECONDS >= maxCallSeconds,
    `time_limit ${VOBIZ_RECORDING_TIME_LIMIT_SECONDS}s must cover maxCallSeconds ${maxCallSeconds}s`,
  );
});

// ═════════════════════════════════════════════════════════════════
section("B. BRIDGE: THE WEBSOCKET start EVENT'S callId REACHES THE SESSION MANAGER");

interface FakeSocket {
  readyState: number;
  sent: string[];
  listeners: Map<string, ((...args: unknown[]) => void)[]>;
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
    listeners,
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

function makeBridgeManager() {
  const calls: string[] = [];
  const manager = {
    onOutboundAudio: () => () => undefined,
    onStateChange: () => () => undefined,
    setProviderCallId: (sessionId: SessionId, callId: string) => {
      calls.push(`setProviderCallId:${sessionId}:${callId}`);
    },
    confirmCallAnswered: (sessionId: SessionId) => {
      calls.push(`confirmCallAnswered:${sessionId}`);
    },
    pushInboundAudio: () => undefined,
    signalBargeIn: () => undefined,
    noteCallerSpeech: () => undefined,
    noteCallerEnergy: () => undefined,
    end: async () => undefined,
  };
  return { manager: manager as unknown as InstanceType<typeof DefaultVoiceSessionManager>, calls };
}

await test("B1. start.callId is stored on the session BEFORE the call is confirmed answered", () => {
  const socket = makeSocket();
  const { manager, calls } = makeBridgeManager();
  attachVobizMediaBridge(socket, "sess_b1" as SessionId, manager);
  socket.emit(
    "message",
    JSON.stringify({
      sequenceNumber: 0,
      event: "start",
      start: {
        callId: "5401fd2e-6344-40df-a22c-c8ffea7a92e7",
        streamId: "c4dfd815-a92a-4140-ab85-5ff28c004116",
        accountId: "500025",
        tracks: ["inbound"],
        mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000 },
      },
    }),
  );
  assert.deepEqual(calls, [
    "setProviderCallId:sess_b1:5401fd2e-6344-40df-a22c-c8ffea7a92e7",
    "confirmCallAnswered:sess_b1",
  ]);
});

await test("B2. a start event without callId still confirms the call and stores nothing", () => {
  const socket = makeSocket();
  const { manager, calls } = makeBridgeManager();
  attachVobizMediaBridge(socket, "sess_b2" as SessionId, manager);
  socket.emit("message", JSON.stringify({ event: "start", start: { streamId: "s-1" } }));
  assert.deepEqual(calls, ["confirmCallAnswered:sess_b2"]);
});

await test("B3. non-start events never touch the call id", () => {
  const socket = makeSocket();
  const { manager, calls } = makeBridgeManager();
  attachVobizMediaBridge(socket, "sess_b3" as SessionId, manager);
  socket.emit("message", JSON.stringify({ event: "media", media: { track: "inbound", payload: "" } }));
  socket.emit("message", JSON.stringify({ event: "playedStream" }));
  socket.emit("message", "not json");
  assert.deepEqual(calls, []);
});

// ═════════════════════════════════════════════════════════════════
section("C. MANAGER: end() HANGS UP WITH THE call_uuid, THROUGH THE EXISTING PATH");

function makeFakeTelephony() {
  const endCalls: TelephonyCallHandle[] = [];
  const healthy = (category: ProviderCategory, id: string) => ({
    descriptor: { category, id },
    async checkHealth() {
      return { identifier: { category, id }, isHealthy: true, checkedAt: new Date() };
    },
  });
  const provider = {
    ...healthy(ProviderCategory.TELEPHONY, "vobiz"),
    async startCall(params: TelephonyCallParams): Promise<TelephonyCallHandle> {
      // What the real provider returns: the REST placement's request_uuid.
      return { sessionId: params.sessionId, providerCallId: "request-uuid-from-startCall" };
    },
    async endCall(handle: TelephonyCallHandle): Promise<void> {
      endCalls.push(handle);
    },
  };
  const registry = {
    resolve: (category: ProviderCategory) =>
      category === ProviderCategory.TELEPHONY ? provider : healthy(category, "stub"),
  } as never;
  return { registry, endCalls };
}

async function startedSession(manager: InstanceType<typeof DefaultVoiceSessionManager>): Promise<SessionId> {
  const created = await manager.createSession({
    language: SupportedLanguage.ENGLISH,
    direction: CallDirection.OUTBOUND,
    destinationNumber: "+919999999999",
    providerStack: {
      telephony: { category: ProviderCategory.TELEPHONY, id: "vobiz" },
      speechToText: { category: ProviderCategory.SPEECH_TO_TEXT, id: "deepgram" },
      languageModel: { category: ProviderCategory.LANGUAGE_MODEL, id: "gpt-5.1" },
      textToSpeech: { category: ProviderCategory.TEXT_TO_SPEECH, id: "cartesia" },
    },
  });
  // The real state machine: INITIALIZING -> WARMING_PROVIDERS -> READY -> CALLING.
  await manager.warmUpProviders(created.id);
  await manager.start(created.id);
  return created.id;
}

await test("C1. after setProviderCallId, end() calls endCall with the call_uuid, not the request_uuid", async () => {
  const { registry, endCalls } = makeFakeTelephony();
  const manager = new DefaultVoiceSessionManager(registry);
  const sessionId = await startedSession(manager);

  manager.setProviderCallId(sessionId, "call-uuid-from-start-event");
  await manager.end(sessionId);

  assert.equal(endCalls.length, 1, "end() must hang up exactly once, through telephony.endCall");
  assert.equal(endCalls[0]!.providerCallId, "call-uuid-from-start-event");
  assert.equal(endCalls[0]!.sessionId, sessionId, "the handle's session binding is preserved");
});

await test("C2. without a start event the handle is untouched (the pre-fix identifier)", async () => {
  // A call that never reached the media stream — no answer, a failed
  // upgrade — has no call_uuid to use. Nothing about that path changed.
  const { registry, endCalls } = makeFakeTelephony();
  const manager = new DefaultVoiceSessionManager(registry);
  const sessionId = await startedSession(manager);
  await manager.end(sessionId);
  assert.equal(endCalls[0]!.providerCallId, "request-uuid-from-startCall");
});

await test("C3. setProviderCallId is inert for an unknown session and before start()", async () => {
  const { registry, endCalls } = makeFakeTelephony();
  const manager = new DefaultVoiceSessionManager(registry);
  // Socket callbacks can outlive a session; this must not throw.
  manager.setProviderCallId("sess_gone" as SessionId, "call-uuid-x");

  const created = await manager.createSession({
    language: SupportedLanguage.ENGLISH,
    direction: CallDirection.OUTBOUND,
    destinationNumber: "+919999999999",
    providerStack: {
      telephony: { category: ProviderCategory.TELEPHONY, id: "vobiz" },
      speechToText: { category: ProviderCategory.SPEECH_TO_TEXT, id: "deepgram" },
      languageModel: { category: ProviderCategory.LANGUAGE_MODEL, id: "gpt-5.1" },
      textToSpeech: { category: ProviderCategory.TEXT_TO_SPEECH, id: "cartesia" },
    },
  });
  // No handle exists yet — there is no call to re-key.
  manager.setProviderCallId(created.id, "call-uuid-too-early");
  await manager.warmUpProviders(created.id);
  await manager.start(created.id);
  await manager.end(created.id);
  assert.equal(endCalls.length, 1);
  assert.equal(endCalls[0]!.providerCallId, "request-uuid-from-startCall");
});

await test("C4. the real provider's DELETE targets the call_uuid in the handle it is given", async () => {
  const originalFetch = globalThis.fetch;
  let captured: { url: string; method: string | undefined } | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(input), method: init?.method };
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  try {
    await new VobizTelephonyProvider(providerConfig).endCall({
      sessionId: "sess_c4" as SessionId,
      providerCallId: "call-uuid-c4",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(captured?.method, "DELETE");
  assert.equal(captured?.url, "https://vobiz.test/api/v1/Account/AUTH_ID/Call/call-uuid-c4/");
});

// ═════════════════════════════════════════════════════════════════
console.log(`\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exitCode = 1;
}
