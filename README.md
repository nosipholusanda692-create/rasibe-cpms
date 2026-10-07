# Rasibe Consultant Placement Management System

A working implementation of the system specified in the Rasibe Global Solutions
system analysis and design documentation.

Rasibe places IT consultants with client companies and earns the margin between
the rate it bills the client and the rate it pays the consultant. This system
manages that cycle end to end: a searchable consultant pool, role requests
raised by clients, submissions with recorded consent, placements with fixed
rates, weekly timesheets that can be captured without connectivity, client
approval, and invoices raised only from approved hours.

---

## What is in this repository

```
rasibe/
├── db/                     PostgreSQL schema, security, triggers and seed data
│   ├── 01_schema.sql       27 tables, 17 enumerated types, keys and constraints
│   ├── 02_security.sql     database roles, row-level security, projection views
│   ├── 03_triggers.sql     the five state machines and the financial invariants
│   ├── 04_seed.sql         reference data and a demonstration data set
│   ├── tests.sql           36 checks over the policies, triggers and invariants
│   └── SCHEMA-DIFF.md      why db/ is the live schema, and how it differs from design
├── server/                 Node, Express and TypeScript API
│   └── src/
│       ├── index.ts        application wiring, security headers, error translation
│       ├── lib/            database access, errors, field-level projection,
│       │                   encryption at rest, CSRF tokens, TLS, redacted logging
│       ├── middleware/     session authentication and role guards
│       ├── routes/         the twelve route modules
│       ├── services/       notification queue and audit log
│       ├── scripts/        one-off tools: backfill encryption, measure sign-in timing
│       └── test/           integration and end-to-end suites
├── web/                    React, Vite and TypeScript client
│   └── src/
│       ├── App.tsx         routing, navigation and sign in
│       ├── lib.tsx         API client, auth context, shared components
│       ├── styles.css      design tokens taken from the approved prototype
│       └── pages/          one module per screen
├── docs/                   how each security control works, and what it does not cover
├── scripts/                development certificate generation
├── .github/workflows/      the six checks that run on every pull request
├── .gitleaks.toml          secret scanning configuration
└── README.md
```

---

## Requirements

| Component | Version |
| --- | --- |
| Node.js | 20 or later (built and tested on 22) |
| PostgreSQL | 16 or later |
| npm | 10 or later |

PostgreSQL 16 is required rather than preferred. The system relies on
`EXCLUDE USING gist` for the overlapping placement rule, row-level security for
data isolation, `security_invoker` views for column projection, and the
`pgcrypto`, `btree_gist` and `pg_trgm` extensions.

---

## Setting up

Windows instructions are below the Linux and macOS ones. Note that PowerShell
does not accept `&&` as a statement separator, so run the commands one line at
a time or use the supplied script.

### Windows (PowerShell)

From the `db` folder:

```powershell
.\apply.ps1
```

The script checks that PostgreSQL is on your PATH, offers to add it if it finds
an installation, asks once for the `postgres` password, creates the database,
applies all four scripts in order and reports what it built. Use `-Recreate` to
drop and rebuild.

If you would rather do it by hand, run these one line at a time:

```powershell
$env:Path += ";C:\Program Files\PostgreSQL\16\bin"   # if psql is not on your PATH
createdb -U postgres rasibe
cd db
psql -U postgres -d rasibe -v ON_ERROR_STOP=1 -f 01_schema.sql
psql -U postgres -d rasibe -v ON_ERROR_STOP=1 -f 02_security.sql
psql -U postgres -d rasibe -v ON_ERROR_STOP=1 -f 03_triggers.sql
psql -U postgres -d rasibe -v ON_ERROR_STOP=1 -f 04_seed.sql
```

Then start the two applications in separate terminals:

```powershell
cd server
Copy-Item .env.example .env
npm install
npm run dev
```

```powershell
cd web
npm install
npm run dev
```

### Linux and macOS

### 1. Create the database

```bash
createdb rasibe
```

### 2. Apply the scripts, in order

```bash
cd db
psql -d rasibe -v ON_ERROR_STOP=1 -f 01_schema.sql
psql -d rasibe -v ON_ERROR_STOP=1 -f 02_security.sql
psql -d rasibe -v ON_ERROR_STOP=1 -f 03_triggers.sql
psql -d rasibe -v ON_ERROR_STOP=1 -f 04_seed.sql
```

`02_security.sql` creates two database roles. Change the passwords before using
this anywhere other than a development machine:

| Role | Purpose |
| --- | --- |
| `rasibe_app` | The API connects as this. Read and write on the tables, no update or delete on the audit log. |
| `rasibe_reporting` | No privilege on base tables. Reads the report views only. |

