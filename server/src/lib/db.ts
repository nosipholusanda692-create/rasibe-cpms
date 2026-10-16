import pg from 'pg';
import { readFileSync } from 'node:fs';
import 'dotenv/config';
import { logServerError, newErrorId } from './logging.js';

const { Pool } = pg;

/** A positive whole number of milliseconds from the environment, else the default. */
function positiveMs(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Longest a single statement may run, set per transaction in withActor. */
export const STATEMENT_TIMEOUT_MS = positiveMs(process.env.STATEMENT_TIMEOUT_MS, 30_000);

/**
 * NFR-SEC-001 on the second hop: the connection between this process and the
 * database carries every rate and identity value in the system.
 *
 * Off unless asked for, so local development and CI are unchanged: there the
 * database is on the same host or inside the same runner network. A hosted
 * database needs at least `require`, which encrypts but does not prove who
 * answered. `verify-ca` and `verify-full` also check the chain, which needs
 * PGSSLROOTCERT unless the authority is already trusted by the system.
 *
 * An unrecognised mode is treated as the stricter one. A typo should fail
 * loudly rather than quietly leave the connection unverified.
 */
export function sslSetting(): false | { rejectUnauthorized: boolean; ca?: string } {
  const mode = process.env.PGSSLMODE;
  if (!mode || mode === 'disable') return false;

  // 'system' means the platform's own trust store, as it does for libpq 16, so
  // pg_dump and this process can share one setting.
  const rootCert = process.env.PGSSLROOTCERT;
  return {
    rejectUnauthorized: mode !== 'require',
    ca: rootCert && rootCert !== 'system' ? readFileSync(rootCert, 'utf8') : undefined,
  };
}

// numeric / int8 come back as strings by default; the money and hour columns
// in this system are all within safe range, so parse them as numbers.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

// date has no time zone. The default turns it into a Date at local midnight,
// which on a UTC+2 server serialises as the previous day ("2026-10-11T22:00Z"
// for 12 October). Keep it as the YYYY-MM-DD the database holds.
pg.types.setTypeParser(1082, (v) => v);

export const pool = new Pool({
  host: process.env.PGHOST ?? 'localhost',
  port: Number(process.env.PGPORT ?? 5432),
  database: process.env.PGDATABASE ?? 'rasibe',
  user: process.env.PGUSER ?? 'rasibe_app',
  password: process.env.PGPASSWORD ?? 'rasibe_app_pw',
  ssl: sslSetting(),
  max: 10,
  idleTimeoutMillis: 30_000,
  // A database that does not answer must become an error, not a request that
  // waits for ever. Connecting gives up after ten seconds; a query after the
  // client-side limit below. query_timeout is the backstop: the usual limit is
  // set inside each transaction (see withActor), which also cancels the query
  // on the server, and works through a pooler where a startup parameter would not.
  connectionTimeoutMillis: 10_000,
  query_timeout: positiveMs(process.env.QUERY_TIMEOUT_MS, 40_000),
  // Without keep-alive a connection a firewall has silently dropped looks open
  // until the next query hangs on it.
  keepAlive: true,
});

// An idle client in the pool can be dropped by the server or the network (a
// hosted database closes idle connections, and restarts). The pool reports that
// as an 'error' event, and an event with no listener ends the process. Log it,
// and the pool discards the client and opens another when one is next needed.
pool.on('error', (err) => {
  logServerError(newErrorId(), err, 'POOL', 'idle client');
});

export type Role = 'ADMINISTRATOR' | 'RECRUITER' | 'CONSULTANT' | 'CLIENT_MANAGER';

export interface Actor {
  userId: string;
  role: Role;
}

/**
 * Runs a unit of work with the actor identity set on the connection.
 *
 * Row-level security policies read rasibe.actor_user_id and rasibe.actor_role,
 * so every statement inside is filtered by the database itself. SET LOCAL is
 * used deliberately: the setting is scoped to the transaction and cannot leak
 * to the next request that borrows this pooled connection.
 */
export async function withActor<T>(
  actor: Actor | null,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  // Set when the connection can no longer be trusted (the ROLLBACK itself failed,
  // as it does when the link is gone). Such a client is discarded, not returned
  // to the pool for the next request to pick up.
  let broken = false;
  // While a request holds a connection the pool is not listening to it. If the
  // link drops between two queries, the driver raises 'error' on the connection
  // itself, and with no listener that ends the process. The next query on it
  // then fails normally, which is how the request learns of it.
  const onClientError = (err: Error) => {
    broken = true;
    logServerError(newErrorId(), err, 'POOL', 'client in use');
  };
  client.on('error', onClientError);
  try {
    await client.query('BEGIN');
    // Local to this transaction, like the actor settings: a statement that runs
    // past the limit is cancelled by the server and becomes a 503, not a hang.
    await client.query('SELECT set_config($1, $2, true)', ['statement_timeout', String(STATEMENT_TIMEOUT_MS)]);
    if (actor) {
      await client.query('SELECT set_config($1, $2, true)', ['rasibe.actor_user_id', actor.userId]);
      await client.query('SELECT set_config($1, $2, true)', ['rasibe.actor_role', actor.role]);
    } else {
      await client.query('SELECT set_config($1, $2, true)', ['rasibe.actor_user_id', '']);
      await client.query('SELECT set_config($1, $2, true)', ['rasibe.actor_role', '']);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // The fault that matters is the original one. A failed ROLLBACK must not
    // replace it, and says the connection is dead.
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true;
    }
    throw err;
  } finally {
    client.removeListener('error', onClientError);
    client.release(broken || undefined);
  }
}

/** Convenience for a single read with the actor context applied. */
export async function query<T = any>(
  actor: Actor | null,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  return withActor(actor, async (c) => (await c.query(text, params)).rows as T[]);
}

/** Connections used before a session exists, such as sign in. */
export async function anonQuery<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await pool.query(text, params);
  return r.rows as T[];
}

export async function closePool(): Promise<void> {
  await pool.end();
}
