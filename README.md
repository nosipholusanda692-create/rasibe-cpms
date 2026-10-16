# Rasibe Consultant Placement Management System

An implementation of the system specified in the Rasibe Global Solutions system
analysis and design documentation.

Rasibe places IT consultants with client companies and earns the margin between
the rate it bills the client and the rate it pays the consultant. This system
manages that cycle end to end: a searchable consultant pool, role requests
raised by clients, submissions with recorded consent, placements with fixed
rates, weekly timesheets that can be captured without connectivity, client
approval, and invoices raised only from approved hours.

---

## Live system

**https://rasibe-a5c7hfh3f2bydwgs.westeurope-01.azurewebsites.net/signin**

Azure App Service serves the API and both clients from one origin over HTTPS,
against a Neon PostgreSQL database. `docs/DEPLOY.md` covers how it is built.

### Signing in

| Role | Email | Lands on |
| --- | --- | --- |
| Administrator | `christinah@rasibe.co.za` | Dashboard, including margin |
| Recruiter | `nosipho@rasibe.co.za` | Role requests |
| Consultant | `thabo.m@example.co.za` | My timesheets |
| Client manager | `s.naidoo@nedgroupit.co.za` | Timesheet approvals |

The password for the deployed instance is supplied with the submission rather
than committed here. For a local database it is set in `db/04_seed.sql`, and
`npm run db:setup` asks for one instead so a deployed database never carries a
published value.

The sign-in pages do not list these accounts. They did during development, and
that was wrong: anyone reaching the page could have signed in as an
administrator and read margin figures.

### Worth doing in this order

Signing in as each role in turn demonstrates the requirement the system is built
around. The administrator sees a margin figure on the dashboard; the recruiter
does not. The consultant sees a pay rate on their placement; the client manager
sees a bill rate on the same placement. Neither sees the margin.

Those values are absent from the server response rather than hidden in the page,
so they cannot be recovered from the browser developer tools or from network
traffic.

---

## What the system does today

`docs/SECURITY-CONTROLS.md` has one row for every security, privacy and
reliability requirement, with its status and how it is checked.

| Area | What works | Main interface |
| --- | --- | --- |
| Sign-in and accounts | Invitation and reset links instead of passwords being shared, lockout after five failures, a 30-minute idle timeout, optional two-factor (authenticator app and recovery codes), suspension and role change | Web and mobile |
| Consultant pool | Search, add, amend, record consent to disclosure, deactivate with a recorded reason, skills with proficiency | Web |
| Skills taxonomy | Add, rename, recategorise, retire and restore | Web |
| Clients and role requests | Client companies and contacts, requests raised and tracked, matching consultants, submissions and their outcomes | Web |
| Placements | Created with fixed rates, rate approval, rate changes returned for approval, **extended with the original end date kept**, ended early with a reason | Web (extend: server only for now) |
| Timesheets | Weekly capture on the phone, offline with safe resubmission, approval or rejection by the client, administrator override | Mobile and web |
| Invoicing | Drafted only from approved hours, approved, issued with a number, credit notes, payments, spreadsheet export | Web |
| Reporting | Margin, utilisation, outstanding timesheets, ageing, placements ending, audit log | Web |
| Notifications | Written in the same transaction as the change, sent afterwards by email with retries | Mobile (list), email |
| Privacy | Identity, banking and vetting values encrypted at rest; **unplaced candidates anonymised after the retention period, and anyone anonymised on request**, with the financial record kept | Server only for now |
| Security | Rate confidentiality enforced in the database, row-level security, CSRF protection, input validation, append-only audit, backup and restore that is tested end to end (not yet scheduled) | All |
| Hosting | One Azure App Service serving the API and both clients over HTTPS, against Neon PostgreSQL | |

---

## What is in this repository

