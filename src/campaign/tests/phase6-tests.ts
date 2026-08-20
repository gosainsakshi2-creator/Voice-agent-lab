/**
 * phase6-tests.ts — `npm run test:phase6`
 *
 * Production readiness, external limits, load guardrails, the calling
 * window, and the post-run audit.
 *
 * Every pure test runs with no database and no clock dependency — the
 * calling window is evaluated at explicit instants rather than at
 * whatever time the suite happens to run, because a test that passes
 * only between 10am and 8pm is not a test.
 *
 * The database tests run against the real PostgreSQL, create their own
 * fixtures, and delete them in a `finally`. The two launcher tests
 * assert that a run is REFUSED, and they pass a manager that fails the
 * test if it is touched, so a regression that let the launch through
 * would fail loudly rather than dial.
 *
 * NOTHING HERE PLACES A CALL. Nothing here enables dialing.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { config as loadEnvFile } from "dotenv";

loadEnvFile({ path: ".env.local", quiet: true });
loadEnvFile({ quiet: true });

const {
  CALLING_WINDOW_DEFAULTS,
  describeCallingWindow,
  formatClockMinute,
  getCallingWindow,
  isCallingWindowOpen,
  parseClockMinute,
  validateCallingWindow,
} = await import("../config/calling-window");
const { CallingWindowWatcher } = await import("../dispatch/calling-window-watcher");
const { checkLoadSafety, estimateThroughput, getAbsoluteLimits, issuesFor } = await import(
  "../dispatch/load-guardrails"
);
const { getDispatchConfig } = await import("../config/dispatch.config");
const { getExternalLimits, unconfirmedExternalLimits, scalingBlockingLimits, callStatusCapabilities } =
  await import("../external-limits");
const { estimateSttCost } = await import("../../core/session/cost-estimator");
const { buildProductionReadiness } = await import("../production-readiness");
const { buildCampaignAudit, auditFunnel, auditIntegrity, auditErrors, auditCost } = await import(
  "../observability/campaign-audit"
);
const { launchCampaignRun } = await import("../dispatch/run-launcher");
const { allocateCounts } = await import("../import/provider-allocator");
const { findScript, hashScript } = await import("../script/script-registry");
const { query, closeDbPool } = await import("../db/client");

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
const SARVAM = "sarvam";
const SMALLEST = "smallest-ai";

/** A window built by hand, so no test depends on the environment. */
function windowOf(overrides: Partial<ReturnType<typeof getCallingWindow>> = {}) {
  const base = {
    startMinute: 600,
    endMinute: 1_200,
    timeZone: "Asia/Kolkata",
    days: [0, 1, 2, 3, 4, 5, 6] as readonly number[],
    enforced: true,
    raw: { start: "10:00", end: "20:00", days: "0,1,2,3,4,5,6", timeZone: "Asia/Kolkata" },
  };
  return { ...base, ...overrides } as ReturnType<typeof getCallingWindow>;
}

/** 2026-08-19 is a Wednesday. IST is UTC+5:30. */
const istAt = (hour: number, minute = 0) =>
  new Date(Date.UTC(2026, 7, 19, hour, minute) - 5.5 * 3_600_000);

// ─────────────────────────────────────────────────────────────────
section("CALLING WINDOW (pure — no clock, no database)");

await test("1. HH:MM parses, and anything that is not HH:MM does not", () => {
  assert.equal(parseClockMinute("10:00"), 600);
  assert.equal(parseClockMinute("9:30"), 570);
  assert.equal(parseClockMinute("00:00"), 0);
  assert.equal(parseClockMinute("23:59"), 1_439);
  assert.equal(parseClockMinute("24:00"), undefined);
  assert.equal(parseClockMinute("10:60"), undefined);
  assert.equal(parseClockMinute("10"), undefined);
  assert.equal(parseClockMinute("ten"), undefined);
  assert.equal(formatClockMinute(600), "10:00");
});

await test("2. the window is open inside its hours and closed outside them", () => {
  const window = windowOf();
  assert.equal(isCallingWindowOpen(window, istAt(12, 0)).open, true, "noon IST is inside 10:00-20:00");
  assert.equal(isCallingWindowOpen(window, istAt(3, 0)).open, false, "03:00 IST is outside");
  assert.equal(isCallingWindowOpen(window, istAt(21, 30)).open, false, "21:30 IST is outside");
});

