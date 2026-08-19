/**
 * production-readiness.ts
 *
 * The pre-launch gate for a REAL campaign, as opposed to
 * `preflight.ts`, which answers "is this campaign's data ready".
 *
 * The two are deliberately separate and both are required. Preflight
 * looks at one campaign: its contacts, its script, its allocation. This
 * looks at the deployment the campaign would run in: the database, the
 * public URL the carrier has to reach, the six vendor configurations,
 * the load limits, the calling window, and the database-level
 * guarantees that stop a duplicate or cross-provider dial. A campaign
 * can be perfectly prepared and still be unable to place a call
 * because the answer URL points at a hostname that no longer resolves.
 *
 * Three rules:
 *
 *   1. READ ONLY. Nothing here writes to the database, contacts a
 *      vendor, or places a call. Provider configuration is checked by
 *      asking the existing registry bootstrap whether a provider WOULD
 *      register — the same code path the server uses — without ever
 *      calling `checkHealth`.
 *
 *   2. IT NEVER ENABLES DIALING. There is no code path in this file
 *      that writes `CAMPAIGN_DIALING_ENABLED`, changes a campaign
 *      control, or advances a pilot stage. A green report is
 *      permission to proceed, not the act of proceeding.
 *
 *   3. NOTHING IS INVENTED. Where a limit belongs to a vendor rather
 *      than to us, the check reports it as needing external
 *      confirmation and names where to get it (`external-limits.ts`).
 *      A carrier's concurrency is not guessed here just to make a line
 *      go green.
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { optionalEnv, optionalEnvNumber } from "../providers/shared/env";
import { bootstrapProviderRegistry, type ProviderRegistrationOutcome } from "../providers/registry/bootstrap";
import {
  LANGUAGE_MODEL_PROVIDER_IDS,
  SPEECH_TO_TEXT_PROVIDER_IDS,
  TELEPHONY_PROVIDER_IDS,
  TEXT_TO_SPEECH_PROVIDER_IDS,
} from "../constants/providers.constants";
import { ProviderCategory } from "../types/enums";

import { checkDbConnection, query } from "./db/client";
import { getCampaign } from "./db/repositories/campaign.repo";
import { countContactsByProvider, countContactsMissingName } from "./db/repositories/contact.repo";
import { getControl } from "./db/repositories/control.repo";
import { allocateCounts } from "./import/provider-allocator";
import { findScript } from "./script/script-registry";
import { validateCampaignScript } from "./script/script-validation";
import { getDispatchConfig, type DispatchConfig } from "./config/dispatch.config";
import {
  describeCallingWindow,
  getCallingWindow,
  isCallingWindowOpen,
  validateCallingWindow,
} from "./config/calling-window";
import {
  checkLoadSafety,
  estimateThroughput,
  issuesFor,
  type LoadSafetyReport,
  type LoadTopic,
  type ThroughputEstimate,
} from "./dispatch/load-guardrails";
import { describeCallCeiling, type CallCeiling } from "./domain/pilot-stage";
import { CAMPAIGN_TTS_PROVIDERS } from "./domain/campaign-types";
import {
  callStatusCapabilities,
  getExternalLimits,
  scalingBlockingLimits,
  unconfirmedExternalLimits,
  type ExternalLimit,
  type StatusCapability,
} from "./external-limits";

export type CheckStatus = "PASS" | "BLOCKED" | "WARN" | "SKIPPED";

export interface ReadinessCheck {
  /** 1-25 are the required checks, in the order they were specified. */
  readonly number: number;
  readonly id: string;
  readonly title: string;
  readonly status: CheckStatus;
  readonly detail: string;
  /** What to do about it, when there is something to do. */
  readonly remediation?: string;
}

export interface ProductionReadinessReport {
  readonly scope: "environment" | "campaign";
  readonly campaignId: string | null;
  /**
   * BLOCKED if any check is BLOCKED. INCOMPLETE if none are blocked
   * but a campaign-scoped check could not run. PASS only when every
   * check that applies passed.
   */
  readonly overall: "PASS" | "BLOCKED" | "INCOMPLETE";
  readonly dialingEnabled: boolean;
  /** Stated in the payload so no caller can mistake this for a switch. */
  readonly neverEnablesDialing: true;
  readonly checks: readonly ReadinessCheck[];
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly skipped: readonly string[];
  readonly loadSafety: LoadSafetyReport;
  readonly throughput: ThroughputEstimate;
  readonly ceiling: CallCeiling;
  readonly callingWindow: {
    readonly description: string;
    readonly openNow: boolean;
    readonly reason: string;
    readonly enforced: boolean;
  };
  readonly externalLimits: {
    readonly total: number;
    readonly needingConfirmation: readonly ExternalLimit[];
    readonly blockingScale: readonly ExternalLimit[];
  };
  readonly statusCapabilities: readonly StatusCapability[];
  readonly generatedAt: Date;
  readonly note: string;
}

export interface ReadinessInput {
  readonly campaignId?: string;
  readonly config?: DispatchConfig;
  readonly now?: Date;
  /**
   * Channel-occupancy seconds assumed for the throughput arithmetic.
   * An input, never a measurement: default is ring timeout plus the
   * maximum call duration halved, which is a planning figure and is
   * labelled as one everywhere it appears.
   */
  readonly assumedCallSeconds?: number;
}

// ── Helpers ─────────────────────────────────────────────────────────

function envPresent(name: string): boolean {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0;
}

function missingEnv(names: readonly string[]): readonly string[] {
  return names.filter((name) => !envPresent(name));
}

/** Hosts that are development tunnels. Never a production answer URL. */
const DEV_TUNNEL_HOSTS = [
  "ngrok.io",
  "ngrok-free.app",
  "ngrok.app",
  "ngrok.dev",
  "trycloudflare.com",
  "loca.lt",
  "localtunnel.me",
  "serveo.net",
  "devtunnels.ms",
  "lhr.life",
  "pinggy.link",
  "tunnelmole.net",
  "bore.pub",
];