```
rasibe/
├── db/                     PostgreSQL schema, security, triggers and seed data
│   ├── 01_schema.sql       31 tables, 18 enumerated types, keys and constraints
│   ├── 02_security.sql     database roles, row-level security, projection views
│   ├── 03_triggers.sql     the five state machines and the financial invariants
│   ├── 04_seed.sql         reference data and a demonstration data set
│   ├── migrations-*.sql    schema changes since the baseline, applied in order
│   ├── tests.sql           38 checks over the policies, triggers and invariants
│   ├── apply.ps1 / .sh     builds a database from the files above
│   └── SCHEMA-DIFF.md      why db/ is the live schema, and how it differs from design
├── server/                 Node, Express and TypeScript API
│   └── src/
│       ├── index.ts        application wiring, security headers, error translation
│       ├── lib/            database access, errors, field projection, encryption,
│       │                   CSRF tokens, paging, TLS, redacted logging
│       ├── middleware/     session authentication and role guards
│       ├── routes/         eleven route modules
│       ├── services/       notification queue, email dispatch, audit log
│       ├── scripts/        encryption backfill, backup and restore, mail tools
│       └── test/           twelve suites, each against a real database
├── web/                    Client for the administrator, recruiter and client manager
├── mobile/                 Installable progressive web application
├── docs/                   One document per control, and what each does not cover
├── scripts/                Development certificate generation
└── .github/workflows/      The checks that run on every pull request
```

### Two clients, one API

| Client | Users | Purpose |
| --- | --- | --- |
| `web/` | Administrator, Recruiter, Client Manager | Consultant pool, clients, requests, placements, invoicing, reporting, configuration |
| `mobile/` | Consultant, Client Manager | Capture hours on site, approve them in two taps |

The mobile client is not a narrowed copy of the web one. It carries five screens,
because a consultant standing in a client building and a recruiter at a desk are
doing different jobs. It installs to a phone home screen and works without a
signal. `mobile/README.md` explains the choice in full.

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

### Windows (PowerShell)

PowerShell does not accept `&&` as a statement separator, so run commands one at
a time or use the script.

```powershell
cd db
.\apply.ps1
```

It finds PostgreSQL, creates the database, applies the baseline files and every
migration in order, and reports what it built. Use `-Recreate` to start again.

If PowerShell refuses to run it:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

### Linux and macOS

```bash
createdb rasibe
cd db
./apply.sh
```

### By hand

```bash
cd db
psql -d rasibe -v ON_ERROR_STOP=1 -f 01_schema.sql
psql -d rasibe -v ON_ERROR_STOP=1 -f 02_security.sql
psql -d rasibe -v ON_ERROR_STOP=1 -f 03_triggers.sql
psql -d rasibe -v ON_ERROR_STOP=1 -f 04_seed.sql
```

Then every `migrations-*.sql` in numbered order, then:

```bash
psql -d rasibe -c "GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO rasibe_app;
                   GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO rasibe_app;
                   GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO rasibe_app;
                   REVOKE UPDATE,DELETE ON audit_entry FROM rasibe_app;"
```

On Windows, set `$env:PGCLIENTENCODING = "UTF8"` before applying the seed. The
file is UTF-8; some console configurations read it as Latin-1 and the demonstration
text arrives with mangled punctuation.

### The two database roles

`02_security.sql` creates both:

| Role | Purpose |
| --- | --- |
| `rasibe_app` | The API connects as this. Read and write on the tables, no update or delete on the audit log. |
| `rasibe_reporting` | No privilege on base tables. Reads the report views only. |

**The API must not connect as the database owner.** An owner bypasses its own
row-level security, so every isolation policy would be silently inert and nothing
would error. Change both passwords before using this anywhere but a development
machine.

### Running it

Three terminals.

```bash
cd server
cp .env.example .env     # edit if the database is not on localhost:5432
npm install
npm run encrypt-existing # once after seeding; turns the seeded values into ciphertext
npm run dev              # http://localhost:4000
```

```bash
cd web
npm install
npm run dev              # http://localhost:5173
```

```bash
cd mobile
npm install
npm run dev              # http://localhost:5174
```

`curl http://localhost:4000/api/health` should return
`{"status":"ok","database":"connected"}`.

Both clients proxy `/api` to the API, so the session cookie is same-origin and
needs no further configuration.

---

## Running the tests

```bash
cd server
npm test                        # 323 behavioural assertions
npm run test:2fa                # 78 — two-factor authentication
npm run test:accounts           # 47 — invitations, password reset, suspension
npm run test:catalogue          # 49 — consultant edit and deactivation, skills, termination
npm run test:placements         # 55 — extending a placement, keeping the original end date
npm run test:retention          # 89 — retention of unplaced candidates, anonymisation
npx tsx src/test/paging.ts      # 36 — page boundaries and totals under RLS
npx tsx src/test/validation.ts  # 26 — the server refuses what the forms refuse
npm run test:backup             # 23 — back up, restore, verify
npx tsx src/test/e2e.ts         # 19 — the screens the web client loads
npm run test:clients            # client isolation
npm run test:proxy              # proxy and transport behaviour
```

