/**
 * audit-cli.ts
 *
 * `npm run campaign:audit -- <campaignId>` — the post-run questions the
 * results page does not answer: rejected counts, rate-limit failures,
 * system errors, p95 latency, cost per success, duplicate-dial and
 * cross-provider integrity, stuck sessions.
 *
 * Run it after every rung of the pilot ladder. The gate for moving up a
 * rung is this output, not the fact that the previous rung finished.
 *
 * Read-only. Places no calls.
 */

import { config as loadEnvFile } from "dotenv";

loadEnvFile({ path: ".env.local", quiet: true });
loadEnvFile({ quiet: true });

const { buildCampaignAudit } = await import("./observability/campaign-audit");
const { getDispatchConfig } = await import("./config/dispatch.config");
const { closeDbPool } = await import("./db/client");

const campaignId = process.argv[2]?.trim();
if (!campaignId) {
  console.error("Usage: npm run campaign:audit -- <campaignId>");
  process.exit(1);
}

const config = getDispatchConfig();

try {
  const audit = await buildCampaignAudit(campaignId, {
    retryMaxAttempts: config.retry.maxAttempts,
    // A call cannot legitimately still be live past its own maximum
    // duration plus the ring timeout, plus a minute of slack.
    staleMinutes: Math.ceil((config.maxCallSeconds + config.ringTimeoutSeconds) / 60) + 1,
  });

  const line = (label: string, value: unknown) => console.log(`  ${label.padEnd(38, ".")} ${String(value)}`);

  console.log("");
  console.log(`Campaign audit — ${campaignId}`);
  console.log("=".repeat(90));

  console.log("");
  console.log("Funnel");
  line("attempted", audit.funnel.attempted);
  line("rehearsed, not dialled (kill switch)", audit.funnel.rehearsedNotDialled);
  line("dialled", audit.funnel.dialled);
  line("answered", audit.funnel.answered);
  line("completed", audit.funnel.completed);
  line("no answer (INFERRED by our watchdog)", audit.funnel.noAnswer);
  line("busy (inferred from error text only)", audit.funnel.busy);
  line("failed", audit.funnel.failed);
  line("terminal statuses inferred, not observed", audit.funnel.inferredTerminal);
  console.log("  by failure class:");
  for (const [failureClass, count] of Object.entries(audit.funnel.byFailureClass)) {
    console.log(`    ${failureClass.padEnd(20, " ")} ${count}`);
  }
  line(
    "connected seconds mean/p50/p95",
    `${audit.funnel.connectedSeconds.mean ?? "-"} / ${audit.funnel.connectedSeconds.p50 ?? "-"} / ${audit.funnel.connectedSeconds.p95 ?? "-"} (n=${audit.funnel.connectedSeconds.samples})`,
  );

  console.log("");
  console.log("Integrity — every one of these must be 0");
  line("cross-provider attempts", audit.integrity.crossProviderAttempts);
  line("contacts on an unknown provider", audit.integrity.unknownProviderContacts);
  line("duplicate numbers in this campaign", audit.integrity.duplicateNumbersInCampaign);
  line("contacts over the retry cap", audit.integrity.contactsOverRetryCap);
  line("max dialled attempts on one contact", audit.integrity.maxAttemptsOnOneContact);
  line("numbers with a DIFFERENT provider elsewhere", audit.integrity.numbersWithConflictingProviderElsewhere);
  line("numbers another campaign also dialled", audit.integrity.numbersDialledByAnotherCampaign);

  console.log("");
  console.log(`Stuck (threshold ${audit.stuck.staleMinutes} minutes)`);
  line("live attempts past the deadline", audit.stuck.liveAttemptsPastDeadline);
  line("contacts stuck claimed", audit.stuck.contactsStuckClaimed);
  line("answered attempts with no dispatch metrics", audit.stuck.endedAttemptsMissingDispatchMetrics);
  line("dispatcher locks held", audit.stuck.heldDispatcherLocks.map((lock) => `${lock.owner} (${lock.heartbeatAgeSeconds}s)`).join(", ") || "none");

  console.log("");
  console.log("Errors");
  line("rate-limited attempts", audit.errors.rateLimitedAttempts);
  for (const example of audit.errors.rateLimitExamples) console.log(`    e.g. ${example}`);
  line("other temporary failures", audit.errors.otherTemporaryFailures);
  line("system failures", audit.errors.systemFailures);
  console.log(`  event log errors: ${JSON.stringify(audit.errors.eventErrorsByCode)}`);
  console.log(`  event log warnings: ${JSON.stringify(audit.errors.eventWarningsByCode)}`);

  console.log("");
  console.log("Latency per provider (VOICE only, from call_metrics; ms)");
  for (const row of audit.latency) {
    console.log(
      `  ${row.provider.padEnd(12, " ")} n=${String(row.calls).padStart(4, " ")}  ` +
        `stt ${row.sttP50 ?? "-"}/${row.sttP95 ?? "-"}  llm ${row.llmP50 ?? "-"}/${row.llmP95 ?? "-"}  ` +
        `tts ${row.ttsP50 ?? "-"}/${row.ttsP95 ?? "-"}  total ${row.totalP50 ?? "-"}/${row.totalP95 ?? "-"} (p50/p95)`,
    );
  }
  if (audit.latency.length === 0) console.log("  (no voice metrics recorded)");

  console.log("");
  console.log("Cost per provider (USD, estimated)");
  for (const row of audit.cost) {
    console.log(
      `  ${row.provider.padEnd(12, " ")} calls ${String(row.calls).padStart(4, " ")}  total ${row.costTotalUsd ?? "-"}  ` +
        `per call ${row.costPerCallUsd ?? "-"}  successes ${row.successes}  per success ${row.costPerSuccessUsd ?? "-"}`,
    );
  }
  if (audit.cost.length === 0) console.log("  (no cost rows recorded)");

  console.log("");
  console.log("Why they did not convert");
  for (const reason of audit.nonSuccessReasons) {
    console.log(`  ${reason.outcomeType.padEnd(26, " ")} ${reason.primaryReason.padEnd(24, " ")} ${reason.count}`);
  }
  if (audit.nonSuccessReasons.length === 0) console.log("  (no non-success outcomes recorded)");

  console.log("");
  console.log("This data CANNOT answer:");
  for (const item of audit.unanswerable) console.log(`  - ${item}`);
  console.log("");

  await closeDbPool().catch(() => undefined);
  process.exit(0);
} catch (error) {
  console.error(`[campaign:audit] ${error instanceof Error ? error.message : String(error)}`);
  await closeDbPool().catch(() => undefined);
  process.exit(1);
}
