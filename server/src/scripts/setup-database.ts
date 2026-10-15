/**
 * Builds an empty database from db/01 to db/04, for a hosted server or a new
 * local one. See docs/DEPLOY.md.
 *
 *   npm run db:setup
 *
 * Connects as the owner (BACKUP_PGHOST, BACKUP_PGUSER, BACKUP_PGPASSWORD,
 * BACKUP_PGDATABASE, PGSSLMODE), the same connection backups use. Refuses a
 * database that already holds the schema: this is for building one, never for
 * re-seeding a live system.
 *
 * Anywhere other than this machine it also needs the three passwords the seed
 * would otherwise leave at their published values:
 *
 *   RASIBE_APP_PASSWORD        the API's database login
 *   RASIBE_REPORTING_PASSWORD  the reporting login
 *   DEMO_ACCOUNT_PASSWORD      every seeded sign-in, administrator included
 *
 * None of them is printed. Afterwards, run `npm run encrypt-existing` as
 * rasibe_app with the production keys, because the seed writes identity and
 * banking values in clear.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ownerConnectionFromEnv } from '../lib/backup.js';
import { checkBreached } from '../lib/breached.js';
import { sslSetting } from '../lib/db.js';
import { hashPassword } from '../lib/passwords.js';
import { passwordRule } from '../routes/auth.js';

const DB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db');
const FILES = ['01_schema.sql', '02_security.sql', '03_triggers.sql', '04_seed.sql'];
const EXTENSIONS = ['pgcrypto', 'btree_gist', 'pg_trgm'];

// What the API calls by name. A file that applies cleanly but leaves one of
// these out is how timesheet submission broke on a fresh build.
const FUNCTIONS = [
  'actor_id', 'actor_role', 'is_admin', 'is_internal', 'actor_consultant_id',
  'actor_client_ids', 'actor_visible_consultant_ids', 'actor_placement_client_ids',
  'placement_approver_user', 'issue_account_token', 'redeem_account_token',
  'account_token_subject', 'account_for_reset',
];

const ROLES = [
  { role: 'rasibe_app', env: 'RASIBE_APP_PASSWORD' },
  { role: 'rasibe_reporting', env: 'RASIBE_REPORTING_PASSWORD' },
] as const;

const MIN_ROLE_PASSWORD = 20;

function isLocal(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/** Every refusal that needs no connection, so a bad setting costs nothing. */
async function checkSettings(host: string): Promise<string[]> {
  const problems: string[] = [];
  const local = isLocal(host);

  for (const { env } of ROLES) {
    const value = process.env[env];
    if (!value) {
      if (!local) problems.push(`${env} is required for a database on ${host}.`);
    } else if (value.length < MIN_ROLE_PASSWORD) {
      problems.push(`${env} must be at least ${MIN_ROLE_PASSWORD} characters.`);
    }
  }

  const demo = process.env.DEMO_ACCOUNT_PASSWORD;
  if (!demo) {
    if (!local) problems.push(`DEMO_ACCOUNT_PASSWORD is required for a database on ${host}.`);
  } else {
    const rule = passwordRule.safeParse(demo);
    if (!rule.success) {
      problems.push(`DEMO_ACCOUNT_PASSWORD: ${rule.error.issues.map((i) => i.message).join('; ')}.`);
    } else if (demo === 'Password123!') {
      problems.push('DEMO_ACCOUNT_PASSWORD cannot be the published demonstration password.');
    } else if ((await checkBreached(demo)) === 'breached') {
      problems.push('DEMO_ACCOUNT_PASSWORD has appeared in a data breach. Choose another.');
    }
  }

  if (!local && !process.env.PGSSLMODE) {
    problems.push('PGSSLMODE is required for a database on another host (use verify-full).');
  }
  return problems;
}

