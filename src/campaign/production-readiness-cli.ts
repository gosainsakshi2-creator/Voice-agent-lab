/**
 * production-readiness-cli.ts
 *
 * `npm run preflight:prod` — the environment checks alone.
 * `npm run preflight:prod -- <campaignId>` — those plus the campaign.
 *
 * Deliberately a script rather than only an HTTP route: the checks that
 * matter most are about the deployment, and an operator needs to be
 * able to run them from a terminal against the same environment the
 * server will use, before the server is serving anything.
 *
 * Exits 1 when anything is BLOCKED, so this can gate a deploy step.
 * Exits 0 on PASS and on INCOMPLETE, and says which it was — an
 * environment-only run is legitimately incomplete, and a script that
 * failed for that reason would train people to ignore its exit code.
 *
 * Places no calls. Contacts no vendor. Never enables dialing.
 */

import { config as loadEnvFile } from "dotenv";

loadEnvFile({ path: ".env.local", quiet: true });
loadEnvFile({ quiet: true });

const { buildProductionReadiness } = await import("./production-readiness");
const { closeDbPool } = await import("./db/client");

const campaignId = process.argv[2]?.trim();

const MARK: Readonly<Record<string, string>> = {
  PASS: "PASS   ",
  BLOCKED: "BLOCKED",
  WARN: "WARN   ",
  SKIPPED: "SKIP   ",
};

function wrap(text: string, indent: number): string {
  const width = 100 - indent;
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length > 0 && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line.length === 0 ? word : `${line} ${word}`;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines.join(`\n${" ".repeat(indent)}`);
}

try {
  const report = await buildProductionReadiness(campaignId ? { campaignId } : {});

  console.log("");
  console.log("Campaign production readiness");
  console.log("=".repeat(100));
  console.log(`scope            : ${report.scope}${report.campaignId ? ` (${report.campaignId})` : ""}`);
  console.log(`dialing enabled  : ${report.dialingEnabled}`);
  console.log(`calling window   : ${report.callingWindow.description} — ${report.callingWindow.openNow ? "OPEN" : "CLOSED"}`);
  console.log(`call ceiling     : ${report.ceiling.effective} (bound by ${report.ceiling.boundBy})`);
  console.log("");

  for (const check of report.checks) {
    console.log(`[${MARK[check.status] ?? check.status}] ${String(check.number).padStart(2, " ")}. ${check.title}`);
    console.log(`             ${wrap(check.detail, 13)}`);
    if (check.remediation) console.log(`             -> ${wrap(check.remediation, 16)}`);
  }

  console.log("");
  console.log("-".repeat(100));
  console.log("Load safety");
  const { effective, absolute } = report.loadSafety;
  console.log(
    `  concurrency global ${effective.globalMaxConcurrent} / lanes ${effective.laneMaxConcurrentTotal} ` +
      `(absolute ${absolute.maxConcurrency})`,
  );
  console.log(
    `  cps         global ${effective.globalCallsPerSecond} / lanes ${effective.laneCallsPerSecondTotal} ` +
      `(absolute ${absolute.maxCallsPerSecond})`,
  );
  console.log(
    `  call ${effective.maxCallSeconds}s max, silence ${effective.maxSilenceSeconds}s, ring ${effective.ringTimeoutSeconds}s, ` +
      `retries ${effective.retryMaxAttempts}`,
  );

  const { throughput } = report;
  console.log("");
  console.log(`Theoretical throughput (assuming ${throughput.assumedCallSeconds}s per attempt — a PLANNING figure, not a measurement)`);
  console.log(
    `  ${Math.round(throughput.callsPerHour)} calls/hour, bound by ${throughput.boundBy} ` +
      `(cps allows ${Math.round(throughput.callsPerHourByCps)}/h, concurrency allows ${Math.round(throughput.callsPerHourByConcurrency)}/h)`,
  );
  for (const [volume, hours] of Object.entries(throughput.hoursFor)) {
    console.log(`  ${volume.padStart(6, " ")} calls -> ${hours.toFixed(2)} hours`);
  }

  console.log("");
  console.log(`External limits still needing confirmation: ${report.externalLimits.needingConfirmation.length} of ${report.externalLimits.total}`);
  for (const limit of report.externalLimits.needingConfirmation) {
    console.log(`  [${limit.blocksScaling ? "GATES SCALING" : "informational"}] ${limit.vendor}: ${limit.limit}`);
    if (limit.confirmWith) console.log(`      confirm with: ${limit.confirmWith}`);
  }

  console.log("");
  console.log("=".repeat(100));
  console.log(`OVERALL: ${report.overall}`);
  if (report.blockers.length > 0) {
    console.log("");
    console.log(`BLOCKERS (${report.blockers.length}):`);
    for (const blocker of report.blockers) console.log(`  - ${wrap(blocker, 4)}`);
  }
  if (report.skipped.length > 0) {
    console.log("");
    console.log(`NOT CHECKED (${report.skipped.length}):`);
    for (const item of report.skipped) console.log(`  - ${item}`);
  }
  console.log("");
  console.log(report.note);
  console.log("");

  await closeDbPool().catch(() => undefined);
  process.exit(report.overall === "BLOCKED" ? 1 : 0);
} catch (error) {
  console.error(`[preflight:prod] ${error instanceof Error ? error.message : String(error)}`);
  await closeDbPool().catch(() => undefined);
  process.exit(1);
}
