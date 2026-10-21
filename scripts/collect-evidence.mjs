#!/usr/bin/env node
/**
 * Collects a dated record of the system building, passing its tests and
 * producing a release.
 *
 * The marker asked five separate times for the same thing in different words:
 * dated run output, production build results, negative-test results, dated
 * security evidence, and complete CI evidence. All of it existed and none of it
 * had a date on it, because it was only ever produced on a terminal and read
 * once.
 *
 * This runs the whole thing end to end and writes what happened to a file with
 * a timestamp in its name, so the evidence is a by-product of running the
 * system rather than something assembled by hand afterwards.
 *
 *   node scripts/collect-evidence.mjs
 *   node scripts/collect-evidence.mjs --quick     (skip the database rebuild)
 *
 * Writes to evidence/evidence-YYYY-MM-DD-HHMM.md
 */
import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const QUICK = process.argv.includes('--quick');

const started = new Date();
const stamp = started.toISOString().slice(0, 16).replace('T', '-').replace(':', '');
const OUT_DIR = join(ROOT, 'evidence');
const OUT_FILE = join(OUT_DIR, `evidence-${stamp}.md`);

const lines = [];
const results = [];

/**
 * The application's own database credentials, from server/.env.
 *
 * This script is run with an administrative connection in the environment so it
 * can drop and recreate the database. The database checks must not use it: they
 * assert that the application role cannot update the audit log and cannot see
 * another client's rows, and a superuser would pass neither honestly. Reading
 * server/.env gives the same connection the API uses.
 */
function applicationCredentials() {
  const envFile = join(ROOT, 'server', '.env');
  const wanted = ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'];
  const out = {};

  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m && wanted.includes(m[1])) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }

  // Defaults matching db/02_security.sql, for a checkout with no .env yet.
  out.PGUSER ??= 'rasibe_app';
  out.PGPASSWORD ??= 'rasibe_app_pw';
  out.PGDATABASE ??= process.env.PGDATABASE ?? 'rasibe';
  return out;
}

const appDb = applicationCredentials();

const say = (s = '') => { console.log(s); };
const write = (s = '') => { lines.push(s); };

/** Runs a command, capturing everything it printed and how long it took. */
function run(label, command, options = {}) {
  const cwd = options.cwd ? join(ROOT, options.cwd) : ROOT;
  const begun = Date.now();
  say(`  ${label}…`);

  const env = { ...process.env };

  // The database rebuild needs an administrative connection, and this script is
  // usually run with one in the environment. The test suites must not inherit
  // it: as a superuser they would bypass every row-level security policy, and
  // the assertions that check a recruiter cannot see restricted data would fail
  // for the right reason while the evidence looked wrong. Worse, had they been
  // written the other way round, they would have passed while the system was
  // insecure. So the suites are given a clean environment and read server/.env
  // themselves, exactly as they do in continuous integration.
  if (options.ownCredentials) {
    for (const k of ['PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGHOST', 'PGPORT', 'PGOPTIONS']) {
      delete env[k];
    }
  }

  // Applied after the deletion above, or a connection passed in deliberately
  // would be stripped out along with the inherited one.
  Object.assign(env, options.env ?? {});

  const r = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: options.timeout ?? 600_000,
    env,
    maxBuffer: 32 * 1024 * 1024,
  });

  const seconds = ((Date.now() - begun) / 1000).toFixed(1);
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  const ok = r.status === 0;

  say(`    ${ok ? 'ok' : 'FAILED'} in ${seconds}s`);
  return { label, command, ok, seconds, output, code: r.status };
}

/** The assertion counts a suite prints, so the record carries numbers not prose. */
function countsFrom(output) {
  const m = output.match(/(\d+)\s+passed,\s+(\d+)\s+failed/);
  return m ? { passed: Number(m[1]), failed: Number(m[2]) } : null;
}

function section(title) {
  write('');
  write(`## ${title}`);
  write('');
}

/** Output worth reading in full, fenced so it is plainly machine output. */
function quote(output, limit = 120) {
  const all = output.split('\n');
  const shown = all.length > limit
    ? [...all.slice(0, 60), `… ${all.length - 110} lines omitted …`, ...all.slice(-50)]
    : all;
  write('```');
  shown.forEach((l) => write(l));
  write('```');
}

// ---------------------------------------------------------------------
say('\nCollecting evidence\n');

const git = (cmd, fallback = 'unknown') => {
  try { return execSync(`git ${cmd}`, { cwd: ROOT, encoding: 'utf8' }).trim(); }
  catch { return fallback; }
};