async function main() {
  const conn = ownerConnectionFromEnv();
  const problems = await checkSettings(conn.host);
  if (problems.length) {
    for (const p of problems) console.error(`  - ${p}`);
    throw new Error('Nothing was changed.');
  }

  const owner = new pg.Client({
    host: conn.host, port: conn.port, user: conn.user,
    password: conn.password, database: conn.database, ssl: sslSetting(),
  });
  await owner.connect();
  try {
    const existing = await owner.query(`SELECT to_regclass('public.app_user') AS t`);
    if (existing.rows[0].t) {
      throw new Error(`${conn.database} on ${conn.host} already holds the schema. Nothing was changed.`);
    }

    // Azure refuses CREATE EXTENSION for anything not on this list, which would
    // otherwise surface as a failure on line 8 of 01_schema.sql.
    const allowed = (await owner.query(`SELECT current_setting('azure.extensions', true) AS v`)).rows[0].v;
    if (allowed !== null) {
      const list = String(allowed).toLowerCase().split(',').map((s) => s.trim());
      const missing = EXTENSIONS.filter((e) => !list.includes(e));
      if (missing.length) {
        throw new Error(
          `Allow ${missing.join(', ').toUpperCase()} in the server parameter azure.extensions first. Nothing was changed.`,
        );
      }
    }

    // Created here, before 02_security.sql, so the roles never exist with the
    // published password; 02 then finds them and leaves them alone. Hosts such
    // as Neon refuse to create a role with a weak password at all.
    const created = new Set<string>();
    for (const { role, env } of ROLES) {
      const value = process.env[env];
      if (!value) continue;
      const exists = await owner.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [role]);
      if (exists.rowCount) continue;
      await owner.query(
        `CREATE ROLE ${owner.escapeIdentifier(role)} LOGIN PASSWORD ${owner.escapeLiteral(value)}`);
      created.add(role);
      console.log(`Created ${role}.`);
    }

    for (const file of FILES) {
      process.stdout.write(`Applying ${file} ... `);
      try {
        await owner.query(readFileSync(path.join(DB_DIR, file), 'utf8'));
      } catch (e) {
        console.log('failed');
        throw new Error(`${file}: ${e instanceof Error ? e.message : e}`);
      }
      console.log('done');
    }

    await owner.query(`
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rasibe_app;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rasibe_app;
      REVOKE UPDATE, DELETE ON audit_entry FROM rasibe_app;
    `);

    for (const { role, env } of ROLES) {
      const value = process.env[env];
      if (!value || created.has(role)) continue;
      await owner.query(`ALTER ROLE ${owner.escapeIdentifier(role)} PASSWORD ${owner.escapeLiteral(value)}`);
      console.log(`Set the password for ${role}.`);
    }

    const demo = process.env.DEMO_ACCOUNT_PASSWORD;
    if (demo) {
      const users = await owner.query<{ user_id: string }>(`SELECT user_id FROM app_user`);
      for (const u of users.rows) {
        await owner.query(`UPDATE app_user SET password_hash = $1 WHERE user_id = $2`,
          [await hashPassword(demo), u.user_id]);
      }
      console.log(`Replaced the demonstration password on ${users.rowCount} accounts.`);
    }

    const fns = await owner.query<{ proname: string }>(
      `SELECT proname FROM pg_proc WHERE proname = ANY($1)`, [FUNCTIONS]);
    const missingFns = FUNCTIONS.filter((f) => !fns.rows.some((r) => r.proname === f));
    if (missingFns.length) throw new Error(`Functions missing after setup: ${missingFns.join(', ')}`);

    const noRls = await owner.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c
         JOIN pg_policy p ON p.polrelid = c.oid
        WHERE NOT c.relrowsecurity
        GROUP BY c.relname`);
    if (noRls.rows.length) {
      throw new Error(`Policies defined but row-level security is off on: ${noRls.rows.map((r) => r.relname).join(', ')}`);
    }
    console.log(`Checked ${FUNCTIONS.length} functions and row-level security.`);
  } finally {
    await owner.end();
  }

  const appPassword = process.env.RASIBE_APP_PASSWORD;
  if (appPassword) {
    const app = new pg.Client({
      host: conn.host, port: conn.port, user: 'rasibe_app',
      password: appPassword, database: conn.database, ssl: sslSetting(),
    });
    await app.connect();
    const who = await app.query(`SELECT current_user AS u`);
    await app.end();
    console.log(`Signed in as ${who.rows[0].u}.`);
  }

  console.log('\nNext: npm run encrypt-existing, as rasibe_app with the production keys.');
}

main().catch((err) => {
  console.error(`Setup failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
