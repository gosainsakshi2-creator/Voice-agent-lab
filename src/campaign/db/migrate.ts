/**
 * migrate.ts
 *
 * Explicit migration runner: `npm run db:migrate`.
 *
 * Deliberately NOT wired into server start-up. `server.ts` must be
 * able to boot, serve the existing dashboard, and run existing voice
 * calls whether or not the campaign schema has ever been applied —
 * making the running voice agent depend on a migration completing
 * would put the working system at the mercy of a database that it
 * otherwise never touches.
 *
 * Guarantees:
 *   - deterministic order          — filenames sorted lexicographically
 *   - applied exactly once         — recorded in `schema_migrations`
 *   - atomic                       — one transaction per migration
 *   - tamper-evident               — checksum compared on every run
 *   - single-runner                — advisory lock, so two concurrent
 *                                    deploys cannot race
 *   - loud on failure              — rolls back, prints, exits 1
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { config as loadEnvFile } from "dotenv";

// Standalone scripts do not go through Next, which is what normally
// loads `.env.local`. Load it first; `dotenv` never overwrites a
// variable that is already set, so a real environment still wins.
loadEnvFile({ path: ".env.local", quiet: true });
loadEnvFile({ quiet: true });

const { getDbPool, closeDbPool } = await import("./client");

/** Arbitrary but fixed: two runners must derive the same lock key. */
const MIGRATION_ADVISORY_LOCK_KEY = 8_142_390_115_573_001n;

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations", import.meta.url));

interface MigrationFile {
  readonly version: string;
  readonly filename: string;
  readonly sql: string;
  readonly checksum: string;
}

interface AppliedRow {
  readonly version: string;
  readonly checksum: string;
}

function checksumOf(sql: string): string {
  // Normalise line endings so a checkout on Windows and one on Linux
  // do not disagree about a file nobody edited.
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

async function loadMigrations(): Promise<readonly MigrationFile[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  const sqlFiles = entries.filter((name) => name.endsWith(".sql")).sort();

  const migrations: MigrationFile[] = [];
  for (const filename of sqlFiles) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, filename), "utf8");
    const version = filename.replace(/\.sql$/, "");
    migrations.push({ version, filename, sql, checksum: checksumOf(sql) });
  }
  return migrations;
}

async function main(): Promise<void> {
  const migrations = await loadMigrations();
  if (migrations.length === 0) {
    console.log("[migrate] no migration files found — nothing to do");
    return;
  }

  const client = await getDbPool().connect();
  let lockHeld = false;

  try {
    // Serialise runners. A second `npm run db:migrate` (or a second
    // deploy) blocks here rather than applying the same DDL twice.
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_ADVISORY_LOCK_KEY.toString()]);
    lockHeld = true;

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version      text PRIMARY KEY,
        filename     text NOT NULL,
        checksum     text NOT NULL,
        applied_at   timestamptz NOT NULL DEFAULT now(),
        execution_ms integer NOT NULL
      )
    `);

    const appliedResult = await client.query<AppliedRow>(
      "SELECT version, checksum FROM schema_migrations",
    );
    const applied = new Map(appliedResult.rows.map((row) => [row.version, row.checksum]));

    // Tamper check before applying anything: an already-applied file
    // that has since been edited means the database and the
    // repository disagree about what the schema is. Never silently
    // re-run it — the fix is a new migration file, not an edit.
    for (const migration of migrations) {
      const previousChecksum = applied.get(migration.version);
      if (previousChecksum !== undefined && previousChecksum !== migration.checksum) {
        throw new Error(
          `Migration "${migration.filename}" has already been applied but its contents have changed.\n` +
            `  recorded checksum: ${previousChecksum}\n` +
            `  current checksum : ${migration.checksum}\n` +
            `Add a new migration file instead of editing an applied one.`,
        );
      }
    }

    const pending = migrations.filter((migration) => !applied.has(migration.version));
    if (pending.length === 0) {
      console.log(`[migrate] up to date — ${migrations.length} migration(s) already applied`);
      return;
    }

    console.log(`[migrate] ${pending.length} pending migration(s)`);

    for (const migration of pending) {
      const startedAt = Date.now();
      console.log(`[migrate] applying ${migration.filename} ...`);

      try {
        await client.query("BEGIN");
        await client.query(migration.sql);
        const executionMs = Date.now() - startedAt;
        await client.query(
          `INSERT INTO schema_migrations (version, filename, checksum, execution_ms)
           VALUES ($1, $2, $3, $4)`,
          [migration.version, migration.filename, migration.checksum, executionMs],
        );
        await client.query("COMMIT");
        console.log(`[migrate] applied  ${migration.filename} in ${executionMs}ms`);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Migration "${migration.filename}" FAILED and was rolled back: ${message}`);
      }
    }

    console.log(`[migrate] done — ${pending.length} migration(s) applied`);
  } finally {
    if (lockHeld) {
      await client
        .query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_KEY.toString()])
        .catch(() => undefined);
    }
    client.release();
    await closeDbPool();
  }
}

try {
  await main();
  process.exit(0);
} catch (error) {
  console.error(`[migrate] ${error instanceof Error ? error.message : String(error)}`);
  await closeDbPool().catch(() => undefined);
  process.exit(1);
}