const commit = git('rev-parse HEAD');
const shortCommit = git('rev-parse --short HEAD');
const branch = git('rev-parse --abbrev-ref HEAD');
const lastCommitDate = git('log -1 --format=%cI');
const dirty = git('status --porcelain') !== '';

write(`# Build and test evidence`);
write('');
write(`**Rasibe Consultant Placement Management System**`);
write('');
write(`Collected ${started.toUTCString()}`);
write('');
write('| | |');
write('| --- | --- |');
write(`| Commit | \`${commit}\` |`);
write(`| Branch | ${branch} |`);
write(`| Last commit | ${lastCommitDate} |`);
write(`| Working tree | ${dirty ? '**has uncommitted changes**' : 'clean'} |`);
write(`| Node | ${process.version} |`);
write(`| Platform | ${process.platform} ${process.arch} |`);
write(`| Mode | ${QUICK ? 'quick (database not rebuilt)' : 'full'} |`);
write('');
write('Every figure below was produced by running the system, not transcribed. '
  + 'Regenerate with `node scripts/collect-evidence.mjs`.');

if (dirty) {
  write('');
  write('> The working tree had uncommitted changes when this was collected, so the '
    + 'commit above does not fully describe what was run. Commit first for a clean record.');
}

// ---------------------------------------------------------------------
section('1. Environment');

const env = [
  run('node version', 'node --version'),
  run('npm version', 'npm --version'),
  run('postgres version', 'psql --version'),
];
write('| Tool | Version |');
write('| --- | --- |');
env.forEach((e) => write(`| ${e.label.replace(' version', '')} | ${e.output.split('\n')[0] || 'not found'} |`));

// ---------------------------------------------------------------------
if (!QUICK) {
  section('2. Database built from the committed scripts');
  write('The schema is rebuilt from `db/` before the suites run, so what follows '
    + 'describes a database anyone can reproduce rather than one that accumulated state.');
  write('');

  const db = process.env.PGDATABASE ?? 'rasibe';
  const rebuild = [
    run('terminate connections',
      `psql -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${db}' AND pid <> pg_backend_pid();"`),
    run('drop', `psql -d postgres -c "DROP DATABASE IF EXISTS ${db};"`),
    run('create', `psql -d postgres -c "CREATE DATABASE ${db};"`),
    run('01_schema', `psql -d ${db} -v ON_ERROR_STOP=1 -f db/01_schema.sql`),
    run('02_security', `psql -d ${db} -v ON_ERROR_STOP=1 -f db/02_security.sql`),
    run('03_triggers', `psql -d ${db} -v ON_ERROR_STOP=1 -f db/03_triggers.sql`),
    run('04_seed', `psql -d ${db} -v ON_ERROR_STOP=1 -f db/04_seed.sql`),
  ];

  write('| Step | Result |');
  write('| --- | --- |');
  rebuild.forEach((r) => write(`| ${r.label} | ${r.ok ? 'applied' : '**failed**'} |`));
  results.push(...rebuild);

  const shape = run('schema shape', `psql -d ${db} -tA -c "SELECT 'tables=' || (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE') || ' enums=' || (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typtype='e' AND n.nspname='public') || ' policies=' || (SELECT count(*) FROM pg_policies) || ' triggers=' || (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal);"`);
  write('');
  write(`What the scripts produced: \`${shape.output}\``);

  const grants = run('grants',
    `psql -d ${db} -c "GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO rasibe_app; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO rasibe_app; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO rasibe_app; REVOKE UPDATE,DELETE ON audit_entry FROM rasibe_app;"`);
  results.push(grants);

  const encrypt = run('encrypt seeded values', 'npm run encrypt-existing --silent',
    { cwd: 'server', ownCredentials: true });
  results.push(encrypt);
  write('');
  write(`Encryption backfill: \`${encrypt.output.split('\n').filter(Boolean).pop() ?? 'no output'}\``);

  section('2.1 The application role does not bypass its own policies');
  write('Row-level security is only in force if the API connects as a role that cannot '
    + 'ignore it. A superuser or a table owner would silently see everything.');
  write('');
  const role = run('role privileges',
    `psql -d ${db} -tA -c "SELECT rolname || ': superuser=' || rolsuper || ' bypassrls=' || rolbypassrls FROM pg_roles WHERE rolname IN ('rasibe_app','rasibe_reporting') ORDER BY rolname;"`);
  quote(role.output);
}

