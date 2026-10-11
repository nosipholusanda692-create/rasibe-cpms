/**
 * Backup and restore drill (RCP-16, NFR-REL-003).
 *
 * Takes a real backup of the database, restores it into a new one, and
 * proves the copy is usable: the same rows, readable ciphertext, working
 * grants and row-level security, and a peppered password that still
 * verifies. Then it proves the restore refuses what it should: a tampered
 * dump, an existing target, and each of the three keys being wrong.
 *
 * Needs the owner connection (BACKUP_PG*), and pg_dump and pg_restore on the
 * path or inside PG_DOCKER_CONTAINER. Run with:  npm run test:backup
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import {
  KEYS, ownerConnectionFromEnv, pruneBackups, readManifest, restoreBackup, runBackup, verifyRestore,
} from '../lib/backup.js';
import { hashPassword, verifyPassword } from '../lib/passwords.js';

const RESTORED = 'rasibe_restore_drill';
const DRILL_USER = 'christinah@rasibe.co.za';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  \u2717 ${name}`);
    if (detail !== undefined) console.log(`      ${JSON.stringify(detail).slice(0, 300)}`);
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

const conn = ownerConnectionFromEnv();

async function ownerQuery<T extends pg.QueryResultRow>(database: string, sql: string, params: unknown[] = []) {
  const c = new pg.Client({ host: conn.host, port: conn.port, user: conn.user, password: conn.password, database });
  await c.connect();
  try {
    return (await c.query<T>(sql, params)).rows;
  } finally {
    await c.end();
  }
}

async function dropRestored() {
  await ownerQuery('postgres', `DROP DATABASE IF EXISTS ${RESTORED} WITH (FORCE)`);
}

/** Runs the restore script in its own process, as an operator would, with one key changed. */
function verifyWithEnv(manifestPath: string, overrides: Record<string, string>) {
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/scripts/restore.ts', '--verify-only', manifestPath, RESTORED],
      { env: { ...process.env, ...overrides } },
    );
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    child.on('close', (code) => resolve({ code, output }));
  });
}