await test("3. the boundaries are start-inclusive and end-exclusive", () => {
  const window = windowOf();
  assert.equal(isCallingWindowOpen(window, istAt(10, 0)).open, true, "10:00 exactly is inside");
  assert.equal(isCallingWindowOpen(window, istAt(9, 59)).open, false);
  assert.equal(isCallingWindowOpen(window, istAt(19, 59)).open, true);
  assert.equal(isCallingWindowOpen(window, istAt(20, 0)).open, false, "20:00 exactly is over");
});

await test("4. the time zone is the window's, not the server's", () => {
  const window = windowOf();
  // 06:00 UTC is 11:30 IST — inside the window even though UTC says early morning.
  assert.equal(isCallingWindowOpen(window, new Date("2026-08-19T06:00:00Z")).open, true);
  // 17:00 UTC is 22:30 IST — outside, even though UTC says late afternoon.
  assert.equal(isCallingWindowOpen(window, new Date("2026-08-19T17:00:00Z")).open, false);
});

await test("5. a day not on the list is closed all day", () => {
  // 2026-08-19 is a Wednesday (weekday 3).
  const weekdaysOnly = windowOf({ days: [1, 2, 4, 5], raw: { ...windowOf().raw, days: "1,2,4,5" } });
  const verdict = isCallingWindowOpen(weekdaysOnly, istAt(12, 0));
  assert.equal(verdict.open, false);
  assert.match(verdict.reason, /Wed is not a permitted calling day/);
});

await test("6. a window that wraps midnight is refused, never interpreted", () => {
  const wrapping = windowOf({
    startMinute: 1_320,
    endMinute: 360,
    raw: { ...windowOf().raw, start: "22:00", end: "06:00" },
  });
  assert.equal(isCallingWindowOpen(wrapping, istAt(23, 0)).open, false, "the safe reading is 'do not call'");
  const validation = validateCallingWindow(wrapping);
  assert.equal(validation.ok, false);
  assert.ok(validation.blockers.some((blocker) => /wraps midnight/.test(blocker)));
});

await test("7. an unparsable bound falls back to the default and is reported, not absorbed", () => {
  const previous = process.env["CAMPAIGN_CALLING_WINDOW_START"];
  process.env["CAMPAIGN_CALLING_WINDOW_START"] = "9am";
  try {
    const window = getCallingWindow();
    assert.equal(
      formatClockMinute(window.startMinute),
      CALLING_WINDOW_DEFAULTS.start,
      "a typo must never widen the hours people can be called in",
    );
    const validation = validateCallingWindow(window);
    assert.equal(validation.ok, false, "and it must still be reported");
    assert.ok(validation.blockers.some((blocker) => blocker.includes("9am")));
  } finally {
    if (previous === undefined) delete process.env["CAMPAIGN_CALLING_WINDOW_START"];
    else process.env["CAMPAIGN_CALLING_WINDOW_START"] = previous;
  }
});

await test("8. an invalid time zone is a blocker", () => {
  const validation = validateCallingWindow(
    windowOf({ timeZone: "Mars/Olympus", raw: { ...windowOf().raw, timeZone: "Mars/Olympus" } }),
  );
  assert.equal(validation.ok, false);
  assert.ok(validation.blockers.some((blocker) => /not a valid IANA time zone/.test(blocker)));
});

await test("9. an unenforced window is open, and says so loudly", () => {
  const window = windowOf({ enforced: false });
  const verdict = isCallingWindowOpen(window, istAt(3, 0));
  assert.equal(verdict.open, true);
  assert.match(verdict.reason, /NOT enforced/);
  assert.ok(validateCallingWindow(window).warnings.some((warning) => /any hour/.test(warning)));
});

await test("10. the description names the hours, the zone and the days", () => {
  assert.equal(describeCallingWindow(windowOf()), "10:00-20:00 Asia/Kolkata (every day)");
  assert.equal(
    describeCallingWindow(windowOf({ days: [1, 3], raw: { ...windowOf().raw, days: "1,3" } })),
    "10:00-20:00 Asia/Kolkata (Mon,Wed)",
  );
});

// ─────────────────────────────────────────────────────────────────
section("CALLING WINDOW WATCHER (drives only the public pause())");