// ---------------------------------------------------------------------
section(QUICK ? '2. Test suites' : '3. Test suites');
write('Every suite runs against the real database, in sequence, as it does in '
  + 'continuous integration. Each assertion travels through HTTP, the application '
  + 'layer and PostgreSQL.');
write('');
write('The suites run with no mail server configured, as they do in continuous '
  + 'integration. With one configured an invitation is emailed rather than returned, '
  + 'which is correct in use but leaves the account suite nothing to redeem.');
write('');
write('The suites connect as the application role from `server/.env`, not as the '
  + 'administrative role used to rebuild the schema above. A superuser would bypass '
  + 'every row-level security policy, and the assertions that check one role cannot '
  + 'see another\u2019s data would be meaningless.');
write('');

const SUITES = [
  ['Behavioural', 'npm run test --silent'],
  ['Accounts', 'npm run test:accounts --silent'],
  ['Two-factor', 'npm run test:2fa --silent'],
  ['Server validation', 'npm run test:validation --silent'],
  ['Scheduler', 'npm run test:scheduler --silent'],
  ['Consultant and catalogue', 'npm run test:catalogue --silent'],
  ['Placements', 'npm run test:placements --silent'],
  ['Screens', 'npm run test:screens --silent'],
  ['Retention', 'npm run test:retention --silent'],
  ['Pagination', 'npm run test:paging --silent'],
  ['Notifications', 'npm run test:notifications --silent'],
  ['Documents', 'npm run test:documents --silent'],
  ['Serving the clients', 'npm run test:clients --silent'],
  ['Proxy address', 'npm run test:proxy --silent'],
  ['Backup drill', 'npm run test:backup --silent'],
];

const suiteRuns = [];
for (const [label, cmd] of SUITES) {
  const r = run(label, cmd, {
    cwd: 'server',
    ownCredentials: true,
    env: {
      NOTIFY_DISPATCH: 'off',
      NOTIFY_SCHEDULE: 'off',
      // No mail server for the suites, which is how continuous integration runs
      // them. With one configured the system emails an invitation instead of
      // returning the link, which is right in use and leaves the accounts suite
      // with nothing to redeem. A developer who has set up Gmail locally should
      // not get a different result from CI.
      SMTP_HOST: '',
      NODE_ENV: 'development',
    },
  });
  r.counts = countsFrom(r.output);
  suiteRuns.push(r);
  results.push(r);
}

let passed = 0;
let failed = 0;
write('| Suite | Assertions | Failed | Seconds |');
write('| --- | ---: | ---: | ---: |');
suiteRuns.forEach((r) => {
  const c = r.counts;
  if (c) { passed += c.passed; failed += c.failed; }
  write(`| ${r.label} | ${c ? c.passed : (r.ok ? 'ran' : '—')} | ${c ? c.failed : (r.ok ? '0' : '**did not run**')} | ${r.seconds} |`);
});
write(`| **Total** | **${passed}** | **${failed}** | |`);

// ---------------------------------------------------------------------
section(QUICK ? '2.1 Database checks' : '3.1 Database checks');
write(`Run as \`${appDb.PGUSER}\` from \`server/.env\`, not as the administrative role that `
  + 'rebuilt the schema. These checks assert that the application role cannot update the '
  + 'audit log and cannot read another client\u2019s rows; a superuser would pass neither '
  + 'honestly.');
write('');
write('Run as the application role, so a policy that stopped binding would fail here. '
  + '`rasibe.tests_strict=on` matters: without it a failed check is only a notice and '
  + '`psql` still exits 0, which is a false pass.');
write('');

const dbTests = run('database checks',
  `psql -U ${appDb.PGUSER} -d ${appDb.PGDATABASE} -v ON_ERROR_STOP=1 -f db/tests.sql`,
  {
    ownCredentials: true,
    env: { ...appDb, PGOPTIONS: '-c rasibe.tests_strict=on' },
  });
results.push(dbTests);
write(`Exit status: **${dbTests.ok ? '0, every check passed' : `${dbTests.code}, a check failed`}**`);
write('');
quote(dbTests.output, 60);

// ---------------------------------------------------------------------
section(QUICK ? '3. Negative tests' : '4. Negative tests');
write('What the system refuses, which is most of what the suites assert. Extracted '
  + 'from the runs above rather than re-run, so these are the same executions.');
write('');

