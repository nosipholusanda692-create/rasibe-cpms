import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { blindIndex, decrypt, loadKey } from './crypto.js';
import { sslSetting } from './db.js';

/**
 * Backup and restore (RCP-16, NFR-REL-003).
 *
 * A dump of this database is only half a backup. The identity, banking and
 * vetting values are ciphertext under DATA_ENCRYPTION_KEY, their uniqueness
 * hangs off DATA_INDEX_KEY, and every current password hash needs
 * PASSWORD_PEPPER. None of the three is in the dump, on purpose: a key stored
 * beside the data it protects protects nothing. Restored with the wrong keys,
 * the database comes back looking whole and nobody can sign in.
 *
 * So each backup writes a manifest beside the dump: its checksum, the row
 * count of every table, and a fingerprint of each key. The fingerprint is an
 * HMAC under the key itself, so it identifies a key without revealing it. A
 * restore checks all of it and fails loudly on any mismatch, rather than
 * reporting success over data that cannot be read.
 *
 * The dump and the counts come from one exported snapshot, so a backup taken
 * while the system is in use still restores to exactly the counts recorded.
 */

export const KEYS = [
  { name: 'DATA_ENCRYPTION_KEY', purpose: 'data' },
  { name: 'DATA_INDEX_KEY', purpose: 'index' },
  { name: 'PASSWORD_PEPPER', purpose: 'password-pepper' },
] as const;

const FINGERPRINT_LABEL = 'rasibe-key-fingerprint-v1';
const ENCRYPTED_COLUMNS = ['id_number', 'bank_name', 'bank_account_ref', 'vetting_status'] as const;
const DUMP_NAME = /^rasibe-(\d{8}T\d{6}Z)\.dump$/;
const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export interface Manifest {
  version: 1;
  createdAt: string;
  database: string;
  file: string;
  bytes: number;
  sha256: string;
  tables: Record<string, number>;
  keys: Record<string, string>;
}

/**
 * The owner connection. Backups read every row, and the application role
 * cannot: row-level security would hand pg_dump a partial copy.
 */
export interface OwnerConnection {
  host: string;
  port: number;
  user: string;
  password?: string;
  database: string;
  /** Run pg_dump and pg_restore inside this Docker container instead of locally. */
  dockerContainer?: string;
}

export function ownerConnectionFromEnv(database?: string): OwnerConnection {
  const env = process.env;
  return {
    host: env.BACKUP_PGHOST || env.PGHOST || 'localhost',
    port: Number(env.BACKUP_PGPORT || env.PGPORT || 5432),
    user: env.BACKUP_PGUSER || 'postgres',
    password: env.BACKUP_PGPASSWORD,
    database: database ?? (env.BACKUP_PGDATABASE || env.PGDATABASE || 'rasibe'),
    dockerContainer: env.PG_DOCKER_CONTAINER || undefined,
  };
}

function client(conn: OwnerConnection, database = conn.database): pg.Client {
  return new pg.Client({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    password: conn.password,
    database,
    ssl: sslSetting(),
  });
}

export function keyFingerprints(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of KEYS) {
    result[key.name] = createHmac('sha256', loadKey(key.name, key.purpose))
      .update(FINGERPRINT_LABEL)
      .digest('hex')
      .slice(0, 16);
  }
  return result;
}

/**
 * pg_dump and pg_restore are run with an argument list, never through a
 * shell. Inside Docker the tools use the container's local socket, so host
 * and port are left out and the password, if any, is forwarded by name.
 */
function pgTool(conn: OwnerConnection, tool: 'pg_dump' | 'pg_restore', args: string[], database: string) {
  const target = conn.dockerContainer
    ? ['-U', conn.user, '-d', database]
    : ['-h', conn.host, '-p', String(conn.port), '-U', conn.user, '-d', database];
  const env = { ...process.env, PGPASSWORD: conn.password ?? process.env.PGPASSWORD ?? '' };
  if (conn.dockerContainer) {
    return spawn('docker', ['exec', '-i', '-e', 'PGPASSWORD', conn.dockerContainer, tool, ...args, ...target], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
  return spawn(tool, [...args, ...target], { env, stdio: ['pipe', 'pipe', 'pipe'] });
}

function finished(child: ReturnType<typeof spawn>, tool: string): Promise<void> {
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.on('error', (err) => reject(new Error(`${tool} could not be started: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${tool} exited with ${code}: ${stderr.trim().split('\n').slice(-3).join(' ')}`));
    });
  });
}