```bash
cd mobile
npx tsx test/mobile.ts          # 43 — capture, approval, offline sync, CSRF
```

```bash
PGOPTIONS=-c rasibe.tests_strict=on \
  psql -U rasibe_app -d rasibe -v ON_ERROR_STOP=1 -f db/tests.sql   # 38 database checks
```

Every suite runs against the real database rather than mocks. Each assertion
travels through HTTP, the application layer and PostgreSQL, so a constraint or
trigger that stopped holding fails the suite rather than passing unnoticed.

**The suites write data and do not roll back.** Rebuild the database before each
run. Running `npm test` twice without rebuilding produces failures that look real
but are not: the second run finds a week it already carried through submit,
approve and invoice. Run them in the order above: the catalogue suite ends a
seeded placement, so `npm test` must come before it. The placements and retention
suites build their own consultants and can be repeated.

`db/tests.sql` needs `PGOPTIONS=-c rasibe.tests_strict=on`. Without it a failed
check is only a `NOTICE` and `psql` still exits 0, which is a false pass.

### What the suites have caught

Worth stating, because it is the argument for having them:

- A consultant submitting a week could not read the contact table, because
  row-level security restricts it. The approver lookup returned nothing and no
  notification was raised — silently. An approver would never have been told work
  was waiting.
- Every paged list sorted by a non-unique column, so the same row could appear on
  two pages while another was never shown at all. Invisible until there is enough
  data to need paging, which is when nobody is checking by hand.
- `PATCH /consultants/:id` accepted a pay-rate change from a recruiter, which the
  requirements do not allow. The edit screen hid the fields; the server did not
  enforce it.

---

## Security

Security is built in layers, so that no single mistake in one of them exposes
anything. The central rule, that a consultant never sees a bill rate and a client
manager never sees a pay rate, is enforced in the database itself, not only in the
API. `docs/SECURITY-CONTROLS.md` takes every security, privacy and reliability
requirement in the specification and records, for each one, what meets it, how it is
checked, and where it falls short.