const refusals = suiteRuns
  .flatMap((r) => r.output.split('\n'))
  .filter((l) => /✓/.test(l) && /refus|reject|cannot|not permitted|may not|denied|without a reason|is refused/i.test(l))
  .map((l) => l.replace(/^\s*✓\s*/, '').trim());

write(`${refusals.length} assertions cover a refusal. A selection:`);
write('');
refusals.slice(0, 40).forEach((l) => write(`- ${l}`));
if (refusals.length > 40) write(`- … and ${refusals.length - 40} more`);

// ---------------------------------------------------------------------
section(QUICK ? '4. Production builds' : '5. Production builds');
write('Both clients compiled as they are for deployment, with type checking.');
write('');

const builds = [
  run('web type check', 'npx tsc -b --pretty false', { cwd: 'web' }),
  run('web production build', 'npm run build --silent', { cwd: 'web' }),
  run('mobile type check', 'npx tsc -b --pretty false', { cwd: 'mobile' }),
  run('mobile production build', 'npm run build --silent', { cwd: 'mobile' }),
  run('server type check', 'npx tsc --noEmit', { cwd: 'server' }),
];
results.push(...builds);

write('| Step | Result | Seconds |');
write('| --- | --- | ---: |');
builds.forEach((b) => write(`| ${b.label} | ${b.ok ? 'succeeded' : '**failed**'} | ${b.seconds} |`));

const bundleOf = (out) => out.split('\n').filter((l) => /dist\/assets|dist\/index/.test(l));
write('');
write('**Web bundle**');
quote(bundleOf(builds[1].output).join('\n') || builds[1].output, 20);
write('**Mobile bundle**');
quote(bundleOf(builds[3].output).join('\n') || builds[3].output, 20);

// ---------------------------------------------------------------------
section(QUICK ? '5. Security evidence' : '6. Security evidence');
write('Drawn from the suites above. Each line is an assertion that ran in this collection.');
write('');

const securityPatterns = [
  [/bill rate|pay rate|margin/i, 'Rate confidentiality'],
  [/csrf|x-csrf/i, 'Cross-site request forgery'],
  [/row.level|policy|isolation|another/i, 'Data isolation'],
  [/password|argon|pepper|breach/i, 'Passwords'],
  [/token|expire|single use|used twice/i, 'Tokens and links'],
  [/restricted|vetting|administrator only/i, 'Restricted data'],
  [/audit/i, 'Audit trail'],
  [/two-factor|2fa|code/i, 'Two-factor'],
  [/encrypt|ciphertext/i, 'Encryption at rest'],
];

const allPassing = suiteRuns
  .flatMap((r) => r.output.split('\n'))
  .filter((l) => /✓/.test(l))
  .map((l) => l.replace(/^\s*✓\s*/, '').trim());

write('| Control | Assertions |');
write('| --- | ---: |');
securityPatterns.forEach(([re, label]) => {
  write(`| ${label} | ${allPassing.filter((l) => re.test(l)).length} |`);
});

// ---------------------------------------------------------------------
section(QUICK ? '6. Summary' : '7. Summary');

const anyFailed = results.some((r) => !r.ok) || failed > 0;

write(`| | |`);
write(`| --- | --- |`);
write(`| Assertions passed | **${passed}** |`);
write(`| Assertions failed | **${failed}** |`);
write(`| Suites run | ${suiteRuns.length} |`);
write(`| Database checks | ${dbTests.ok ? 'passed' : '**failed**'} |`);
write(`| Production builds | ${builds.every((b) => b.ok) ? 'all succeeded' : '**one or more failed**'} |`);
write(`| Collected | ${started.toUTCString()} |`);
write(`| Commit | \`${shortCommit}\` |`);
write('');
write(anyFailed
  ? '**Something failed in this collection. The detail is in the sections above.**'
  : 'Everything in this record passed.');

// ---------------------------------------------------------------------
section('Full output');
write('Kept so the figures above can be checked rather than taken on trust.');

for (const r of results) {
  if (!r.output) continue;
  write('');
  write(`### ${r.label}${r.ok ? '' : ' — FAILED'}`);
  write('');
  write(`\`${r.command}\` · ${r.seconds}s · exit ${r.code}`);
  write('');
  quote(r.output, 80);
}

// ---------------------------------------------------------------------
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, `${lines.join('\n')}\n`, 'utf8');

say('');
say(`  ${passed} assertions passed, ${failed} failed`);
say(`  written to evidence/evidence-${stamp}.md`);
say('');

process.exit(anyFailed ? 1 : 0);