function isDevTunnel(hostname: string): boolean {
  return DEV_TUNNEL_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

function isLocalHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    hostname.endsWith(".local")
  );
}

/** E.164: a leading +, a non-zero country code, 8-15 digits in total. */
const E164 = /^\+[1-9]\d{7,14}$/;

function maskNumber(value: string): string {
  return value.length <= 5 ? "***" : `${value.slice(0, 4)}${"*".repeat(value.length - 6)}${value.slice(-2)}`;
}

function registered(
  outcomes: readonly ProviderRegistrationOutcome[],
  category: ProviderCategory,
  id: string,
): ProviderRegistrationOutcome | undefined {
  return outcomes.find(
    (outcome) => outcome.identifier.category === category && outcome.identifier.id === id,
  );
}

interface MigrationOnDisk {
  readonly version: string;
  readonly checksum: string;
}

/**
 * The migration files as they exist in the repository.
 *
 * Same normalisation and hash as `migrate.ts` so the two cannot
 * disagree about whether a file has changed. Read-only: this never
 * applies anything.
 */
async function readMigrationFiles(): Promise<readonly MigrationOnDisk[]> {
  // Built from `import.meta.url` with `path.join` rather than
  // `new URL("./db/migrations", ...)`: the relative form reads as a
  // module specifier to the bundler, which then tries to resolve a
  // directory of .sql files as an import and fails the build.
  const candidates = [
    path.join(path.dirname(fileURLToPath(import.meta.url)), "db", "migrations"),
    path.join(process.cwd(), "src", "campaign", "db", "migrations"),
  ];

  for (const directory of candidates) {
    try {
      const entries = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
      if (entries.length === 0) continue;
      const migrations: MigrationOnDisk[] = [];
      for (const filename of entries) {
        const sql = await readFile(path.join(directory, filename), "utf8");
        migrations.push({
          version: filename.replace(/\.sql$/, ""),
          checksum: createHash("sha256").update(sql.replace(/\r\n/g, "\n"), "utf8").digest("hex"),
        });
      }
      return migrations;
    } catch {
      // Try the next candidate. A bundled deployment may not ship the
      // .sql files; that is reported as a WARN, not a blocker, because
      // the applied state is still readable from the database.
    }
  }
  return [];
}

// ── The report ──────────────────────────────────────────────────────