async function main() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rasibe-backup-'));
  await dropRestored();

  try {
    // -----------------------------------------------------------------
    section('Taking a backup');
    // -----------------------------------------------------------------
    // One account on the current, peppered form, so the restored copy can
    // be asked to verify a password that genuinely needs the pepper.
    await ownerQuery(conn.database, `UPDATE app_user SET password_hash = $2 WHERE email = $1`, [
      DRILL_USER, await hashPassword('Password123!'),
    ]);

    const { dumpPath, manifestPath, manifest } = await runBackup(conn, dir);
    const dumpBytes = (await readFile(dumpPath)).length;
    check('a dump and a manifest are written', dumpBytes > 0 && manifest.file === path.basename(dumpPath));
    check('the manifest records the size of the dump', manifest.bytes === dumpBytes,
      { manifest: manifest.bytes, actual: dumpBytes });
    check('every table is counted',
      manifest.tables.consultant > 0 && manifest.tables.app_user > 0 && manifest.tables.audit_entry >= 0,
      manifest.tables);
    check('a fingerprint is recorded for each of the three keys',
      KEYS.every((k) => /^[0-9a-f]{16}$/.test(manifest.keys[k.name] ?? '')), manifest.keys);

    const manifestText = await readFile(manifestPath, 'utf8');
    const keyValues = KEYS.map((k) => process.env[k.name]).filter((v): v is string => !!v);
    check('no key appears in the manifest', keyValues.every((v) => !manifestText.includes(v)));

    // -----------------------------------------------------------------
    section('Restoring it');
    // -----------------------------------------------------------------
    await restoreBackup(conn, manifestPath, RESTORED);
    const report = await verifyRestore(conn, manifestPath, RESTORED);
    check('the restored database passes verification', report.ok, report.problems);
    check('every encrypted value was decrypted, not skipped',
      report.checked.encryptedValues > 0 && report.checked.indexedValues > 0, report.checked);

    const sourceRls = await ownerQuery<{ n: string }>(conn.database,
      `SELECT count(*) AS n FROM pg_class WHERE relrowsecurity AND relnamespace = 'public'::regnamespace`);
    const restoredRls = await ownerQuery<{ n: string }>(RESTORED,
      `SELECT count(*) AS n FROM pg_class WHERE relrowsecurity AND relnamespace = 'public'::regnamespace`);
    check('row-level security is still switched on for the same tables',
      Number(restoredRls[0].n) > 0 && restoredRls[0].n === sourceRls[0].n,
      { source: sourceRls[0].n, restored: restoredRls[0].n });

    // The application connects as rasibe_app, not as the owner. Its grants
    // are what make the copy usable, and the audit revoke is what keeps it honest.
    const app = new pg.Client({
      host: conn.host, port: conn.port, user: 'rasibe_app', password: 'rasibe_app_pw', database: RESTORED,
    });
    await app.connect();
    try {
      const hash = (await app.query<{ password_hash: string }>(
        `SELECT password_hash FROM app_user WHERE email = $1`, [DRILL_USER])).rows[0]?.password_hash ?? '';
      check('the application role can read the restored accounts', hash.length > 0);
      check('a peppered password verifies against the restored copy',
        await verifyPassword('Password123!', hash));

      let auditRefused = false;
      try {
        await app.query(`UPDATE audit_entry SET action = action`);
      } catch {
        auditRefused = true;
      }
      check('the audit log is still append-only for the application', auditRefused);
    } finally {
      await app.end();
    }

    // -----------------------------------------------------------------
    section('What a restore must refuse');
    // -----------------------------------------------------------------
    let refusedExisting = '';
    try {
      await restoreBackup(conn, manifestPath, RESTORED);
    } catch (err) {
      refusedExisting = (err as Error).message;
    }
    check('a restore over an existing database is refused', /already exists/.test(refusedExisting),
      refusedExisting);

    const tamperedDir = path.join(dir, 'tampered');
    await mkdir(tamperedDir);
    const tamperedDump = path.join(tamperedDir, manifest.file);
    await copyFile(dumpPath, tamperedDump);
    const bytes = await readFile(tamperedDump);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    await writeFile(tamperedDump, bytes);
    await copyFile(manifestPath, path.join(tamperedDir, path.basename(manifestPath)));
    let refusedTampered = '';
    try {
      await restoreBackup(conn, path.join(tamperedDir, path.basename(manifestPath)), 'rasibe_restore_tampered');
    } catch (err) {
      refusedTampered = (err as Error).message;
    }
    const tamperedCreated = await ownerQuery('postgres',
      `SELECT 1 FROM pg_database WHERE datname = 'rasibe_restore_tampered'`);
    check('a dump that does not match its checksum is refused', /checksum/.test(refusedTampered),
      refusedTampered);
    check('nothing is created from a tampered dump', tamperedCreated.length === 0);

    // Each key on its own. The point of the fingerprints is that a restore
    // with the wrong key fails here, not at the first sign-in afterwards.
    for (const key of KEYS) {
      const wrong = await verifyWithEnv(manifestPath, { [key.name]: randomBytes(32).toString('hex') });
      check(`a restore checked with the wrong ${key.name} fails`,
        wrong.code !== 0 && wrong.output.includes(key.name), { code: wrong.code, output: wrong.output.slice(-300) });
    }

    const right = await verifyWithEnv(manifestPath, {});
    check('the same check passes with the right keys', right.code === 0, right.output.slice(-300));

    // -----------------------------------------------------------------
    section('Retention');
    // -----------------------------------------------------------------
    const retentionDir = path.join(dir, 'retention');
    await mkdir(retentionDir);
    const names = [
      'rasibe-20260101T020000Z', // old
      'rasibe-20260901T020000Z', // old
      'rasibe-20261001T020000Z', // inside 30 days
      'rasibe-20261010T020000Z', // newest
    ];
    for (const n of names) {
      await writeFile(path.join(retentionDir, `${n}.dump`), 'x');
      await writeFile(path.join(retentionDir, `${n}.json`), '{}');
    }
    await writeFile(path.join(retentionDir, 'notes.txt'), 'not a backup');
    const now = new Date(Date.UTC(2026, 9, 11));
    const removed = await pruneBackups(retentionDir, 30, now);
    const left = (await readdir(retentionDir)).sort();
    check('backups past the retention period are removed, with their manifests',
      removed.length === 4 && !left.some((n) => n.startsWith('rasibe-20260101') || n.startsWith('rasibe-20260901')),
      { removed, left });
    check('backups inside the retention period are kept',
      left.includes('rasibe-20261001T020000Z.dump') && left.includes('rasibe-20261010T020000Z.dump'), left);
    check('files the backup did not write are left alone', left.includes('notes.txt'), left);

    const loneDir = path.join(dir, 'lone');
    await mkdir(loneDir);
    await writeFile(path.join(loneDir, 'rasibe-20250101T020000Z.dump'), 'x');
    await pruneBackups(loneDir, 30, now);
    check('the newest backup is kept however old it is',
      (await readdir(loneDir)).includes('rasibe-20250101T020000Z.dump'));

    const restoredManifest = await readManifest(manifestPath);
    check('the manifest can be read back as written', restoredManifest.sha256 === manifest.sha256);
  } finally {
    await dropRestored().catch(() => undefined);
    await ownerQuery('postgres', 'DROP DATABASE IF EXISTS rasibe_restore_tampered WITH (FORCE)').catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }

  console.log(`\n${'='.repeat(58)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\n  Failures:');
    failures.forEach((f) => console.log(`   - ${f}`));
  }
  console.log('='.repeat(58));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('Backup drill could not complete:', e);
  process.exit(1);
});
