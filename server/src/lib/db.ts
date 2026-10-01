import pg from 'pg';
import { readFileSync } from 'node:fs';
import 'dotenv/config';

const { Pool } = pg;

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
function sslSetting(): false | { rejectUnauthorized: boolean; ca?: string } {
  const mode = process.env.PGSSLMODE;
  if (!mode || mode === 'disable') return false;

  const rootCert = process.env.PGSSLROOTCERT;
  return {
    rejectUnauthorized: mode !== 'require',
    ca: rootCert ? readFileSync(rootCert, 'utf8') : undefined,
  };
}

// numeric / int8 come back as strings by default; the money and hour columns
// in this system are all within safe range, so parse them as numbers.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export const pool = new Pool({
  host: process.env.PGHOST ?? 'localhost',
  port: Number(process.env.PGPORT ?? 5432),
  database: process.env.PGDATABASE ?? 'rasibe',
  user: process.env.PGUSER ?? 'rasibe_app',
  password: process.env.PGPASSWORD ?? 'rasibe_app_pw',
  ssl: sslSetting(),
  max: 10,
  idleTimeoutMillis: 30_000,
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
  try {
    await client.query('BEGIN');
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
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
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