export async function buildProductionReadiness(
  input: ReadinessInput = {},
): Promise<ProductionReadinessReport> {
  const config = input.config ?? getDispatchConfig();
  const now = input.now ?? new Date();
  const checks: ReadinessCheck[] = [];
  const add = (check: ReadinessCheck) => checks.push(check);

  // Registry bootstrap, once. This constructs adapters from the
  // environment exactly as the server does and contacts nothing.
  let outcomes: readonly ProviderRegistrationOutcome[] = [];
  let bootstrapError: string | undefined;
  try {
    outcomes = bootstrapProviderRegistry().outcomes;
  } catch (error) {
    bootstrapError = error instanceof Error ? error.message : String(error);
  }

  // ── 1. DATABASE_URL ───────────────────────────────────────────────
  const hasDatabaseUrl = envPresent("DATABASE_URL");
  add({
    number: 1,
    id: "database-url",
    title: "DATABASE_URL",
    status: hasDatabaseUrl ? "PASS" : "BLOCKED",
    detail: hasDatabaseUrl
      ? "DATABASE_URL is set. Its value is never read into this report."
      : "DATABASE_URL is not set. The campaign layer cannot claim a contact, record an attempt, or enforce the provider lock without it.",
    ...(hasDatabaseUrl ? {} : { remediation: "Set DATABASE_URL in the deployment environment." }),
  });

  // ── 2. Database connectivity ──────────────────────────────────────
  let dbReachable = false;
  let dbDescription = "";
  if (!hasDatabaseUrl) {
    add({
      number: 2,
      id: "database-connectivity",
      title: "Database connectivity",
      status: "BLOCKED",
      detail: "Not attempted: DATABASE_URL is not set.",
    });
  } else {
    try {
      const info = await checkDbConnection();
      dbReachable = true;
      dbDescription = `PostgreSQL ${info.serverVersion}, database "${info.database}"`;
      add({
        number: 2,
        id: "database-connectivity",
        title: "Database connectivity",
        status: "PASS",
        detail: `Connected: ${dbDescription}. Pool max ${optionalEnvNumber("DATABASE_POOL_MAX", 10)}, SSL mode "${optionalEnv("DATABASE_SSL", "require")}".`,
      });
    } catch (error) {
      add({
        number: 2,
        id: "database-connectivity",
        title: "Database connectivity",
        status: "BLOCKED",
        detail: `Cannot reach the database: ${error instanceof Error ? error.message : String(error)}`,
        remediation:
          "Fix connectivity before anything else — every other database-backed check below is unverifiable until this passes.",
      });
    }
  }

  // ── 3. Migration state ────────────────────────────────────────────
  if (!dbReachable) {
    add({
      number: 3,
      id: "migration-state",
      title: "Database migration state",
      status: "BLOCKED",
      detail: "Not attempted: the database is unreachable.",
    });
  } else {
    try {
      const onDisk = await readMigrationFiles();
      const applied = await query<{ version: string; checksum: string }>(
        "SELECT version, checksum FROM schema_migrations ORDER BY version",
      );
      const appliedMap = new Map(applied.rows.map((row) => [row.version, row.checksum]));

      if (onDisk.length === 0) {
        add({
          number: 3,
          id: "migration-state",
          title: "Database migration state",
          status: "WARN",
          detail:
            `${appliedMap.size} migration(s) recorded as applied (${[...appliedMap.keys()].join(", ")}), ` +
            "but the migration files could not be read from this process, so they could not be compared.",
          remediation: "Run `npm run db:migrate` from a checkout to confirm there is nothing pending.",
        });
      } else {
        const pending = onDisk.filter((migration) => !appliedMap.has(migration.version));
        const tampered = onDisk.filter(
          (migration) =>
            appliedMap.has(migration.version) && appliedMap.get(migration.version) !== migration.checksum,
        );
        const status = pending.length > 0 || tampered.length > 0 ? "BLOCKED" : "PASS";
        add({
          number: 3,
          id: "migration-state",
          title: "Database migration state",
          status,
          detail:
            status === "PASS"
              ? `All ${onDisk.length} migration(s) applied and checksums match: ${onDisk.map((m) => m.version).join(", ")}.`
              : [
                  pending.length > 0 ? `Pending: ${pending.map((m) => m.version).join(", ")}.` : "",
                  tampered.length > 0
                    ? `Applied but edited since: ${tampered.map((m) => m.version).join(", ")}.`
                    : "",
                ]
                  .filter(Boolean)
                  .join(" "),
          ...(status === "BLOCKED"
            ? {
                remediation:
                  pending.length > 0
                    ? "Run `npm run db:migrate`."
                    : "The database and the repository disagree about the schema. Add a new migration rather than editing an applied one.",
              }
            : {}),
        });
      }
    } catch (error) {
      add({
        number: 3,
        id: "migration-state",
        title: "Database migration state",
        status: "BLOCKED",
        detail: `Could not read schema_migrations: ${error instanceof Error ? error.message : String(error)}`,
        remediation: "Run `npm run db:migrate` — the migrations table may not exist yet.",
      });
    }
  }

  // ── 4 + 5. APP_PUBLIC_BASE_URL and the HTTPS requirement ──────────
  const rawBaseUrl = process.env["APP_PUBLIC_BASE_URL"]?.trim() ?? "";
  let baseUrl: URL | undefined;
  if (rawBaseUrl.length > 0) {
    try {
      baseUrl = new URL(rawBaseUrl);
    } catch {
      baseUrl = undefined;
    }
  }

  add({
    number: 4,
    id: "public-base-url",
    title: "APP_PUBLIC_BASE_URL",
    status: baseUrl ? "PASS" : "BLOCKED",
    detail: baseUrl
      ? `Set to ${baseUrl.origin}. Vobiz fetches the answer URL from here and opens the media WebSocket back to it.`
      : rawBaseUrl.length === 0
        ? "APP_PUBLIC_BASE_URL is not set. The answer webhook and the media WebSocket both need an absolute public URL."
        : `APP_PUBLIC_BASE_URL="${rawBaseUrl}" is not a valid absolute URL.`,
    ...(baseUrl
      ? {}
      : { remediation: "Set it to the deployed https origin, with no trailing path and no trailing slash." }),
  });

  if (!baseUrl) {
    add({
      number: 5,
      id: "https-requirement",
      title: "HTTPS requirement",
      status: "BLOCKED",
      detail: "Not evaluated: APP_PUBLIC_BASE_URL is missing or unparsable.",
    });
  } else {
    const httpsProblems: string[] = [];
    if (baseUrl.protocol !== "https:") {
      httpsProblems.push(
        `the scheme is ${baseUrl.protocol.replace(":", "")}, not https — the media bridge derives wss:// from it, and a carrier will refuse a plaintext stream`,
      );
    }
    if (isLocalHost(baseUrl.hostname)) {
      httpsProblems.push(`${baseUrl.hostname} is not reachable from outside this machine`);
    }
    if (isDevTunnel(baseUrl.hostname)) {
      httpsProblems.push(
        `${baseUrl.hostname} is a development tunnel; its URL changes between sessions and it is not a production endpoint`,
      );
    }
    if (baseUrl.pathname !== "/" && baseUrl.pathname !== "") {
      httpsProblems.push(`it carries a path ("${baseUrl.pathname}"), which the stream URL will append to`);
    }
    add({
      number: 5,
      id: "https-requirement",
      title: "HTTPS requirement",
      status: httpsProblems.length === 0 ? "PASS" : "BLOCKED",
      detail:
        httpsProblems.length === 0
          ? `${baseUrl.origin} is https, publicly routable in form, and not a dev tunnel. The media stream will be wss://${baseUrl.host}/api/voice/vobiz/stream.`
          : `Not usable as a production endpoint: ${httpsProblems.join("; ")}.`,
      ...(httpsProblems.length === 0
        ? {}
        : { remediation: "Point APP_PUBLIC_BASE_URL at the stable deployed https domain." }),
    });
  }

  // ── 6. CAMPAIGN_DIALING_ENABLED ───────────────────────────────────
  add({
    number: 6,
    id: "dialing-enabled",
    title: "CAMPAIGN_DIALING_ENABLED",
    status: config.dialingEnabled ? "WARN" : "BLOCKED",
    detail: config.dialingEnabled
      ? "DIALING IS ENABLED. Every attempt this deployment claims will reach the telephony provider and ring a real person."
      : "Dialing is disabled, so no call can be placed. This is the correct state until the moment of the pilot, and it is reported as BLOCKED because a campaign cannot dial in it.",
    remediation: config.dialingEnabled
      ? "Confirm the call ceiling below before starting a run. This check never changes the flag."
      : "Set CAMPAIGN_DIALING_ENABLED=true only for the pilot window, and only after every other check here passes. Nothing in this report will set it for you.",
  });

  // ── 7. Vobiz configuration ────────────────────────────────────────
  const vobizMissing = missingEnv(["VOBIZ_AUTH_ID", "VOBIZ_AUTH_TOKEN", "VOBIZ_ANSWER_URL"]);
  const vobizOutcome = registered(outcomes, ProviderCategory.TELEPHONY, TELEPHONY_PROVIDER_IDS.VOBIZ);
  const vobizApiBase = optionalEnv("VOBIZ_API_BASE_URL", "https://api.vobiz.ai");
  const answerUrlRaw = process.env["VOBIZ_ANSWER_URL"]?.trim() ?? "";
  const expectedAnswerUrl = baseUrl ? `${baseUrl.origin}/api/voice/vobiz/answer` : undefined;

  const vobizProblems: string[] = [];
  if (vobizMissing.length > 0) vobizProblems.push(`missing ${vobizMissing.join(", ")}`);
  if (vobizOutcome && !vobizOutcome.registered) {
    vobizProblems.push(`the provider would not register: ${vobizOutcome.reason ?? "unknown reason"}`);
  }
  if (!vobizApiBase.startsWith("https://")) {
    vobizProblems.push(`VOBIZ_API_BASE_URL="${vobizApiBase}" is not https`);
  }
  if (answerUrlRaw.includes("?")) {
    vobizProblems.push(
      "VOBIZ_ANSWER_URL already contains a query string; the provider appends ?sessionId=... and the result would be malformed",
    );
  }
  if (answerUrlRaw.length > 0 && !answerUrlRaw.startsWith("https://")) {
    vobizProblems.push("VOBIZ_ANSWER_URL is not https");
  }
  if (expectedAnswerUrl && answerUrlRaw.length > 0 && answerUrlRaw.replace(/\/+$/, "") !== expectedAnswerUrl) {
    vobizProblems.push(
      `VOBIZ_ANSWER_URL is "${answerUrlRaw}" but this deployment serves the answer webhook at "${expectedAnswerUrl}". ` +
        "A stale answer URL means the call connects and no audio ever flows",
    );
  }

  add({
    number: 7,
    id: "vobiz-configuration",
    title: "Vobiz configuration",
    status: vobizProblems.length === 0 ? "PASS" : "BLOCKED",
    detail:
      vobizProblems.length === 0
        ? `Credentials present, provider registers, API base ${vobizApiBase}, answer URL ${answerUrlRaw} matches this deployment.`
        : vobizProblems.join("; ") + ".",
    ...(vobizProblems.length === 0
      ? {}
      : { remediation: "Fix the Vobiz environment; a campaign cannot dial through an unregistered telephony provider." }),
  });

  // ── 8. Vobiz caller ID / from number ──────────────────────────────
  const fromNumber = process.env["VOBIZ_FROM_NUMBER"]?.trim() ?? "";
  const control = input.campaignId && dbReachable ? await getControl(input.campaignId).catch(() => undefined) : undefined;
  const campaign = input.campaignId && dbReachable ? await getCampaign(input.campaignId).catch(() => undefined) : undefined;
  const ceiling = describeCallCeiling({
    environmentMax: config.stageMaxCalls,
    pilotStage: campaign?.pilotStage ?? 0,
    campaignControlMax: control?.maxCallsThisRun ?? null,
  });
  const maxCallsPerDid = optionalEnvNumber("CAMPAIGN_MAX_CALLS_PER_DID", 500);

  if (fromNumber.length === 0) {
    add({
      number: 8,
      id: "vobiz-caller-id",
      title: "Vobiz caller ID / from number",
      status: "BLOCKED",
      detail: "VOBIZ_FROM_NUMBER is not set.",
      remediation: "Set it to the E.164 DID Vobiz has assigned to this account.",
    });
  } else if (!E164.test(fromNumber)) {
    add({
      number: 8,
      id: "vobiz-caller-id",
      title: "Vobiz caller ID / from number",
      status: "BLOCKED",
      detail: `VOBIZ_FROM_NUMBER="${maskNumber(fromNumber)}" is not in E.164 form (+ country code, 8-15 digits).`,
      remediation: "Correct the number. It is sent verbatim as the `from` field with no normalisation.",
    });
  } else {
    const overDidBudget = ceiling.effective > maxCallsPerDid;
    add({
      number: 8,
      id: "vobiz-caller-id",
      title: "Vobiz caller ID / from number",
      status: overDidBudget ? "BLOCKED" : "WARN",
      detail:
        `${maskNumber(fromNumber)} is the single caller ID for every call in every lane. No DID rotation exists in this codebase: ` +
        `the provider reads one \`from\` value from the environment. This run's ceiling is ${ceiling.effective} call(s) ` +
        `against a per-DID budget of ${maxCallsPerDid} (CAMPAIGN_MAX_CALLS_PER_DID).`,
      remediation: overDidBudget
        ? `Refusing ${ceiling.effective} calls from one DID. Either lower the ceiling, raise CAMPAIGN_MAX_CALLS_PER_DID after confirming the carrier's per-number limits, or obtain a DID pool and add rotation.`
        : "Confirm the carrier's per-DID daily limit and spam-flag policy before going past the pilot rungs — it is an unconfirmed external limit.",
    });
  }

  // ── 9. Campaign telephony provider ────────────────────────────────
  if (!input.campaignId) {
    add({
      number: 9,
      id: "campaign-telephony-provider",
      title: "Campaign telephony provider",
      status: "SKIPPED",
      detail: "No campaign id given; this check is campaign-scoped.",
    });
  } else if (!campaign) {
    add({
      number: 9,
      id: "campaign-telephony-provider",
      title: "Campaign telephony provider",
      status: "BLOCKED",
      detail: dbReachable ? `Campaign ${input.campaignId} was not found.` : "The database is unreachable.",
    });
  } else {
    const isVobiz = campaign.telephonyProvider === TELEPHONY_PROVIDER_IDS.VOBIZ;
    const providerRegistered = registered(
      outcomes,
      ProviderCategory.TELEPHONY,
      campaign.telephonyProvider,
    )?.registered === true;
    add({
      number: 9,
      id: "campaign-telephony-provider",
      title: "Campaign telephony provider",
      status: isVobiz && providerRegistered ? "PASS" : "BLOCKED",
      detail: `The campaign is set to dial through "${campaign.telephonyProvider}" (registered: ${providerRegistered}).${
        isVobiz ? "" : " Vobiz is the campaign telephony provider for this programme."
      }`,
      ...(isVobiz && providerRegistered
        ? {}
        : { remediation: "Recreate the campaign against vobiz, or configure the provider it names." }),
    });
  }

  // ── 10-14. The four vendors the conversation runs on ──────────────
  const vendorChecks: ReadonlyArray<{
    number: number;
    id: string;
    title: string;
    category: ProviderCategory;
    providerId: string;
    env: readonly string[];
    extra?: string;
  }> = [
    {
      number: 10,
      id: "cartesia-configuration",
      title: "Cartesia configuration",
      category: ProviderCategory.TEXT_TO_SPEECH,
      providerId: TEXT_TO_SPEECH_PROVIDER_IDS.CARTESIA,
      env: ["CARTESIA_API_KEY", "CARTESIA_DEFAULT_VOICE_ID"],
      extra: `model ${optionalEnv("CARTESIA_MODEL_ID", "(default)")} at ${optionalEnv("CARTESIA_SAMPLE_RATE_HZ", "(default)")} Hz`,
    },
    {
      number: 11,
      id: "sarvam-configuration",
      title: "Sarvam configuration",
      category: ProviderCategory.TEXT_TO_SPEECH,
      providerId: TEXT_TO_SPEECH_PROVIDER_IDS.SARVAM,
      env: ["SARVAM_API_KEY", "SARVAM_DEFAULT_SPEAKER"],
      extra: `model ${optionalEnv("SARVAM_TTS_MODEL", "(default)")} at ${optionalEnv("SARVAM_SAMPLE_RATE_HZ", "(default)")} Hz`,
    },
    {
      number: 12,
      id: "smallest-ai-configuration",
      title: "Smallest AI configuration",
      category: ProviderCategory.TEXT_TO_SPEECH,
      providerId: TEXT_TO_SPEECH_PROVIDER_IDS.SMALLEST_AI,
      env: ["SMALLEST_AI_API_KEY", "SMALLEST_AI_DEFAULT_VOICE_ID"],
      extra: `endpoint ${optionalEnv("SMALLEST_AI_BASE_URL", "(default)")} at ${optionalEnv("SMALLEST_AI_SAMPLE_RATE_HZ", "(default)")} Hz`,
    },
    {
      number: 13,
      id: "deepgram-configuration",
      title: "Deepgram configuration",
      category: ProviderCategory.SPEECH_TO_TEXT,
      providerId: SPEECH_TO_TEXT_PROVIDER_IDS.DEEPGRAM,
      env: ["DEEPGRAM_API_KEY"],
      extra: `model ${optionalEnv("DEEPGRAM_MODEL", "(default)")}`,
    },
    {
      number: 14,
      id: "openai-configuration",
      title: "OpenAI configuration",
      category: ProviderCategory.LANGUAGE_MODEL,
      providerId: LANGUAGE_MODEL_PROVIDER_IDS.GPT_5_1,
      env: ["OPENAI_API_KEY"],
      extra: `model ${optionalEnv("OPENAI_MODEL", "(default)")}`,
    },
  ];

  for (const vendor of vendorChecks) {
    const missing = missingEnv(vendor.env);
    const outcome = registered(outcomes, vendor.category, vendor.providerId);
    const ok = missing.length === 0 && outcome?.registered === true;
    add({
      number: vendor.number,
      id: vendor.id,
      title: vendor.title,
      status: ok ? "PASS" : "BLOCKED",
      detail: ok
        ? `Registered as "${vendor.providerId}"${vendor.extra ? `, ${vendor.extra}` : ""}. No request was made — configuration only.`
        : missing.length > 0
          ? `Missing ${missing.join(", ")}.`
          : `The provider did not register: ${outcome?.reason ?? bootstrapError ?? "not attempted"}.`,
      ...(ok
        ? {}
        : {
            remediation:
              vendor.category === ProviderCategory.TEXT_TO_SPEECH
                ? "A campaign lane cannot run without its TTS provider; the dispatcher would fail every call in that lane."
                : "Every call in every lane needs this provider.",
          }),
    });
  }

  // ── 15. Calling window ────────────────────────────────────────────
  const window = getCallingWindow();
  const windowValidation = validateCallingWindow(window);
  const windowVerdict = isCallingWindowOpen(window, now);
  add({
    number: 15,
    id: "calling-window",
    title: "Campaign calling window",
    status: !windowValidation.ok ? "BLOCKED" : windowVerdict.open ? "PASS" : "WARN",
    detail: !windowValidation.ok
      ? windowValidation.blockers.join(" ")
      : `${describeCallingWindow(window)}${window.enforced ? "" : " (NOT ENFORCED)"}. ${windowVerdict.reason}`,
    ...(windowValidation.ok
      ? windowVerdict.open
        ? {}
        : {
            remediation:
              "A run started now would be refused by the launcher, and a run in progress would be paused. Start inside the window.",
          }
      : { remediation: "Correct the CAMPAIGN_CALLING_WINDOW_* variables." }),
  });

  // ── 16-20 + extras: load safety ───────────────────────────────────
  const loadSafety = checkLoadSafety(config, ceiling.effective);
  const laneSummary = CAMPAIGN_TTS_PROVIDERS.map(
    (provider) => `${provider} ${config.lanes[provider].maxConcurrent}@${config.lanes[provider].callsPerSecond}/s`,
  ).join(", ");

  const loadCheck = (
    number: number,
    id: string,
    title: string,
    topics: readonly LoadTopic[],
    passDetail: string,
  ): void => {
    const found = issuesFor(loadSafety, ...topics);
    const blockers = found.filter((issue) => issue.severity === "blocker");
    const warnings = found.filter((issue) => issue.severity === "warning");
    add({
      number,
      id,
      title,
      status: blockers.length > 0 ? "BLOCKED" : warnings.length > 0 ? "WARN" : "PASS",
      detail:
        blockers.length > 0 || warnings.length > 0
          ? [...blockers, ...warnings].map((issue) => issue.message).join(" ")
          : passDetail,
    });
  };

  loadCheck(
    16,
    "concurrency",
    "Concurrency",
    ["concurrency"],
    `Global ${config.globalMaxConcurrent} live calls; lanes: ${laneSummary}. Effective peak is min(global, sum of lanes) = ${loadSafety.effective.laneMaxConcurrentTotal < config.globalMaxConcurrent ? loadSafety.effective.laneMaxConcurrentTotal : config.globalMaxConcurrent}. Absolute ceiling ${loadSafety.absolute.maxConcurrency}.`,
  );
  loadCheck(
    17,
    "cps",
    "Calls per second",
    ["cps"],
    `Global ${config.globalCallsPerSecond}/s, lanes total ${loadSafety.effective.laneCallsPerSecondTotal}/s. Absolute ceiling ${loadSafety.absolute.maxCallsPerSecond}/s.`,
  );
  loadCheck(
    18,
    "max-call-duration",
    "Maximum call duration",
    ["call-duration"],
    `${config.maxCallSeconds}s, enforced by the call runner's watchdog through the existing public end(). Absolute ceiling ${loadSafety.absolute.maxCallSeconds}s.`,
  );
  loadCheck(
    19,
    "max-silence",
    "Maximum silence",
    ["silence"],
    `${config.maxSilenceSeconds}s of no session activity ends the call, recorded as hangup_reason "watchdog:max_silence". ` +
      `A conversation that reaches a definitive answer ends before that: the runner hangs up once the person has ` +
      `decided and the agent has finished replying, recorded as hangup_reason "agent_hangup:final_yes" or ` +
      `"agent_hangup:final_no". The verdict is the classifier's own, so this closes no contact the classifier ` +
      `would not have closed anyway.`,
  );
  loadCheck(
    20,
    "retry-configuration",
    "Retry configuration",
    ["retry"],
    `Up to ${config.retry.maxAttempts} attempts per contact; no-answer after ${config.retry.noAnswerDelayMinutes}min, busy after ${config.retry.busyDelayMinutes}min, temporary backoff ${config.retry.temporaryBackoffMinutes.join("/")}min. ` +
      `Rejected retried: ${config.retry.retryOnRejected}; user hangup retried: ${config.retry.retryOnUserHangup}. Every retry stays on the contact's own provider — enforced by the database, not by this policy.`,
  );

  // ── 21. CSV / contact readiness ───────────────────────────────────
  let assignedByProvider = new Map<string, number>();
  let contactsMissingName = 0;
  if (!input.campaignId) {
    add({
      number: 21,
      id: "contact-readiness",
      title: "CSV / contact readiness",
      status: "SKIPPED",
      detail: "No campaign id given; this check is campaign-scoped.",
    });
  } else if (!campaign) {
    add({
      number: 21,
      id: "contact-readiness",
      title: "CSV / contact readiness",
      status: "BLOCKED",
      detail: dbReachable ? `Campaign ${input.campaignId} was not found.` : "The database is unreachable.",
    });
  } else {
    try {
      const [assigned, missingName, pending] = await Promise.all([
        countContactsByProvider(campaign.id),
        countContactsMissingName(campaign.id),
        query<{ n: number }>(
          "SELECT count(*)::int AS n FROM contacts WHERE campaign_id = $1 AND status = 'PENDING'",
          [campaign.id],
        ),
      ]);
      assignedByProvider = new Map(assigned);
      contactsMissingName = missingName;
      const total = [...assigned.values()].reduce((sum, count) => sum + count, 0);
      const pendingCount = pending.rows[0]?.n ?? 0;
      const script = findScript(campaign.scriptId, campaign.scriptVersion);
      const nameProblem = script?.requiresName === true && missingName > 0;

      add({
        number: 21,
        id: "contact-readiness",
        title: "CSV / contact readiness",
        status: total === 0 || pendingCount === 0 || nameProblem ? "BLOCKED" : "PASS",
        detail:
          `${total} contact(s) imported, ${pendingCount} pending and dialable now, ${missingName} without a name` +
          `${script?.requiresName ? " (this script needs one)" : ""}.`,
        ...(total === 0
          ? { remediation: "Import a CSV before starting." }
          : pendingCount === 0
            ? { remediation: "Nothing is pending; every contact is already terminal or scheduled for later." }
            : nameProblem
              ? { remediation: "Re-import with names, or move the campaign to a script that does not need one." }
              : {}),
      });
    } catch (error) {
      add({
        number: 21,
        id: "contact-readiness",
        title: "CSV / contact readiness",
        status: "BLOCKED",
        detail: `Could not read contacts: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  // ── 22. Script readiness ──────────────────────────────────────────
  if (!campaign) {
    add({
      number: 22,
      id: "script-readiness",
      title: "Script readiness",
      status: input.campaignId ? "BLOCKED" : "SKIPPED",
      detail: input.campaignId
        ? "Not evaluated: the campaign could not be read."
        : "No campaign id given; this check is campaign-scoped.",
    });
  } else {
    const script = findScript(campaign.scriptId, campaign.scriptVersion);
    const validation = validateCampaignScript({
      campaignType: campaign.campaignType,
      scriptId: campaign.scriptId,
      scriptVersion: campaign.scriptVersion,
      scriptHash: campaign.scriptHash,
      allocatedProviders: [...assignedByProvider.keys()] as never,
      contactsMissingName,
    });
    add({
      number: 22,
      id: "script-readiness",
      title: "Script readiness",
      status: validation.ok ? "PASS" : "BLOCKED",
      detail: validation.ok
        ? `"${campaign.scriptId} ${campaign.scriptVersion}" validates against the stored hash, matches campaign type "${campaign.campaignType}", placeholder: ${script?.isPlaceholder ?? "unknown"}. Agents: ${Object.entries(validation.agentsByProvider).map(([provider, agent]) => `${provider}=${agent}`).join(", ") || "none"}.`
        : validation.blockers.join(" "),
      ...(validation.ok ? {} : { remediation: "Resolve every script blocker; preflight refuses the run otherwise." }),
    });
  }

  // ── 23. Provider allocation ───────────────────────────────────────
  if (!campaign) {
    add({
      number: 23,
      id: "provider-allocation",
      title: "Provider allocation",
      status: input.campaignId ? "BLOCKED" : "SKIPPED",
      detail: input.campaignId
        ? "Not evaluated: the campaign could not be read."
        : "No campaign id given; this check is campaign-scoped.",
    });
  } else {
    const total = [...assignedByProvider.values()].reduce((sum, count) => sum + count, 0);
    const targets = total > 0 ? allocateCounts(total, campaign.providerAllocation) : new Map();
    const mismatches: string[] = [];
    const lines: string[] = [];
    for (const provider of new Set([
      ...Object.keys(campaign.providerAllocation),
      ...assignedByProvider.keys(),
    ])) {
      const target = targets.get(provider as never) ?? 0;
      const actual = assignedByProvider.get(provider) ?? 0;
      lines.push(`${provider} ${actual}/${target}`);
      if (target !== actual) mismatches.push(`${provider} has ${actual}, expected ${target}`);
    }
    add({
      number: 23,
      id: "provider-allocation",
      title: "Provider allocation",
      status: total === 0 ? "BLOCKED" : mismatches.length > 0 ? "BLOCKED" : "PASS",
      detail:
        total === 0
          ? "No contacts are assigned, so there is no allocation to check."
          : `Assigned/target per lane: ${lines.join(", ")}.${mismatches.length > 0 ? ` Mismatch: ${mismatches.join("; ")}.` : ""}`,
      ...(mismatches.length > 0
        ? {
            remediation:
              "The split in the database does not match the configured percentages. Re-import, or accept the actual split by updating the campaign.",
          }
        : {}),
    });
  }

  // ── 24. Provider-lock integrity ───────────────────────────────────
  if (!dbReachable) {
    add({
      number: 24,
      id: "provider-lock-integrity",
      title: "Provider-lock integrity",
      status: "BLOCKED",
      detail: "Not attempted: the database is unreachable.",
    });
  } else {
    try {
      const triggers = await query<{ tgname: string }>(
        `SELECT tgname FROM pg_trigger
          WHERE NOT tgisinternal
            AND tgname IN ('contacts_provider_immutable', 'call_attempts_provider_guard')`,
      );
      const present = new Set(triggers.rows.map((row) => row.tgname));
      const missingTriggers = ["contacts_provider_immutable", "call_attempts_provider_guard"].filter(
        (name) => !present.has(name),
      );

      const crossProvider = await query<{ n: number }>(
        input.campaignId
          ? `SELECT count(*)::int AS n FROM call_attempts a JOIN contacts c ON c.id = a.contact_id
              WHERE a.provider <> c.assigned_provider AND a.campaign_id = $1`
          : `SELECT count(*)::int AS n FROM call_attempts a JOIN contacts c ON c.id = a.contact_id
              WHERE a.provider <> c.assigned_provider`,
        input.campaignId ? [input.campaignId] : [],
      );
      const unknownProvider = await query<{ n: number }>(
        input.campaignId
          ? "SELECT count(*)::int AS n FROM contacts WHERE assigned_provider <> ALL($2::text[]) AND campaign_id = $1"
          : "SELECT count(*)::int AS n FROM contacts WHERE assigned_provider <> ALL($1::text[])",
        input.campaignId ? [input.campaignId, [...CAMPAIGN_TTS_PROVIDERS]] : [[...CAMPAIGN_TTS_PROVIDERS]],
      );

      const crossCount = crossProvider.rows[0]?.n ?? 0;
      const unknownCount = unknownProvider.rows[0]?.n ?? 0;
      const failed = missingTriggers.length > 0 || crossCount > 0 || unknownCount > 0;

      add({
        number: 24,
        id: "provider-lock-integrity",
        title: "Provider-lock integrity",
        status: failed ? "BLOCKED" : "PASS",
        detail: failed
          ? [
              missingTriggers.length > 0 ? `Missing trigger(s): ${missingTriggers.join(", ")}.` : "",
              crossCount > 0 ? `${crossCount} attempt(s) disagree with their contact's locked provider.` : "",
              unknownCount > 0 ? `${unknownCount} contact(s) are locked to a provider outside the three lanes.` : "",
            ]
              .filter(Boolean)
              .join(" ")
          : "Both database triggers are installed, no attempt disagrees with its contact's locked provider, and every contact is locked to one of the three lanes.",
        ...(failed ? { remediation: "Re-run `npm run db:migrate` and `npm run db:verify` before dialling anything." } : {}),
      });
    } catch (error) {
      add({
        number: 24,
        id: "provider-lock-integrity",
        title: "Provider-lock integrity",
        status: "BLOCKED",
        detail: `Could not verify the provider lock: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  // ── 25. Uniqueness / idempotency constraints ──────────────────────
  if (!dbReachable) {
    add({
      number: 25,
      id: "idempotency-constraints",
      title: "Database uniqueness / idempotency constraints",
      status: "BLOCKED",
      detail: "Not attempted: the database is unreachable.",
    });
  } else {
    const REQUIRED_CONSTRAINTS = [
      "contacts_one_number_per_campaign",
      "call_attempts_contact_attempt_unique",
      "webhook_events_dedupe",
    ];
    const REQUIRED_INDEXES = [
      "campaigns_idempotency_key_idx",
      "call_attempts_session_id_idx",
      "call_attempts_provider_call_id_idx",
    ];
    try {
      const constraints = await query<{ conname: string }>(
        "SELECT conname FROM pg_constraint WHERE conname = ANY($1::text[])",
        [REQUIRED_CONSTRAINTS],
      );
      const indexes = await query<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1::text[])",
        [REQUIRED_INDEXES],
      );
      const haveConstraints = new Set(constraints.rows.map((row) => row.conname));
      const haveIndexes = new Set(indexes.rows.map((row) => row.indexname));
      const missing = [
        ...REQUIRED_CONSTRAINTS.filter((name) => !haveConstraints.has(name)),
        ...REQUIRED_INDEXES.filter((name) => !haveIndexes.has(name)),
      ];

      add({
        number: 25,
        id: "idempotency-constraints",
        title: "Database uniqueness / idempotency constraints",
        status: missing.length === 0 ? "PASS" : "BLOCKED",
        detail:
          missing.length === 0
            ? "Present: one number per campaign, one attempt per (contact, attempt number), unique session id, unique provider call id, unique campaign idempotency key, webhook dedupe. These are what make a duplicate dial impossible rather than unlikely."
            : `Missing: ${missing.join(", ")}.`,
        ...(missing.length === 0
          ? {}
          : { remediation: "Run `npm run db:migrate`, then `npm run db:verify` to prove the guarantees hold." }),
      });
    } catch (error) {
      add({
        number: 25,
        id: "idempotency-constraints",
        title: "Database uniqueness / idempotency constraints",
        status: "BLOCKED",
        detail: `Could not read the catalogue: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  // ── Extras beyond the required 25 ─────────────────────────────────
  loadCheck(
    26,
    "call-ceiling",
    "Call ceiling and pilot ladder",
    ["call-ceiling"],
    `This run may place at most ${ceiling.effective} call(s), bound by the ${ceiling.boundBy} limit ` +
      `(environment ${ceiling.environmentMax}, pilot stage ${ceiling.pilotStage} -> ${ceiling.pilotStageMax ?? "full list"}, ` +
      `campaign control ${ceiling.campaignControlMax ?? "none"}). Absolute ceiling ${loadSafety.absolute.maxCallsPerRun}.`,
  );
  loadCheck(
    27,
    "dispatcher-timings",
    "Ring timeout, claim batch, poll interval, dispatcher lock",
    ["ring-timeout", "claim-batch", "poll-interval", "lock"],
    `Ring timeout ${config.ringTimeoutSeconds}s, claim batch ${config.claimBatchSize}, poll ${config.pollIntervalMs}ms, ` +
      `lock stale after ${config.lockStaleSeconds}s with a 15s heartbeat, dispatcher id "${config.dispatcherId}".`,
  );

  const unconfirmed = unconfirmedExternalLimits();
  const blockingScale = scalingBlockingLimits();
  add({
    number: 28,
    id: "external-limits",
    title: "External limits confirmed",
    status: blockingScale.length > 0 ? "WARN" : "PASS",
    detail:
      blockingScale.length > 0
        ? `${blockingScale.length} external limit(s) are unconfirmed and gate scaling past the pilot rungs: ` +
          `${blockingScale.map((limit) => limit.id).join(", ")}. A 10-call pilot may proceed without them; 500 or 2,000 calls may not.`
        : "Every external limit in the register has been confirmed.",
    ...(blockingScale.length > 0
      ? {
          remediation:
            "Obtain each value from the vendor and record it. `preflight.ts` keeps its own standing blocker on these until then.",
        }
      : {}),
  });

  const capabilities = callStatusCapabilities();
  const unavailable = capabilities.filter((capability) => !capability.available);
  add({
    number: 29,
    id: "call-status-observability",
    title: "Call-status observability (AMD, busy, rejected, hangup cause)",
    status: "WARN",
    detail:
      `${unavailable.length} of ${capabilities.length} call statuses cannot be established today: ` +
      `${unavailable.map((capability) => capability.status).join(", ")}. NO_ANSWER is inferred by our own ring watchdog ` +
      "and stored with status_source='inferred'; no carrier status callback is received and no answering-machine detection is requested.",
    remediation:
      "Confirm whether Vobiz supports a status callback and machine detection. Until then, treat BUSY and REJECTED counts as lower bounds and voicemail as indistinguishable from an answer.",
  });

  // ── Roll-up ───────────────────────────────────────────────────────
  const blockers = checks.filter((check) => check.status === "BLOCKED").map((check) => `${check.number}. ${check.title}: ${check.detail}`);
  const warnings = checks.filter((check) => check.status === "WARN").map((check) => `${check.number}. ${check.title}: ${check.detail}`);
  const skipped = checks.filter((check) => check.status === "SKIPPED").map((check) => `${check.number}. ${check.title}`);

  const overall: ProductionReadinessReport["overall"] =
    blockers.length > 0 ? "BLOCKED" : skipped.length > 0 ? "INCOMPLETE" : "PASS";

  const assumedCallSeconds =
    input.assumedCallSeconds ?? config.ringTimeoutSeconds + Math.round(config.maxCallSeconds / 2);

  return {
    scope: input.campaignId ? "campaign" : "environment",
    campaignId: input.campaignId ?? null,
    overall,
    dialingEnabled: config.dialingEnabled,
    neverEnablesDialing: true,
    checks,
    blockers,
    warnings,
    skipped,
    loadSafety,
    throughput: estimateThroughput(config, assumedCallSeconds),
    ceiling,
    callingWindow: {
      description: describeCallingWindow(window),
      openNow: windowVerdict.open,
      reason: windowVerdict.reason,
      enforced: window.enforced,
    },
    externalLimits: {
      total: getExternalLimits().length,
      needingConfirmation: unconfirmed,
      blockingScale,
    },
    statusCapabilities: capabilities,
    generatedAt: new Date(),
    note:
      "Read-only. This report contacted no vendor, placed no call, and changed nothing — including CAMPAIGN_DIALING_ENABLED, " +
      "which it will never set. A PASS is permission to proceed, not the act of proceeding.",
  };
}