await test("11. a closed window pauses the dispatcher, once, and never stops it", () => {
  let pauses = 0;
  let stops = 0;
  const watcher = new CallingWindowWatcher(
    { pause: () => (pauses += 1), stop: () => (stops += 1) },
    { window: windowOf(), now: () => istAt(3, 0) },
  );
  assert.equal(watcher.poll(), "paused");
  assert.equal(watcher.poll(), "already-paused", "a dispatcher does not need telling twice");
  assert.equal(pauses, 1);
  assert.equal(stops, 0, "the window watcher must never escalate a pause into a stop");
});

await test("12. an open window touches nothing", () => {
  let touched = false;
  const watcher = new CallingWindowWatcher(
    {
      pause: () => (touched = true),
      stop: () => (touched = true),
    },
    { window: windowOf(), now: () => istAt(12, 0) },
  );
  assert.equal(watcher.poll(), "open");
  assert.equal(touched, false);
});

// ─────────────────────────────────────────────────────────────────
section("LOAD GUARDRAILS (pure)");

const baseConfig = getDispatchConfig();
const configWith = (overrides: Partial<typeof baseConfig>) => ({ ...baseConfig, ...overrides });

await test("13. the shipped defaults are safe", () => {
  const report = checkLoadSafety(baseConfig, baseConfig.stageMaxCalls);
  assert.equal(report.safe, true, report.blockers.join(" | "));
  assert.equal(report.blockers.length, 0);
});

await test("14. CPS of zero is refused — it disables the limiter rather than the calls", () => {
  const report = checkLoadSafety(configWith({ globalCallsPerSecond: 0 }), 10);
  assert.equal(report.safe, false);
  assert.ok(
    report.blockers.some((blocker) => /CAMPAIGN_GLOBAL_CPS is 0/.test(blocker)),
    "a zero CPS must be a blocker, not an unlimited rate",
  );
  assert.equal(issuesFor(report, "cps").length > 0, true);
  assert.equal(issuesFor(report, "call-duration").length, 0, "and it must not be filed under a different check");
});

await test("15. concurrency of zero is refused — the lanes would poll forever", () => {
  const report = checkLoadSafety(configWith({ globalMaxConcurrent: 0 }), 10);
  assert.equal(report.safe, false);
  assert.ok(report.blockers.some((blocker) => /CAMPAIGN_GLOBAL_MAX_CONCURRENCY is 0/.test(blocker)));
});

await test("16. a per-lane zero is caught as well as the global one", () => {
  const lanes = { ...baseConfig.lanes, [SARVAM]: { maxConcurrent: 0, callsPerSecond: 0 } };
  const report = checkLoadSafety(configWith({ lanes: lanes as typeof baseConfig.lanes }), 10);
  assert.equal(report.safe, false);
  assert.ok(report.blockers.some((blocker) => blocker.includes("CAMPAIGN_CPS_SARVAM")));
  assert.ok(report.blockers.some((blocker) => blocker.includes("CAMPAIGN_CONCURRENCY_SARVAM")));
});

await test("17. the absolute ceilings bind, and name the variable that would raise them", () => {
  const absolute = getAbsoluteLimits();
  const report = checkLoadSafety(
    configWith({ globalMaxConcurrent: absolute.maxConcurrency + 1 }),
    10,
    absolute,
  );
  assert.equal(report.safe, false);
  assert.ok(report.blockers.some((blocker) => blocker.includes("CAMPAIGN_ABSOLUTE_MAX_CONCURRENCY")));

  const tooManyCalls = checkLoadSafety(baseConfig, absolute.maxCallsPerRun + 1, absolute);
  assert.equal(tooManyCalls.safe, false);
  assert.ok(tooManyCalls.blockers.some((blocker) => blocker.includes("CAMPAIGN_ABSOLUTE_MAX_CALLS_PER_RUN")));
});

await test("18. a zero watchdog is refused — it would end every call instantly", () => {
  assert.equal(checkLoadSafety(configWith({ maxCallSeconds: 0 }), 10).safe, false);
  assert.equal(checkLoadSafety(configWith({ maxSilenceSeconds: 0 }), 10).safe, false);
  assert.equal(checkLoadSafety(configWith({ ringTimeoutSeconds: 0 }), 10).safe, false);
});

