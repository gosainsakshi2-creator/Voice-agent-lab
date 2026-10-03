/**
 * access-control-tests.ts — `npm run test:access-control`
 *
 * The dashboard/API login (`src/proxy.ts`, `APP_BASIC_AUTH_PASSWORD`) and
 * the carrier webhook token (`webhook-auth.ts`, `TELEPHONY_WEBHOOK_SECRET`).
 * Both are off unless their variable is set, and with it unset every
 * request passes exactly as before. No call is placed.
 */

import assert from "node:assert/strict";

import { NextRequest } from "next/server";

const { proxy } = await import("../../proxy");
const { withWebhookToken, webhookTokenValid } = await import("../../server/webhook-auth");
const vobizAnswer = await import("../../app/api/voice/vobiz/answer/route");
const plivoAnswer = await import("../../app/api/voice/plivo/answer/route");

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  [FAIL] ${name}\n         ${error instanceof Error ? error.message : String(error)}`);
  }
}

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void> | void): () => Promise<void> {
  return async () => {
    const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(before)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
  };
}

const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
const req = (path: string, auth?: string) =>
  new NextRequest(`https://agent.example.com${path}`, auth === undefined ? {} : { headers: { authorization: auth } });
const passes = (path: string, auth?: string) => proxy(req(path, auth)).status !== 401;

const LOGIN = { APP_BASIC_AUTH_PASSWORD: "s3cret", APP_BASIC_AUTH_USER: undefined };

await test("A1. no password configured: every request passes, exactly as before", withEnv({ APP_BASIC_AUTH_PASSWORD: undefined }, () => {
  for (const path of ["/", "/api/sessions", "/api/campaigns/x/start", "/api/call-analytics/export"]) assert.ok(passes(path), path);
}));

await test("A2. password configured: pages and APIs need credentials, and ask the browser for them", withEnv(LOGIN, () => {
  for (const path of ["/", "/api/sessions", "/api/campaigns/x/start", "/api/call-analytics/export"]) assert.ok(!passes(path), path);
  assert.match(proxy(req("/api/sessions")).headers.get("www-authenticate") ?? "", /^Basic realm=/);
}));

await test("A3. the right user and password pass; a wrong one, a wrong user, or garbage do not", withEnv(LOGIN, () => {
  assert.ok(passes("/api/sessions", basic("admin", "s3cret")));
  assert.ok(!passes("/api/sessions", basic("admin", "s3creT")));
  assert.ok(!passes("/api/sessions", basic("root", "s3cret")));
  assert.ok(!passes("/api/sessions", "Basic !!!not-base64"));
  assert.ok(!passes("/api/sessions", "Bearer s3cret"));
}));

await test("A4. the carrier's answer webhooks and the health check stay open", withEnv(LOGIN, () => {
  for (const path of ["/api/voice/vobiz/answer", "/api/voice/plivo/answer", "/api/health"]) assert.ok(passes(path), path);
}));

await test("A5. APP_BASIC_AUTH_USER changes the user name", withEnv({ ...LOGIN, APP_BASIC_AUTH_USER: "sakshi" }, () => {
  assert.ok(passes("/", basic("sakshi", "s3cret")));
  assert.ok(!passes("/", basic("admin", "s3cret")));
}));

await test("B1. no webhook secret: URLs are unchanged and any token is accepted", withEnv({ TELEPHONY_WEBHOOK_SECRET: undefined }, () => {
  assert.equal(withWebhookToken("https://a.example/x?sessionId=1"), "https://a.example/x?sessionId=1");
  assert.ok(webhookTokenValid(null));
}));

await test("B2. webhook secret: URLs carry it, and only the exact token is accepted", withEnv({ TELEPHONY_WEBHOOK_SECRET: "tok en" }, () => {
  assert.equal(withWebhookToken("https://a.example/x?sessionId=1"), "https://a.example/x?sessionId=1&wt=tok%20en");
  assert.equal(withWebhookToken("https://a.example/x"), "https://a.example/x?wt=tok%20en");
  assert.ok(webhookTokenValid("tok en"));
  for (const bad of [null, undefined, "", "tok", "tok enX"]) assert.ok(!webhookTokenValid(bad), String(bad));
}));

const vobiz = (query: string) =>
  vobizAnswer.POST(new NextRequest(`https://agent.example.com/api/voice/vobiz/answer?${query}`, { method: "POST", body: new URLSearchParams() }));
const plivo = (query: string) =>
  plivoAnswer.GET(new Request(`https://agent.example.com/api/voice/plivo/answer?${query}`));

await test(
  "C1. Vobiz answer: without the token it hangs up; with it, the stream URL carries the token on",
  withEnv({ TELEPHONY_WEBHOOK_SECRET: "abc", APP_PUBLIC_BASE_URL: "https://agent.example.com" }, async () => {
    assert.match(await (await vobiz("sessionId=sess_1")).text(), /<Hangup ?\/>/);
    assert.match(await (await vobiz("sessionId=sess_1&wt=nope")).text(), /<Hangup ?\/>/);
    const ok = await (await vobiz("sessionId=sess_1&wt=abc")).text();
    assert.match(ok, /<Stream[^>]*>\s*wss:\/\/agent\.example\.com\/api\/voice\/vobiz\/stream\?sessionId=sess_1&amp;wt=abc\s*<\/Stream>/);
    assert.ok(!/&(?!amp;|lt;|gt;|quot;)/.test(ok), "every & in the answer XML is escaped");
  }),
);

await test(
  "C2. Plivo answer: without the token it hangs up; with it, the stream URL carries the token on",
  withEnv({ TELEPHONY_WEBHOOK_SECRET: "abc", APP_PUBLIC_BASE_URL: "https://agent.example.com" }, async () => {
    assert.match(await (await plivo("sessionId=sess_1&CallUUID=u1")).text(), /<Hangup ?\/>/);
    const ok = await (await plivo("sessionId=sess_1&CallUUID=u1&wt=abc")).text();
    assert.ok(ok.includes("/api/voice/plivo/stream?sessionId=sess_1&amp;wt=abc"), ok);
  }),
);

await test(
  "C3. no secret: both answer routes behave exactly as before",
  withEnv({ TELEPHONY_WEBHOOK_SECRET: undefined, APP_PUBLIC_BASE_URL: "https://agent.example.com" }, async () => {
    const v = await (await vobiz("sessionId=sess_1")).text();
    assert.match(v, /vobiz\/stream\?sessionId=sess_1\s*<\/Stream>/);
    const p = await (await plivo("sessionId=sess_1&CallUUID=u1")).text();
    assert.ok(!p.includes("Hangup") && !p.includes("wt="), p);
  }),
);

console.log(`\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`);
for (const name of failures) console.log(`  - ${name}`);
process.exit(failures.length === 0 ? 0 : 1);