Grant the application role access to the seeded objects:

```bash
psql -d rasibe -c "GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO rasibe_app;
                   GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO rasibe_app;
                   REVOKE UPDATE,DELETE ON audit_entry FROM rasibe_app;"
```

### 3. Start the API

```bash
cd server
cp .env.example .env      # then edit if your database is not on localhost:5432
npm install
npm run dev               # http://localhost:4000
```

Check it: `curl http://localhost:4000/api/health` should return
`{"status":"ok","database":"connected"}`.

### 4. Start the web client

```bash
cd web
npm install
npm run dev               # http://localhost:5173
```

Vite proxies `/api` to the API on port 4000, so the session cookie is
same-origin and needs no further configuration.

---

## Test accounts

Every account uses the password `Password123!`.

| Role | Email | Lands on |
| --- | --- | --- |
| Administrator | `christinah@rasibe.co.za` | Dashboard, including margin |
| Recruiter | `nosipho@rasibe.co.za` | Role requests |
| Consultant | `thabo.m@example.co.za` | My timesheets |
| Client manager | `s.naidoo@nedgroupit.co.za` | Timesheet approvals |

The sign-in screen lists these; click a row to fill the form in.

---

## Running the tests

```bash
cd server
npm test                  # 149 integration assertions
npx tsx src/test/e2e.ts   # 19 assertions over the screens the web client loads
```

```bash
psql -U rasibe_app -d rasibe -v ON_ERROR_STOP=1 -f db/tests.sql   # 36 database checks
```

All three run against the real database rather than against mocks. Every
assertion goes through HTTP, the application layer and PostgreSQL, so a
constraint or trigger that stopped working would fail the suite.

The integration suite writes data and does not roll back. Re-apply `01` through
`04` against a freshly created database before each run, or point it at a
throwaway container; re-running it against a database it has already written to
produces failures that look real but are not.

`db/tests.sql` needs `PGOPTIONS=-c rasibe.tests_strict=on`. Without it a failed
check is only a `NOTICE` and `psql` still exits 0, which is a false pass.

---

## Continuous integration

Six checks run on every pull request and on every push to `main`. `docs/CI.md`
explains what each one is for and, just as importantly, what none of them
covers.

They are not yet enforced. `main` has no branch protection rule, so a pull
request can be merged with a check failing and a commit can be pushed to `main`
without going through one at all. The checks are a convention the two of us
follow rather than something the repository guarantees.

| Check | What it would catch |
| --- | --- |
| Server CI | A regression in any of the 149 behavioural assertions |
| Database tests | A row-level security policy or trigger that stopped holding |
| Secret scan | A credential committed to the repository |
| Dependency audit (server) | A known flaw in something the API ships |
| Dependency audit (web) | A known flaw in something the client ships |
| Web CI | A front end that no longer compiles for production |

The dependency audit blocks on high and critical advisories in production
dependencies only. Development-only findings are reported but do not fail the
build, because a flaw in a bundler runs on the CI runner rather than reaching a
user, and a check that goes red for things nobody can act on is a check
everybody learns to ignore.

---

## How the important rules are enforced

The business rules live in the database, not only in application code, so they
hold even against a direct SQL statement.

| Rule | Where it lives |
| --- | --- |
| BR-001 no overlapping full-time placements | `EXCLUDE USING gist` on `placement` |
| BR-002 a timesheet needs an active placement | `trg_timesheet_active_placement` |
| BR-003 only approved hours may be invoiced | `trg_invoice_line_requires_approval` |
| BR-004 no future-dated hours | application guard plus `ck_day_total` |
| BR-005 a rejection needs a reason | `ck_reject_reason`, minimum five characters |
| BR-006 and BR-007 rate confidentiality | row-level security, projection views, server-side field stripping |
| BR-008 rates snapshotted at submission | `fn_timesheet_status_transition` |
| BR-009 a rate change needs approval | `fn_placement_status_transition` |
| BR-010 invoice number allocated at issue | `fn_invoice_status_transition` |
| BR-011 an issued invoice is immutable | `fn_invoice_status_transition` |
| BR-012 consent before disclosure | `trg_submission_consent` |
| BR-013 client data isolation | row-level security policies |
| BR-016 daily hour ceiling | `fn_timesheet_recalc` |
| BR-018 no editing a submitted week | `fn_timesheet_status_transition` |
| BR-019 server wins on sync conflict | `client_uuid` and `row_version` on `timesheet` |
| BR-020 append-only audit log | `REVOKE UPDATE, DELETE ON audit_entry` |
| BR-022 no duplicate submission | `uq_submission` |