| Concern | What is done | Detail |
| --- | --- | --- |
| **Who can do what** | Three independent layers: a role check on every route, row-level security in PostgreSQL, and removal of restricted fields before a response is written. The API connects as a role that is not a superuser, owns no tables and cannot bypass the policies; in production it refuses to start if its login could | `docs/ROLE-PASS-2026-10-14.md` |
| **Rate confidentiality** | Bill rates and margin never reach a consultant; pay rates and margin never reach a client manager. The values are absent from the response, so they cannot be recovered from the browser | [Rate confidentiality](#rate-confidentiality) |
| **Passwords** | Hashed with Argon2id and a secret pepper, known-breached passwords refused. Nobody is given a password: an administrator sends an invitation or reset link that is valid for a limited time, used once, and stored only as a hash | `docs/PASSWORDS.md`, [Accounts](#accounts) |
| **Sign-in** | Five wrong passwords lock the account for 15 minutes, and sign-in attempts are throttled per address as well. Response timing is equalised so the form does not reveal which emails exist | `docs/LOGIN.md`, `docs/THROTTLE.md` |
| **Two-factor** | Optional for every user: an authenticator app plus single-use recovery codes. An administrator can reset it for someone who has lost their phone | `docs/TWO-FACTOR.md` |
| **Sessions** | A random identifier in an `HttpOnly`, `Secure` cookie, with the session held server-side. A new session is issued at sign-in, signing out revokes it immediately, an idle session ends after 30 minutes and any session after 8 hours. Suspending an account ends its sessions at once | `docs/SESSIONS.md` |
| **Encryption at rest** | Identity numbers, banking details and vetting results are encrypted with AES-256-GCM before they reach the database, which never holds the key. Uniqueness of an identity number is kept with a keyed fingerprint, since ciphertext cannot be compared | `docs/ENCRYPTION.md` |
| **Encryption in transit** | HTTPS with HSTS, a `Secure` cookie, and a verified TLS connection from the API to the database | `docs/TLS.md` |
| **Forged requests (CSRF)** | `SameSite` cookie, a single permitted origin, and a token tied to the session that every write must send back | `docs/CSRF.md` |
| **Input** | Every query uses placeholders, never string-built SQL. Request bodies are checked against a schema that rejects unknown fields, query strings against an allow-list, and every identifier as a UUID. An identity number must be a real one, with a valid date of birth and check digit, before it is encrypted. The forms' checks are only a convenience: the server refuses the same requests without them | `docs/VALIDATION.md`, `docs/IDENTITY.md` |
| **Output** | React escapes everything it renders, a Content-Security-Policy limits where scripts may load from, and spreadsheet exports neutralise formula injection | `docs/HEADERS.md` |
| **Business rules in the database** | Overlapping placements, timesheets without an active placement, invoices from unapproved hours, edits to an issued invoice and edits to a submitted week are all refused by constraints and triggers, even against direct SQL | [How the important rules are enforced](#how-the-important-rules-are-enforced) |
| **Audit** | An append-only record of the financially significant actions, each with who, when, what changed and why. The application's database login cannot alter or delete it | `docs/SECURITY-CONTROLS.md` |
| **Privacy** | Consent is recorded before a consultant is disclosed to a client, clients see only a minimum profile, unplaced candidates are anonymised after a retention period, and anyone can be anonymised on request | [Retention and anonymisation](#retention-and-anonymisation) |
| **Errors and logs** | A fault returns a short message and a reference, never a stack trace or a database message. Logs hold no personal data, credentials or session tokens | `docs/RESILIENCE.md` |
| **Backup and recovery** | A backup records checksums, row counts and a fingerprint of each encryption key. A restore refuses an existing target, verifies the counts, decrypts every protected value and recomputes every fingerprint, so a restore that cannot be read is detected | `docs/BACKUP.md` |
| **Secrets and keys** | The three keys that protect data and passwords come from the environment and never from the repository. In production the server will not start without them | [Configuration](#configuration) |
| **Automated checks** | Every pull request runs the server suites, a backup drill, a secret scan, a dependency audit and CodeQL | [Continuous integration](#continuous-integration) |

Two things are worth knowing when reading this. First, the controls above are
checked by automated suites that run against a real database, so a control that
stops holding fails the build instead of passing unnoticed. Second, the web and
mobile screens have no automated tests; they were checked by hand in a browser, in
a four-role pass recorded in `docs/ROLE-PASS-2026-10-14.md`.

---

## Continuous integration

Eight checks run on every pull request and on every push to `main`. CodeQL also
runs weekly, because its query pack changes even when this repository does not.
`docs/CI.md` explains what each is for and what none of them covers.

| Check | What it would catch |
| --- | --- |
| Server CI | A regression in any of the behavioural assertions |
| Database tests | A row-level security policy or trigger that stopped holding |
| Secret scan | A credential committed to the repository |
| Dependency audit | A known flaw in something the API or a client ships |
| Web CI | A front end that no longer compiles for production |
| CodeQL | A vulnerability pattern in the JavaScript or TypeScript |
| Backup drill | A backup that no longer restores, or restores unreadable |

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
| BR-006, BR-007 rate confidentiality | row-level security, projection views, server-side field stripping |
| BR-008 rates snapshotted at submission | `fn_timesheet_status_transition` |
| BR-009 a rate change needs approval | `fn_placement_status_transition` |
| BR-010 invoice number allocated at issue | `fn_invoice_status_transition` |
| BR-011 an issued invoice is immutable | `fn_invoice_status_transition` |
| BR-012 consent before disclosure | `trg_submission_consent` |
| BR-013 client data isolation | row-level security policies |
| BR-016 daily hour ceiling | `fn_timesheet_recalc` |
| BR-017 a deactivated consultant may not be submitted | `trg_submission_consent` |
| BR-018 no editing a submitted week | `fn_timesheet_status_transition` |
| BR-019 server wins on sync conflict | `client_uuid` and `row_version` on `timesheet` |
| BR-020 append-only audit log | `REVOKE UPDATE, DELETE ON audit_entry` |
| BR-022 no duplicate submission | `uq_submission` |

### Rate confidentiality

The defining requirement. A consultant must never see the bill rate or the
margin; a client manager must never see the pay rate or the margin. Enforced in
three places rather than one:

1. **Row-level security** decides which rows a session may read at all.
2. **`security_invoker` views** omit the restricted columns from the query.
3. **`project()`** strips restricted keys on the server before serialisation.

The restricted values are therefore never transmitted. They cannot be recovered
from network traffic, a browser console, or a modified client.

Verified on the deployed database by counting the client companies visible under
four conditions: the owner sees four, the application role with nobody signed in
sees none, as a client manager one, as an administrator four. The zero is the
telling figure — a database where the policies were bypassed would have returned
four every time.

### Offline timesheet capture

A consultant on client premises frequently has no signal. The mobile client holds
the week in `localStorage` against a `clientUuid` generated on the device before
any connectivity exists. On reconnection the queue goes to
`POST /api/timesheets/sync`, which answers in one of three ways:

| Outcome | Meaning |
| --- | --- |
| `accepted` | The week was written. |
| `already_accepted` | That token had already been processed. Nothing is created, so retransmission is harmless. |
| `conflict` | The server row has moved on. The server version stands, the local copy is kept, and the consultant is told. |

The failure mode of an unreliable connection is a **repeated** request, not a
lost one, which is why the operation is keyed by a token rather than retried.

### Front-end validation

Both clients check what they can as the person types: dates that run backwards, a
pay rate above a bill rate, hours beyond the daily ceiling, a reason too short to
be useful. A field is not marked wrong while it is still being filled in — the
message appears when the person leaves it, or on submit.

None of that is security, and nothing on the server was relaxed because of it.
`server/src/test/validation.ts` sends, without a browser, exactly the requests the
forms refuse, and asserts the API still rejects every one.

### Accounts

There is no self-registration. A consultant cannot sign themselves up because they
must already be in the pool with consent recorded; a client manager cannot because
they would be claiming access to a company's data.

An administrator creates the account and chooses the role. No password is set: an
invitation valid for 72 hours is issued and the person chooses their own, so nobody
else ever knows it. A forgotten password is recovered the same way with a one-hour
link. Both tokens are stored only as a SHA-256, so a reader of that table cannot
set anybody's password.

### Paging

Six lists page: consultants, role requests, placements, timesheets, invoices and
the audit log. The response carries `items`, `total`, `page`, `pageSize`,
`pageCount` and `hasMore`.

`total` is counted under the same row-level security as the list, so a client
manager is told how many of their own records exist rather than how many the
system holds. Counting without that would leak the size of data they cannot read.

### Retention and anonymisation

An unplaced candidate is kept only for a set time. The period is the setting
`candidate_retention_months` (12 by default), read each time, so changing it
applies to people already in the pool. Someone who has agreed to be kept longer is
not due until that date.

"Unplaced" is strict: no placement of any kind, and no submission a client is still
considering. Anybody who has worked for a client belongs to the financial record
and is never touched by this rule.

An administrator previews who is due, then runs it (`/api/retention`). It does not
run on a timer, because removing personal data is not something to happen
unattended. A consultant can also be anonymised on request.

People are anonymised, not deleted, because placements and submissions refer to
them. Name, contact details, identity number, banking, vetting, rates, certifications,
documents and queued emails are removed, and their sign-in account is closed.
Invoices are kept and their amounts do not change; the one place the name was
copied to, the words on an invoice line, is rewritten. `docs/SECURITY-CONTROLS.md`
states what this does not reach: the append-only audit log, free text typed
elsewhere, and backups taken earlier.

---

## Email

Notifications are written to the `notification` table inside the same transaction
as the business change, which satisfies the requirement that a delivery failure
must never roll back a booking. A dispatcher sends them afterwards — on a timer
inside the API, or on demand:

```bash
npm run notify:send
```

Rows are claimed with `FOR UPDATE SKIP LOCKED`, so two dispatchers cannot send the
same message twice. A failure backs off 1, 2, 4 then 8 minutes and is abandoned
after five attempts.

Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` and `MAIL_FROM`
in `server/.env`, then check it:

```bash
npm run mail:verify                      # tests the connection, sends nothing
npm run mail:verify -- you@example.com   # sends one test message
```

With no `SMTP_HOST` set, notifications are logged instead of sent. That is the
development default and needs no mail server.

Gmail requires an **app password** rather than an account password, which in turn
requires two-step verification on the account.

---

## API reference

All routes are under `/api`. Authentication is a `httpOnly` session cookie, and
every write carries a CSRF token. List endpoints accept `page` and `pageSize`.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/auth/login` | Sign in; with two-factor on, answers that a code is needed |
| POST | `/auth/login/verify` | Complete sign-in with an authenticator or recovery code |
| POST | `/auth/logout` | Sign out and revoke the session |
| GET | `/auth/me` | Current user, role, capabilities, landing page |
| POST | `/auth/change-password` | Change password, revoking other sessions |
| POST | `/auth/2fa/setup`, `/auth/2fa/enable`, `/auth/2fa/disable` | Enrol, confirm and turn off two-factor |
| POST | `/auth/2fa/reset/:userId` | Administrator clears somebody's two-factor |
| GET/POST | `/auth/token/:purpose` | Read or redeem an invitation or reset link |
| POST | `/auth/forgot-password` | Request a reset link |
| GET/POST | `/users` | Accounts: list, create and invite |
| POST | `/users/:id/invite` | Reissue an invitation |
| POST | `/users/:id/status` | Suspend or reinstate |
| POST | `/users/:id/role` | Change a role |
| GET | `/consultants` | Search the pool |
| GET | `/consultants/:id` | Full profile, projected by role |
| POST | `/consultants` | Add to the pool |
| PATCH | `/consultants/:id` | Amend; rates are administrator-only |
| POST | `/consultants/:id/consent` | Record consent to disclosure |
| POST | `/consultants/:id/deactivate` | Deactivate, with a reason |
| GET/POST | `/skills` | The matching taxonomy |
| PATCH | `/skills/:id` | Rename, recategorise or restore |
| POST | `/skills/:id/retire` | Retire, reporting how many records carry it |
| GET/POST | `/clients` | Client companies |
| GET/POST | `/requests` | Role requests |
| GET | `/requests/:id/matches` | Matching consultants |
| GET/POST | `/requests/:id/submissions` | Submissions against a request |
| PATCH | `/requests/submissions/:sid` | Record an outcome |
| GET/POST | `/placements` | Placements |
| POST | `/placements/:id/approve-rates` | Approve the rates and activate |
| PATCH | `/placements/:id/rates` | Change rates; returns for approval |
| POST | `/placements/:id/extend` | Extend a live placement to a later date; the original end date is kept and each extension audited (administrator) |
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
| POST | `/invoices/:id/payment` | Record a payment against an issued invoice |
| POST | `/invoices/:id/export` | Spreadsheet export for the bookkeeper |
| GET | `/dashboard` | Dashboard figures for the current role |
| GET | `/reports/*` | Margin, utilisation, outstanding, ageing, audit |
| GET | `/notifications` | The current user's notifications |
| GET/PUT | `/settings` | System configuration |
| GET | `/retention` | Unplaced candidates past the retention period: a preview, nothing changes (administrator) |
| POST | `/retention/run` | Anonymise everyone who is due; `{"dryRun": true}` only counts (administrator) |
| POST | `/retention/consultants/:id/anonymise` | Anonymise one consultant on request, with a reason (administrator) |
| POST | `/retention/consultants/:id/consent` | Record that a candidate agreed to be kept longer (recruiter or administrator) |

---

## Configuration

Everything in `system_setting` is changed by an administrator through the Settings
screen without a deployment: the timesheet cycle, reminder and escalation
intervals, the placement alert thresholds, the daily hour ceiling, retention
periods, company details and invoice numbering.

`server/.env.example` is the authoritative list of environment variables and
explains each in place. Every security variable is optional in development and the
system runs with none of them set, so a fresh clone and the test suites work with
no setup.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | localhost:5432 | Database connection |
| `PORT` | 4000 | API port |
| `NODE_ENV` | development | `production` hides internal error detail and makes the keys below mandatory |
| `SESSION_TTL_HOURS`, `SESSION_IDLE_MINUTES` | 8 / 30 | Session lifetime and idle timeout |
| `CORS_ORIGIN` | http://localhost:5173 | Permitted browser origin |
| `DATA_ENCRYPTION_KEY` | derived | Encrypts identity, banking and vetting values. **Losing it loses that data** |
| `DATA_INDEX_KEY` | derived | Derives the fingerprint keeping the identity number unique |
| `PASSWORD_PEPPER` | derived | Secret mixed into every password hash. **Losing it means nobody can sign in** |
| `CSRF_SECRET` | random at boot | Signs the token protecting state-changing requests |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | unset | Serve HTTPS from this process |
| `FORCE_HTTPS`, `PUBLIC_HOST` | unset | Redirect plain HTTP. `PUBLIC_HOST` is required when `FORCE_HTTPS` is on |
| `PGSSLMODE`, `PGSSLROOTCERT` | disable | Encrypt the database connection. A hosted database needs at least `require` |
| `SMTP_*`, `MAIL_FROM` | unset | Email delivery |
| `NOTIFY_DISPATCH`, `NOTIFY_INTERVAL_SECONDS` | on / 60 | The notification dispatcher |

With `NODE_ENV=production` the server **refuses to start** without
`DATA_ENCRYPTION_KEY`, `DATA_INDEX_KEY` or `PASSWORD_PEPPER`, because the
alternative is silently writing data that a stolen database is enough to read.

All three must be backed up separately from the database and never inside it. A
backup restored without them has unreadable identity and banking details and no
password that verifies. `docs/BACKUP.md` covers taking a backup, restoring it, and
how a restore checks it has the right keys.

---

## Troubleshooting

**`The token '&&' is not a valid statement separator`** — Windows PowerShell does
not accept `&&`. Run each command on its own line, or use `db\apply.ps1`.

**`psql is not recognised`** — PostgreSQL is not on your PATH:

```powershell
$env:Path += ";C:\Program Files\PostgreSQL\16\bin"
```

**`column ... does not exist` after pulling** — a migration has not been applied.
Apply every `db/migrations-*.sql` newer than your last run.

**`password authentication failed for user "rasibe_app"`** — the role lives at
server level, so dropping and recreating the database does not refresh its
password:

```sql
ALTER ROLE rasibe_app WITH PASSWORD 'rasibe_app_pw';
```

**Tests fail on ciphertext** — run `npm run encrypt-existing` once after seeding.

**Tests fail with "transition not permitted" or "already submitted"** — the
database has been through a previous run. Rebuild it.

**A button is missing for a role that should have it** — capabilities are read at
sign-in from `role_capability` and held for the session. Sign out and back in after
a migration that changes them.

**The client shows "Could not load"** — the API is not running. Check
`http://localhost:4000/api/health`.

---

## Design decisions worth knowing

**Roles are data, not subclasses.** A user holds `user_role` records carrying
`role_capability` entries, so permissions change without a schema change. The
clients build their navigation from the same table, so it must agree with the
capability map in `lib/errors.ts`.

**Rates are snapshotted twice.** Once onto the placement at creation, once onto the
timesheet at submission. A rate agreed in March cannot alter a February week
already approved and invoiced.

**Invoice numbers are allocated at issue, not at draft.** A discarded draft consumes
no number, so the sequence has no gaps to explain to an auditor.

**Availability is derived from placement records**, not maintained by hand, so the
flag cannot drift from reality. A consultant sets only when they become free, which
nobody else knows.

**Consultants and skills are retired, not deleted.** The placements, timesheets and
invoices behind a consultant are financial records, and the proficiency recorded
against a skill was entered by hand. Retiring removes them from matching and keeps
the history.

**A placement is extended, not replaced.** Extending moves the end date on the same
placement and keeps the original. It does not use the renewed status, which is not a
live one and would stop timesheets; and it cannot run into the consultant's next
booking, because the database refuses an overlap.

**Authorisation is a distinct concern**, applied as projection before serialisation
rather than spread through the controllers. One place to get right, one place to
test.

**A paged query needs a total order.** Sorting by a name or a date alone leaves
ties, and the database is free to return tied rows in any order, so the same row can
appear on two pages. Every paged query carries a unique tiebreaker.

**The mobile client is deliberately small.** Five screens, two roles. Everything a
recruiter or administrator does stays on the web client, because a consultant on
site and a recruiter at a desk are not doing the same job.

---

## Authors

**Nosipho** (ST10507346) — requirements and analysis, API, web and mobile clients,
project management

**Loyiso Theo Tose** (ST10504517) — design and architecture, security controls,
deployment