async function tableCounts(c: pg.Client): Promise<Record<string, number>> {
  const { rows } = await c.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  const counts: Record<string, number> = {};
  for (const { tablename } of rows) {
    const quoted = (await c.query<{ q: string }>(`SELECT quote_ident($1) AS q`, [tablename])).rows[0].q;
    counts[tablename] = Number((await c.query(`SELECT count(*)::bigint AS n FROM public.${quoted}`)).rows[0].n);
  }
  return counts;
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Writes `rasibe-<UTC timestamp>.dump` and its `.json` manifest into `dir`. */
export async function runBackup(conn: OwnerConnection, dir: string, now = new Date()): Promise<{
  dumpPath: string;
  manifestPath: string;
  manifest: Manifest;
}> {
  await mkdir(dir, { recursive: true });
  const file = `rasibe-${stamp(now)}.dump`;
  const dumpPath = path.join(dir, file);
  const manifestPath = dumpPath.replace(/\.dump$/, '.json');

  const c = client(conn);
  await c.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = (await c.query<{ id: string }>('SELECT pg_export_snapshot() AS id')).rows[0].id;
    const tables = await tableCounts(c);

    const dump = pgTool(conn, 'pg_dump', ['--format=custom', `--snapshot=${snapshot}`], conn.database);
    dump.stdin?.end();
    const hash = createHash('sha256');
    let bytes = 0;
    const out = createWriteStream(dumpPath);
    dump.stdout?.on('data', (chunk: Buffer) => { hash.update(chunk); bytes += chunk.length; });
    dump.stdout?.pipe(out);
    const written = new Promise<void>((resolve, reject) => {
      out.on('finish', () => resolve());
      out.on('error', reject);
    });
    await Promise.all([finished(dump, 'pg_dump'), written]);
    await c.query('COMMIT');

    const manifest: Manifest = {
      version: 1,
      createdAt: now.toISOString(),
      database: conn.database,
      file,
      bytes,
      sha256: hash.digest('hex'),
      tables,
      keys: keyFingerprints(),
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return { dumpPath, manifestPath, manifest };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    await unlink(dumpPath).catch(() => undefined);
    throw err;
  } finally {
    await c.end();
  }
}

export async function readManifest(manifestPath: string): Promise<Manifest> {
  return JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
}

/**
 * Restores into a database that does not exist yet. Overwriting the live
 * database is never this script's decision: restore beside it, verify, and
 * swap names during a stop, so a bad backup costs nothing.
 */
export async function restoreBackup(conn: OwnerConnection, manifestPath: string, target: string): Promise<void> {
  if (!DATABASE_NAME.test(target)) {
    throw new Error(`"${target}" is not a plain database name (lower case letters, digits, underscores).`);
  }
  const manifest = await readManifest(manifestPath);
  const dumpPath = path.join(path.dirname(manifestPath), manifest.file);

  const actual = await sha256File(dumpPath);
  if (actual !== manifest.sha256) {
    throw new Error(`${manifest.file} does not match its manifest checksum. Nothing was restored.`);
  }

  const admin = client(conn, 'postgres');
  await admin.connect();
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [target]);
    if (exists.rowCount) {
      throw new Error(`Database ${target} already exists. Restore into a new name.`);
    }
    await admin.query(`CREATE DATABASE ${target}`);
  } finally {
    await admin.end();
  }

  const restore = pgTool(conn, 'pg_restore', ['--exit-on-error', '--no-owner'], target);
  // A pg_restore that fails early closes its input; its exit code reports that.
  restore.stdin?.on('error', () => undefined);
  createReadStream(dumpPath).pipe(restore.stdin!);
  restore.stdout?.resume();
  await finished(restore, 'pg_restore');
}

export interface VerifyReport {
  ok: boolean;
  problems: string[];
  checked: { tables: number; encryptedValues: number; indexedValues: number };
}

/**
 * Proves a restored database is usable with the keys in this environment,
 * not just present. Every encrypted value is decrypted and every identity
 * fingerprint recomputed. The pepper cannot be tested that way without a
 * password, which is what its manifest fingerprint is for.
 */
export async function verifyRestore(conn: OwnerConnection, manifestPath: string, database: string): Promise<VerifyReport> {
  const manifest = await readManifest(manifestPath);
  const problems: string[] = [];

  const current = keyFingerprints();
  for (const { name } of KEYS) {
    if (manifest.keys[name] !== current[name]) {
      problems.push(`${name} in this environment is not the key this backup was taken with.`);
    }
  }

  const c = client(conn, database);
  await c.connect();
  let encryptedValues = 0;
  let indexedValues = 0;
  try {
    const counts = await tableCounts(c);
    for (const [table, expected] of Object.entries(manifest.tables)) {
      if (counts[table] !== expected) {
        problems.push(`${table}: expected ${expected} rows, found ${counts[table] ?? 'no table'}.`);
      }
    }

    const { rows } = await c.query(
      `SELECT consultant_id, id_number_bidx, ${ENCRYPTED_COLUMNS.join(', ')} FROM consultant`,
    );
    let unreadable = 0;
    let mismatched = 0;
    for (const row of rows) {
      for (const col of ENCRYPTED_COLUMNS) {
        if (row[col] === null) continue;
        encryptedValues += 1;
        try {
          const plain = decrypt(row[col]);
          if (col === 'id_number') {
            indexedValues += 1;
            if (blindIndex(plain) !== row.id_number_bidx) mismatched += 1;
          }
        } catch {
          unreadable += 1;
        }
      }
    }
    if (unreadable) problems.push(`${unreadable} encrypted values cannot be decrypted with DATA_ENCRYPTION_KEY.`);
    if (mismatched) problems.push(`${mismatched} identity fingerprints do not match DATA_INDEX_KEY.`);

    return {
      ok: problems.length === 0,
      problems,
      checked: { tables: Object.keys(counts).length, encryptedValues, indexedValues },
    };
  } finally {
    await c.end();
  }
}

/**
 * Deletes dumps, and their manifests, older than the retention period. The
 * newest dump is always kept, however old, so a stopped schedule never ends
 * with no backup at all. Only files this module named are considered.
 */
export async function pruneBackups(dir: string, retentionDays: number, now = new Date()): Promise<string[]> {
  const dumps = (await readdir(dir))
    .map((name) => ({ name, match: DUMP_NAME.exec(name) }))
    .filter((d): d is { name: string; match: RegExpExecArray } => d.match !== null)
    .map(({ name, match }) => {
      const s = match[1];
      const taken = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);
      return { name, taken };
    })
    .sort((a, b) => b.taken.getTime() - a.taken.getTime());

  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const removed: string[] = [];
  for (const dump of dumps.slice(1)) {
    if (dump.taken.getTime() >= cutoff) continue;
    for (const name of [dump.name, dump.name.replace(/\.dump$/, '.json')]) {
      const full = path.join(dir, name);
      if (await stat(full).then(() => true, () => false)) {
        await unlink(full);
        removed.push(name);
      }
    }
  }
  return removed;
}