await test("19. a ceiling of zero is a configuration error, not a dry run", () => {
  const report = checkLoadSafety(baseConfig, 0);
  assert.equal(report.safe, false);
  assert.ok(report.blockers.some((blocker) => /effective call ceiling is 0/.test(blocker)));
  assert.ok(
    report.blockers.some((blocker) => blocker.includes("CAMPAIGN_DIALING_ENABLED")),
    "and it must point at the control that actually means 'do not dial'",
  );
});

await test("20. a retry cap above the absolute one is refused", () => {
  const absolute = getAbsoluteLimits();
  const report = checkLoadSafety(
    configWith({ retry: { ...baseConfig.retry, maxAttempts: absolute.maxRetryAttempts + 1 } }),
    10,
    absolute,
  );
  assert.equal(report.safe, false);
  assert.ok(report.blockers.some((blocker) => /another real call to the same person/.test(blocker)));
});

await test("21. an unreachable global cap is a warning, not a refusal", () => {
  const report = checkLoadSafety(configWith({ globalMaxConcurrent: 999, globalCallsPerSecond: 19 }), 10, {
    ...getAbsoluteLimits(),
    maxConcurrency: 1_000,
    maxCallsPerSecond: 20,
  });
  assert.equal(report.safe, true, "it is legal, just pointless");
  assert.ok(report.warnings.some((warning) => /can never bind/.test(warning)));
});

// ─────────────────────────────────────────────────────────────────
section("THROUGHPUT ARITHMETIC (pure)");

await test("22. throughput is the lower of the CPS limit and concurrency ÷ call length", () => {
  const estimate = estimateThroughput(baseConfig, 120);
  // The default global ceiling is now the Vobiz account's confirmed 3
  // live calls, not the old guess of 15: 3 live calls at 120s each is
  // 90/hour, and 3 CPS is still 10,800/hour. The arithmetic under test
  // is unchanged — only the configured ceiling it reads.
  assert.equal(estimate.boundBy, "concurrency");
  assert.equal(Math.round(estimate.callsPerHourByConcurrency), 90);
  assert.equal(estimate.callsPerHourByCps, 10_800);
  assert.equal(Math.round(estimate.callsPerHour), 90);
});

await test("23. a tight CPS becomes the binding limit instead", () => {
  const lanes = {
    [CARTESIA]: { maxConcurrent: 5, callsPerSecond: 0.02 },
    [SARVAM]: { maxConcurrent: 5, callsPerSecond: 0.02 },
    [SMALLEST]: { maxConcurrent: 5, callsPerSecond: 0.02 },
  };
  const estimate = estimateThroughput(
    // The global ceiling is raised here on purpose: with the shipped
    // ceiling of 3 the concurrency bound is the tighter one, and this
    // test is about the case where CPS binds instead.
    configWith({
      globalMaxConcurrent: 15,
      globalCallsPerSecond: 0.06,
      lanes: lanes as typeof baseConfig.lanes,
    }),
    120,
  );
  assert.equal(estimate.boundBy, "cps");
  assert.equal(Math.round(estimate.callsPerHour), 216);
});

await test("24. the hours-per-volume table follows from the rate", () => {
  const estimate = estimateThroughput(baseConfig, 120);
  assert.ok(estimate.hoursFor["2000"] !== undefined);
  // 90 calls/hour at the confirmed 3-concurrent ceiling.
  assert.equal(Math.round((estimate.hoursFor["2000"] ?? 0) * 100) / 100, 22.22);
  assert.equal(Math.round((estimate.hoursFor["10000"] ?? 0) * 100) / 100, 111.11);
});

// ─────────────────────────────────────────────────────────────────
section("EXTERNAL LIMITS (nothing invented)");

await test("25. every entry either has a repository value or says it needs confirmation — never both, never neither", () => {
  for (const limit of getExternalLimits()) {
    if (limit.status === "FROM_REPOSITORY") {
      assert.ok(
        limit.repositoryValue !== null && limit.repositoryValue.length > 0,
        `${limit.id} claims a repository value and has none`,
      );
    } else {
      assert.equal(
        limit.repositoryValue,
        null,
        `${limit.id} is unconfirmed but carries a value — that is exactly the guess this file forbids`,
      );
      assert.ok(limit.confirmWith, `${limit.id} must say where to get the number`);
    }
  }
});