### Rate confidentiality

The defining requirement. A consultant must never see the bill rate or the
margin; a client manager must never see the pay rate or the margin. This is
enforced in three places rather than one:

1. **Row-level security** decides which rows a session may read at all.
2. **`security_invoker` views** omit the restricted columns from the query.
3. **`project()` in `lib/errors.ts`** strips restricted keys on the server
   before the response is serialised.

The restricted values are therefore never transmitted. They cannot be recovered
from network traffic, a browser console, or a modified client.

### Offline timesheet capture

A consultant working on client premises frequently has no signal. The mobile
capture screen holds the week in `localStorage` against a `clientUuid` generated
on the device before any connectivity exists. On reconnection the browser sends
the queue to `POST /api/timesheets/sync`, which returns one of three outcomes:

| Outcome | Meaning |
| --- | --- |
| `accepted` | The week was written. |
| `already_accepted` | The token had already been processed. Nothing is created, so a repeated transmission is harmless. |
| `conflict` | The server row has moved on. The server version stands, the local copy is retained, and the consultant is told. |

The failure mode of an unreliable connection is a repeated request, not a lost
one, which is why the operation is idempotent.

---

## API reference

All routes are under `/api`. Authentication is a `httpOnly` session cookie.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/auth/login` | Sign in |
| POST | `/auth/logout` | Sign out and revoke the session |
| GET | `/auth/me` | Current user, role, capabilities, landing page |
| POST | `/auth/change-password` | Change password, revoking other sessions |
| GET | `/consultants` | Search the pool |
| GET | `/consultants/:id` | Full profile, projected by role |
| POST | `/consultants` | Add to the pool |
| PATCH | `/consultants/:id` | Amend; a consultant may amend only their own |
| POST | `/consultants/:id/consent` | Record consent to disclosure |
| PUT | `/consultants/:id/skills` | Replace the skill set |
| GET | `/clients` | Client companies |
| POST | `/clients` | Add a client |
| POST | `/clients/:id/contacts` | Add a contact |
| GET | `/requests` | Role requests |
| POST | `/requests` | Raise a request |
| GET | `/requests/:id/matches` | Matching consultants |
| GET/POST | `/requests/:id/submissions` | Submissions against a request |
| PATCH | `/requests/submissions/:sid` | Record an outcome |
| GET/POST | `/placements` | Placements |
| POST | `/placements/:id/approve-rates` | Approve the rates and activate |
| PATCH | `/placements/:id/rates` | Change rates; returns for approval |
| POST | `/placements/:id/terminate` | End early, with a reason |
| GET | `/timesheets` | Timesheets, filtered |
| GET | `/timesheets/my/current` | The consultant's current week |
| PUT | `/timesheets/:id/lines` | Save the days |
| POST | `/timesheets/:id/submit` | Submit for approval |
| POST | `/timesheets/:id/decision` | Approve or reject |
| POST | `/timesheets/:id/override` | Administrator override |
| POST | `/timesheets/sync` | Offline synchronisation |
| POST | `/invoices/prepare` | Draft from approved hours |
| POST | `/invoices/:id/approve` | Approve a draft |
| POST | `/invoices/:id/issue` | Issue, allocating the number |
| POST | `/invoices/:id/credit-note` | Credit an issued invoice |
| POST | `/invoices/:id/export` | Spreadsheet export for the bookkeeper |
| GET | `/dashboard` | Dashboard figures for the current role |
| GET | `/reports/*` | Margin, utilisation, outstanding, ageing, audit |
| GET | `/notifications` | The current user's notifications |
| GET/PUT | `/settings` | System configuration |

---

## Configuration

Everything in `system_setting` is changed by an administrator through the
Settings screen without a deployment: the timesheet cycle, reminder and
escalation intervals, the placement alert thresholds, the daily hour ceiling,
retention periods, company details and invoice numbering.

### Environment variables

`server/.env.example` is the authoritative list and explains each one in place.
Every security variable is optional in development and the system runs with
none of them set, which is deliberate: a fresh clone and the test suite work
with no setup.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | localhost:5432 | Database connection |
| `PORT` | 4000 | API port |
| `NODE_ENV` | development | `production` hides internal error detail and makes the keys below mandatory |
| `SESSION_TTL_HOURS` | 8 | Session lifetime |
| `CORS_ORIGIN` | http://localhost:5173 | Permitted browser origin |
| `SMTP_HOST` and related | empty | Email delivery, see below |

Security settings. Each is covered by a document in `docs/`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATA_ENCRYPTION_KEY` | derived | Encrypts identity, banking and vetting values. **Losing it loses that data** |
| `DATA_INDEX_KEY` | derived | Derives the fingerprint that keeps the identity number unique |
| `CSRF_SECRET` | random at boot | Signs the token protecting state-changing requests |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | unset | Serve HTTPS from this process. Leave unset where a proxy terminates TLS |
| `FORCE_HTTPS` | unset | Redirect plain HTTP to HTTPS with a 308 |
| `PUBLIC_HOST` | unset | The host that redirect points at. **Required** when `FORCE_HTTPS` is on; startup refuses without it |
| `TRUST_PROXY` | unset | Hop count or address list. Only when a proxy really is in front |
| `PGSSLMODE`, `PGSSLROOTCERT` | disable | Encrypt the database connection. Hosted PostgreSQL needs at least `require` |

Two of these have consequences worth stating plainly. With `NODE_ENV=production`
the server **refuses to start** without `DATA_ENCRYPTION_KEY`, because the
alternative is silently writing restricted data in clear. And the encryption key
has to be backed up alongside the database but never inside it: a backup of the
database without that key restores nothing readable.

---

## Troubleshooting

**`The token '&&' is not a valid statement separator`** — you are in Windows
PowerShell, which does not accept `&&`. Run each command on its own line, or use
`db\apply.ps1`.

**`createdb: command not found` or `psql is not recognised`** — PostgreSQL is
not on your PATH. On Windows:

```powershell
$env:Path += ";C:\Program Files\PostgreSQL\16\bin"
```

Check with `Get-Command psql`. If PostgreSQL is not installed, get version 16 or
later; earlier versions lack facilities this system depends on.

**`password authentication failed for user "rasibe_app"`** — `02_security.sql`
creates that role with the password `rasibe_app_pw`. Either keep that in
`server/.env` for development, or change both the role and the file:

```sql
ALTER ROLE rasibe_app WITH PASSWORD 'your-password';
```

**`relation "app_user" does not exist`** — the scripts did not all apply. Drop
the database and run them again in order; `01_schema.sql` must succeed before
the others will.

**`permission denied for table ...`** — the grants at the end of the setup did
not run. Apply them:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rasibe_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rasibe_app;
REVOKE UPDATE, DELETE ON audit_entry FROM rasibe_app;
```

**The web client shows "Could not load"** — the API is not running or is on
another port. Check `http://localhost:4000/api/health` returns
`{"status":"ok","database":"connected"}`.

**Port already in use** — change `PORT` in `server/.env`, and the proxy target
in `web/vite.config.ts` to match.

---

## Limitations and external configuration

These are stated plainly rather than left to be discovered.

**Email is queued, not delivered.** Notifications are written to the
`notification` table inside the same transaction as the business change, which
satisfies the requirement that a delivery failure must never roll back a
booking. With no `SMTP_HOST` configured the row is the delivery, and
notifications appear in the application rather than in an inbox. Connecting a
provider is external configuration on your side.

**Documents are recorded, not stored.** The `document` table holds metadata,
type, version, expiry and restriction. File upload to object storage is not
implemented; the architecture specifies object storage with a path reference,
which needs a bucket and credentials.

**No mobile application.** The documentation specifies a mobile client. Only the
web client is built. The offline capture mechanism it would use is implemented
and tested, and the timesheet screen already works on a phone-sized viewport.

**The POPIA purge job is not scheduled.** `data_retention_rule` holds the
periods and `retention_expires_on` is set on every consultant, but the nightly
anonymisation job shown in the activity diagram is not implemented.

**Scheduled notifications are not dispatched.** Timesheet reminders and the
60/30/14 day placement alerts have templates and the data to raise them, but no
scheduler runs. A cron job calling a dispatch endpoint would complete this.

**VAT is configured off.** The client confirmed the business is not currently
registered. The schema, the invoice calculation and the settings all support VAT
being switched on later without redevelopment.

---

## Design decisions worth knowing

**Roles are data, not subclasses.** A user holds `user_role` records carrying
`role_capability` entries, so permissions change without a schema change.

**Rates are snapshotted twice.** Once onto the placement at creation, once onto
the timesheet at submission. A rate agreed in March cannot alter a February week
that has already been approved and invoiced.

**Invoice numbers are allocated at issue, not at draft.** A discarded draft
consumes no number, so the sequence has no gaps to explain to an auditor.

**Availability is derived from placement records**, not maintained by hand, so
the flag cannot drift from reality.

**Authorisation is a distinct concern**, applied as projection before
serialisation rather than distributed through the controllers. One place to get
right, one place to test.
