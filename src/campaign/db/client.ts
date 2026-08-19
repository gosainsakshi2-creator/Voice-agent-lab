/**
 * client.ts
 *
 * The single PostgreSQL connection pool for the campaign layer.
 *
 * Scope boundary: nothing in the existing voice agent imports this
 * file. `VoiceSessionManager` stays entirely in-memory and unchanged
 * — the campaign layer is the only thing that talks to a database,
 * and it does so strictly before `start()` and after `end()`.
 *
 * Pinned to `globalThis` for the same reason `server/runtime.ts`
 * pins the provider registry: Next's dev-mode module reloading would
 * otherwise construct a second pool on every route recompile and leak
 * connections until Supabase refuses new ones.
 *
 * Configuration is read through the project's existing
 * `providers/shared/env` helpers rather than a second convention, so
 * a missing variable fails the same way and with the same error type
 * everywhere in the codebase.
 */

import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from "pg";

import { optionalEnv, optionalEnvNumber, requireEnv } from "../../providers/shared/env";

/** Used only in `ConfigurationError` messages, never sent anywhere. */
const CONFIG_SCOPE = "campaign-db";

declare global {
  // eslint-disable-next-line no-var
  var __campaignDbPool: Pool | undefined;
}

/**
 * TLS settings for the connection.
 *
 * Supabase's connection pooler terminates TLS with a certificate that
 * does not validate against Node's bundled CA set, so a plain
 * `ssl: true` fails while the connection is in fact encrypted. That
 * leaves `rejectUnauthorized: false` as the working default for this
 * deployment — it keeps the transport encrypted but does not verify
 * the peer, so it trades certificate pinning for connectivity.
 *
 * Both halves are environment-controlled rather than hard-coded:
 * set `DATABASE_SSL=disable` for a local unencrypted Postgres, or
 * `DATABASE_SSL_REJECT_UNAUTHORIZED=true` once a CA bundle is pinned.
 */
function resolveSslConfig(): PoolConfig["ssl"] {
  if (optionalEnv("DATABASE_SSL", "require") === "disable") return false;
  return {
    rejectUnauthorized: optionalEnv("DATABASE_SSL_REJECT_UNAUTHORIZED", "false") === "true",
  };
}

function createPool(): Pool {
  const pool = new Pool({
    connectionString: requireEnv("DATABASE_URL", CONFIG_SCOPE),
    // Sized to the dispatcher's global concurrency plus headroom for
    // API reads. Deliberately modest: Supabase's pooler has its own
    // upstream limit, and a large client-side pool just moves the
    // queue rather than shortening it.
    max: optionalEnvNumber("DATABASE_POOL_MAX", 10),
    idleTimeoutMillis: optionalEnvNumber("DATABASE_IDLE_TIMEOUT_MS", 30_000),
    connectionTimeoutMillis: optionalEnvNumber("DATABASE_CONNECT_TIMEOUT_MS", 15_000),
    ssl: resolveSslConfig(),
    application_name: "voice-agent-lab-campaign",
  });

  // An idle client can be dropped by the pooler at any time. Without
  // a listener, `pg` re-emits that as an unhandled 'error' event and
  // takes the whole process — and therefore every in-flight call —
  // down with it. The pool discards the broken client on its own; all
  // this has to do is refuse to let it be fatal.
  pool.on("error", (error) => {
    // eslint-disable-next-line no-console
    console.error(`[campaign-db] idle client error (pool recovers automatically): ${error.message}`);
  });

  return pool;
}

/** The process-wide pool. Constructed on first use, never twice. */
export function getDbPool(): Pool {
  globalThis.__campaignDbPool ??= createPool();
  return globalThis.__campaignDbPool;
}

/** Run a single statement on a pooled connection. */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: readonly unknown[],
): Promise<QueryResult<T>> {
  return getDbPool().query<T>(text, params ? [...params] : undefined);
}

/**
 * Run `fn` inside a transaction, committing on success and rolling
 * back on any thrown error. The client is always released, including
 * when the rollback itself fails — a leaked client is worse than a
 * lost error message, because it silently shrinks the pool.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getDbPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Close the pool. Called by scripts on completion and by a graceful
 * shutdown handler; safe to call when no pool was ever created.
 */
export async function closeDbPool(): Promise<void> {
  const pool = globalThis.__campaignDbPool;
  if (!pool) return;
  globalThis.__campaignDbPool = undefined;
  await pool.end();
}

/**
 * Liveness probe. Returns the server version on success so a caller
 * can log something useful; throws with the driver's message on
 * failure. Never returns or logs any part of the connection string.
 */
export async function checkDbConnection(): Promise<{ serverVersion: string; database: string }> {
  const result = await query<{ server_version: string; database: string }>(
    "SELECT current_setting('server_version') AS server_version, current_database() AS database",
  );
  const row = result.rows[0];
  if (!row) throw new Error("Database connectivity check returned no rows.");
  return { serverVersion: row.server_version, database: row.database };
}