await test("26. the carrier limits that gate scaling are all present and unconfirmed", () => {
  const ids = new Set(scalingBlockingLimits().map((limit) => limit.id));
  for (const required of [
    "vobiz.max_concurrent_channels",
    "vobiz.cps",
    "vobiz.did_pool",
    "vobiz.did_limits",
    "vobiz.amd",
    "vobiz.status_callback",
    "deepgram.max_concurrent_streams",
    "openai.rpm_tpm",
    "cartesia.limits",
    "sarvam.limits",
    "smallest-ai.limits",
  ]) {
    assert.ok(ids.has(required), `${required} must be listed as gating scale`);
  }
  assert.ok(unconfirmedExternalLimits().length >= ids.size);
});

await test("27. the prices reported come from the estimator itself, not from a second copy", () => {
  const deepgram = getExternalLimits().find((limit) => limit.id === "deepgram.price");
  assert.ok(deepgram?.repositoryValue);
  const perMinute = estimateSttCost("deepgram", 60);
  assert.ok(
    deepgram.repositoryValue.includes(perMinute.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")),
    `expected the estimator's own rate (${perMinute}) in "${deepgram.repositoryValue}"`,
  );
});

await test("28. the status register is honest about what cannot be established", () => {
  const capabilities = callStatusCapabilities();
  const byStatus = new Map(capabilities.map((capability) => [capability.status, capability]));

  assert.equal(byStatus.get("voicemail / answering machine")?.available, false);
  assert.equal(byStatus.get("voicemail / answering machine")?.provenance, "unavailable");
  assert.equal(byStatus.get("carrier hangup cause")?.available, false);
  assert.equal(byStatus.get("no answer")?.provenance, "inferred", "our own watchdog produces it");
  assert.equal(byStatus.get("busy")?.provenance, "inferred");
  assert.equal(byStatus.get("completed conversation")?.provenance, "observed");
});

// ─────────────────────────────────────────────────────────────────
section("DATABASE: PRODUCTION READINESS AND AUDIT");

const campaignId = randomUUID();
const otherCampaignId = randomUUID();
const script = findScript("registration", "v1");
assert.ok(script);

const ALLOCATION = { [CARTESIA]: 34, [SARVAM]: 33, [SMALLEST]: 33 };

try {
  await query(
    `INSERT INTO campaigns (id, name, campaign_type, status, script_id, script_version, script_hash,
                            provider_allocation, telephony_provider, language, idempotency_key, dispatch_config)
     VALUES ($1, '__phase6__', 'registration', 'READY', 'registration', 'v1', $2,
             $3::jsonb, 'vobiz', 'en', $4, '{"agent":{"gender":"female"}}'::jsonb)`,
    [campaignId, hashScript(script), JSON.stringify(ALLOCATION), `phase6-${campaignId}`],
  );

  // Seed exactly the split the allocator asks for, so check 23 is
  // testing the comparison rather than a hand-picked number.
  const targets = allocateCounts(3, ALLOCATION);
  let rowNumber = 0;
  const contactIds: Array<{ id: string; provider: string }> = [];
  for (const [provider, count] of targets) {
    for (let index = 0; index < count; index += 1) {
      rowNumber += 1;
      const row = await query<{ id: string }>(
        `INSERT INTO contacts (campaign_id, name, normalized_phone, original_phone, assigned_provider, csv_row_number)
         VALUES ($1, $2, $3, $3, $4, $5) RETURNING id`,
        [campaignId, `Person ${rowNumber}`, `+9197000${String(10000 + rowNumber)}`, provider, rowNumber],
      );
      contactIds.push({ id: row.rows[0]!.id, provider });
    }
  }
  assert.equal(contactIds.length, 3);

  await test("29. the readiness report covers all 25 required checks, exactly once each", async () => {
    const report = await buildProductionReadiness({ campaignId });
    for (let number = 1; number <= 25; number += 1) {
      const matching = report.checks.filter((check) => check.number === number);
      assert.equal(matching.length, 1, `check ${number} must appear exactly once`);
      assert.ok(matching[0]!.title.length > 0);
      assert.ok(["PASS", "BLOCKED", "WARN", "SKIPPED"].includes(matching[0]!.status));
    }
  });

  await test("30. it never enables dialing, and says so in the payload", async () => {
    const before = process.env["CAMPAIGN_DIALING_ENABLED"];
    const report = await buildProductionReadiness({ campaignId });
    assert.equal(process.env["CAMPAIGN_DIALING_ENABLED"], before, "the flag must be untouched");
    assert.equal(report.neverEnablesDialing, true);
    assert.equal(report.dialingEnabled, getDispatchConfig().dialingEnabled);
    assert.match(report.note, /never set/);
  });

  await test("31. with dialing off, the report is BLOCKED on exactly that", async () => {
    const report = await buildProductionReadiness({ campaignId });
    const killSwitch = report.checks.find((check) => check.number === 6);
    if (getDispatchConfig().dialingEnabled) {
      assert.equal(killSwitch?.status, "WARN", "an enabled kill switch is a warning, not a pass");
      return;
    }
    assert.equal(killSwitch?.status, "BLOCKED");
    assert.equal(report.overall, "BLOCKED");
  });

  await test("32. a campaign-scoped report does not skip the campaign checks", async () => {
    const report = await buildProductionReadiness({ campaignId });
    for (const number of [9, 21, 22, 23]) {
      const check = report.checks.find((item) => item.number === number);
      assert.notEqual(check?.status, "SKIPPED", `check ${number} must run when a campaign is named`);
    }
    assert.equal(report.scope, "campaign");
  });

  await test("33. an environment-only report skips them, and is INCOMPLETE rather than PASS", async () => {
    const report = await buildProductionReadiness({});
    assert.equal(report.scope, "environment");
    for (const number of [9, 21, 22, 23]) {
      assert.equal(report.checks.find((item) => item.number === number)?.status, "SKIPPED");
    }
    assert.notEqual(report.overall, "PASS", "an environment-only run can never be a full pass");
  });

  await test("34. the seeded campaign passes contact, script, allocation and provider-lock checks", async () => {
    const report = await buildProductionReadiness({ campaignId });
    for (const number of [9, 21, 22, 23, 24, 25]) {
      const check = report.checks.find((item) => item.number === number);
      assert.equal(check?.status, "PASS", `check ${number} failed: ${check?.detail}`);
    }
  });

  await test("35. the calling window check is evaluated at the instant given, not at test time", async () => {
    const open = await buildProductionReadiness({ campaignId, now: istAt(12, 0) });
    const closed = await buildProductionReadiness({ campaignId, now: istAt(3, 0) });
    const windowCheck = (report: Awaited<ReturnType<typeof buildProductionReadiness>>) =>
      report.checks.find((check) => check.number === 15);
    // With the default window in force these differ; with an unenforced
    // or reconfigured window both are open, which is also correct.
    if (getCallingWindow().enforced && validateCallingWindow(getCallingWindow()).ok) {
      assert.equal(open.callingWindow.openNow, true);
      assert.equal(closed.callingWindow.openNow, false);
      assert.equal(windowCheck(closed)?.status, "WARN");
    }
    assert.ok(windowCheck(open));
  });

  await test("36. the ceiling in the report is the pilot ceiling, and the DID budget is checked against it", async () => {
    const report = await buildProductionReadiness({ campaignId });
    assert.equal(report.ceiling.effective, Math.min(getDispatchConfig().stageMaxCalls, 10));
    const didCheck = report.checks.find((check) => check.number === 8);
    assert.ok(didCheck);
    assert.match(didCheck.detail, /No DID rotation exists/);
  });

  // ── Launcher gates ─────────────────────────────────────────────
  const refusingManager = {
    createSession: async () => assert.fail("a refused launch must never create a session"),
    warmUpProviders: async () => assert.fail("a refused launch must never warm up a provider"),
    start: async () => assert.fail("a refused launch must never start a call"),
    end: async () => undefined,
    getBenchmarkMetrics: async () => ({}) as never,
    onStateChange: () => () => undefined,
  };

  await test("37. a launch outside the calling window is refused, and touches no provider", async () => {
    const previousDays = process.env["CAMPAIGN_CALLING_WINDOW_DAYS"];
    // Permit a single day that is NOT today, in the window's own zone,
    // so the refusal is deterministic whatever hour the suite runs at.
    const weekdayName = new Intl.DateTimeFormat("en-US", {
      timeZone: getCallingWindow().timeZone,
      weekday: "short",
    }).format(new Date());
    const today = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekdayName);
    process.env["CAMPAIGN_CALLING_WINDOW_DAYS"] = String((today + 3) % 7);
    try {
      const result = await launchCampaignRun({
        campaignId,
        manager: refusingManager as never,
        requestedBy: "phase6-test",
        intent: "start",
      });
      assert.equal(result.started, false);
      assert.equal(result.started === false && result.code, "BLOCKED");
      assert.ok(
        result.started === false &&
          result.blockers.some((blocker) => /not a permitted calling day/.test(blocker)),
        `expected a calling-window refusal, got: ${result.started === false ? result.blockers.join(" | ") : "started"}`,
      );
    } finally {
      if (previousDays === undefined) delete process.env["CAMPAIGN_CALLING_WINDOW_DAYS"];
      else process.env["CAMPAIGN_CALLING_WINDOW_DAYS"] = previousDays;
    }
  });

  await test("38. a launch with the CPS limiter disabled is refused before anything is written", async () => {
    const before = await query<{ n: number }>(
      "SELECT count(*)::int AS n FROM campaign_controls WHERE campaign_id = $1",
      [campaignId],
    );
    const result = await launchCampaignRun({
      campaignId,
      manager: refusingManager as never,
      requestedBy: "phase6-test",
      intent: "start",
      config: { ...getDispatchConfig(), globalCallsPerSecond: 0 },
    });
    assert.equal(result.started, false);
    assert.ok(
      result.started === false && result.blockers.some((blocker) => /CAMPAIGN_GLOBAL_CPS is 0/.test(blocker)),
    );
    const after = await query<{ n: number }>(
      "SELECT count(*)::int AS n FROM campaign_controls WHERE campaign_id = $1",
      [campaignId],
    );
    assert.equal(
      after.rows[0]?.n,
      before.rows[0]?.n,
      "a refused launch must not write a control row — that is how a stored STOP gets cleared by accident",
    );
  });

  // ── Audit ──────────────────────────────────────────────────────
  const first = contactIds[0]!;
  const second = contactIds[1]!;

  const attemptOne = await query<{ id: string }>(
    `INSERT INTO call_attempts (campaign_id, contact_id, attempt_number, provider, telephony_provider,
                                status, status_source, dialed_at, answered_at, ended_at,
                                duration_seconds, failure_class, failure_reason)
     VALUES ($1, $2, 1, $3, 'vobiz', 'COMPLETED', 'observed', now(), now(), now(), 95.5, 'COMPLETED', NULL)
     RETURNING id`,
    [campaignId, first.id, first.provider],
  );
  const attemptOneId = attemptOne.rows[0]!.id;

  await query(
    `INSERT INTO call_attempts (campaign_id, contact_id, attempt_number, provider, telephony_provider,
                                status, status_source, dialed_at, ended_at, failure_class, failure_reason)
     VALUES ($1, $2, 1, $3, 'vobiz', 'FAILED', 'observed', now(), now(), 'TEMPORARY',
             'HTTP 429 — rate limit exceeded')`,
    [campaignId, second.id, second.provider],
  );

  await query(
    `INSERT INTO call_metrics (call_attempt_id, campaign_id, provider, turn_count, conversation_seconds,
                               stt_p50_ms, llm_p50_ms, tts_p50_ms, total_p50_ms, first_turn_total_ms,
                               cost_telephony_usd, cost_stt_usd, cost_llm_usd, cost_tts_usd, cost_total_usd, raw)
     VALUES ($1, $2, $3, 6, 95.5, 210, 640, 380, 1230, 1400, 0.02, 0.01, 0.03, 0.04, 0.10, '{}'::jsonb)`,
    [attemptOneId, campaignId, first.provider],
  );
  await query(
    `INSERT INTO call_outcomes (call_attempt_id, campaign_id, outcome_type, succeeded, primary_reason, classifier)
     VALUES ($1, $2, 'registered_confirmed', true, 'confirmed_at_gate', 'rules.v1')`,
    [attemptOneId, campaignId],
  );

  await test("39. the audit funnel counts what happened, and names what was inferred", async () => {
    const funnel = await auditFunnel(campaignId);
    assert.equal(funnel.attempted, 2);
    assert.equal(funnel.dialled, 2);
    assert.equal(funnel.answered, 1);
    assert.equal(funnel.completed, 1);
    assert.equal(funnel.failed, 1);
    assert.equal(funnel.byFailureClass["COMPLETED"], 1);
    assert.equal(funnel.byFailureClass["TEMPORARY"], 1);
    assert.equal(funnel.connectedSeconds.samples, 1);
    assert.equal(funnel.connectedSeconds.p50, 95.5);
  });

  await test("40. rate-limit failures are separated out of TEMPORARY", async () => {
    const errors = await auditErrors(campaignId);
    assert.equal(errors.rateLimitedAttempts, 1);
    assert.equal(errors.otherTemporaryFailures, 0, "a 429 must not also be counted as an unexplained blip");
    assert.ok(errors.rateLimitExamples.some((example) => example.includes("429")));
  });

  await test("41. cost per successful outcome is reported, and is null rather than zero without one", async () => {
    const rows = await auditCost(campaignId);
    const withMetrics = rows.find((row) => row.provider === first.provider);
    assert.ok(withMetrics, "the provider with metrics must appear");
    assert.equal(withMetrics.successes, 1);
    assert.equal(withMetrics.costTotalUsd, 0.1);
    assert.equal(withMetrics.costPerSuccessUsd, 0.1);

    const noSuccess = rows.find((row) => row.provider !== first.provider && row.successes === 0);
    if (noSuccess) {
      assert.equal(noSuccess.costPerSuccessUsd, null, "no successes must read as unknown, never as free");
    }
  });

  await test("42. integrity checks come back clean for a correctly seeded campaign", async () => {
    const integrity = await auditIntegrity(campaignId, getDispatchConfig().retry.maxAttempts);
    assert.equal(integrity.crossProviderAttempts, 0);
    assert.equal(integrity.unknownProviderContacts, 0);
    assert.equal(integrity.duplicateNumbersInCampaign, 0);
    assert.equal(integrity.contactsOverRetryCap, 0);
    assert.equal(integrity.maxAttemptsOnOneContact, 1);
  });

  await test("43. the SAME number locked to a DIFFERENT provider in another campaign is detected", async () => {
    // The Phase 1 uniqueness guarantee is per-campaign, so this is
    // legal in the schema and still breaks "one number, one provider"
    // across a registration and a reminder campaign over the same list.
    await query(
      `INSERT INTO campaigns (id, name, campaign_type, status, script_id, script_version, script_hash,
                              provider_allocation, telephony_provider, language)
       VALUES ($1, '__phase6_other__', 'reminder', 'DRAFT', 'reminder', 'v1', 'x',
               '{}'::jsonb, 'vobiz', 'en')`,
      [otherCampaignId],
    );
    const conflictingProvider = first.provider === CARTESIA ? SARVAM : CARTESIA;
    const phone = await query<{ normalized_phone: string }>(
      "SELECT normalized_phone FROM contacts WHERE id = $1",
      [first.id],
    );
    await query(
      `INSERT INTO contacts (campaign_id, name, normalized_phone, original_phone, assigned_provider)
       VALUES ($1, 'Same person', $2, $2, $3)`,
      [otherCampaignId, phone.rows[0]!.normalized_phone, conflictingProvider],
    );

    const integrity = await auditIntegrity(campaignId, getDispatchConfig().retry.maxAttempts);
    assert.equal(
      integrity.numbersWithConflictingProviderElsewhere,
      1,
      "the audit must surface a cross-campaign provider conflict the schema cannot prevent",
    );
  });

  await test("44. the full audit assembles, and states what it cannot answer", async () => {
    const audit = await buildCampaignAudit(campaignId, { retryMaxAttempts: 3, staleMinutes: 5 });
    assert.equal(audit.campaignId, campaignId);
    assert.equal(audit.funnel.attempted, 2);
    assert.equal(audit.stuck.liveAttemptsPastDeadline, 0);
    assert.ok(audit.latency.length >= 1);
    assert.ok(audit.nonSuccessReasons.length >= 0);
    assert.ok(
      audit.unanswerable.some((item) => /answering-machine detection/.test(item)),
      "the audit must say out loud that voicemail is indistinguishable from an answer",
    );
  });
} finally {
  await query("DELETE FROM campaigns WHERE id = ANY($1::uuid[])", [[campaignId, otherCampaignId]]);
  await closeDbPool();
}

console.log("");
console.log("=".repeat(48));
console.log(`${passed}/${passed + failures.length} checks passed`);
if (failures.length > 0) {
  console.error("\nFAILURES:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("No telephony, TTS, STT or LLM request was made. No call was placed. Dialing was never enabled.");
process.exit(0);
