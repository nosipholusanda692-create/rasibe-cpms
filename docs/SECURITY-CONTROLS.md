# Security controls

RCP-14. One row for each security, privacy and reliability requirement in
section 5 of the Rasibe CPMS specification (NFR-SEC, NFR-PRI, NFR-REL): what the
requirement says, what in this repository meets it, and how that is checked.

The status column is deliberately blunt. Where a requirement is only partly met
or not built, the row says so and the gap is repeated in
[Open items](#open-items) so it is not lost inside a table.

| Status | Meaning |
| --- | --- |
| **Met** | Built, and an automated check fails if it stops being true |
| **Met (by design)** | Built, but no automated check covers it; the evidence is how the code is written |
| **Partly** | Some of the requirement is built; the gap is stated |
| **Not built** | Nothing implements it yet |

## Security (NFR-SEC)

| ID | Requirement | Status | Control | Evidence |
| --- | --- | --- | --- | --- |
| NFR-SEC-001 | Client–server traffic uses TLS | **Met**, once hosted behind TLS | API serves HTTPS when a certificate is configured and redirects HTTP to the configured host (no open redirect through the `Host` header); HSTS for a year; the session cookie is `Secure`; the API-to-database hop uses TLS (`verify-full` against Neon). The certificate itself comes from the host in production. | `run.ts`: "Transport security", "HTTPS redirect destination". `docs/TLS.md`. Neon branch run with `PGSSLMODE=verify-full`. The hosted deployment is not done yet (see Open items). |
| NFR-SEC-002 | Authorisation enforced on the server for every operation and field | **Met** | Three layers: role checks on every route (`requireAuth`, `requireInternal`, `requireAdmin`, `assertCapability`); row-level security policies in `db/02_security.sql`; and field filtering (`project()`) plus restricted views. The API connects as `rasibe_app`, which is not a superuser, has no `BYPASSRLS` and owns no tables, so the database applies the policies to it. In production the API refuses to start if its login breaks any of those. | `run.ts`: "Application database role", "Data isolation". Isolation test on a Neon branch copy of production (owner 4 rows, no actor 0, client manager 1, administrator 4). `docs/ROLE-PASS-2026-10-14.md`: four roles checked by hand. `GET /api/settings` (company bank details, tax number) is administrator-only, like writing; `run.ts`: "Settings are administrator-only". |
| NFR-SEC-003 | Never disclose a bill rate or margin to a Consultant | **Met** | Enforced in the database, not only the API: policies and `security_invoker` views hide rate columns, and `project()` strips restricted keys on the way out. Reports and the invoice export are administrator-only. | `run.ts`: "Rate confidentiality". Role pass: the consultant saw their own pay rate, no bill rate, no margin. |
| NFR-SEC-004 | Never disclose a pay rate or margin to a Client Manager | **Met** | Same mechanism as NFR-SEC-003, for the Client Manager role. Sign-in timing is also equalised so account existence is not disclosed. | `run.ts`: "Rate confidentiality", "Sign-in timing". Role pass: the client manager saw their own company's bill rates only. |
| NFR-SEC-005 | Identity numbers, banking details and vetting results encrypted at rest | **Met** | AES-256-GCM with a fresh 12-byte nonce per write, encrypted by the API before the value reaches the database. Uniqueness of the identity number is kept with a blind index (HMAC-SHA256), because ciphertext cannot be unique. Keys live in the environment; the backup records a fingerprint of each so a restore can prove it has the right ones. | `run.ts`: "Encryption at rest", "Identity numbers and bank accounts". `docs/ENCRYPTION.md`. `npm run test:backup` decrypts every value after a restore. Losing `DATA_ENCRYPTION_KEY` makes those columns unreadable by design. |
| NFR-SEC-006 | Validate and sanitise all input on the server (injection) | **Met** | Every SQL statement uses placeholders (`$1`…); the only interpolated SQL is placeholder numbers and a column name chosen from a fixed map. Bodies are checked by zod schemas that reject unknown fields; query strings use allow-lists; every id is checked as a UUID; database format errors become a 400. Saved settings have a rule per key. Front-end validation is a convenience only, and a test proves the server still refuses what the forms would not send. | `run.ts`: "Input validation on query strings", "Unknown fields in request bodies", "Validation and error handling", "Settings are checked when they are saved". `server/src/test/validation.ts` (26 checks). `docs/VALIDATION.md`. |
| NFR-SEC-007 | Encode user content on output (XSS) | **Met (by design)** | The web and mobile apps render through React, which escapes text; neither uses `dangerouslySetInnerHTML` or `innerHTML`. A Content-Security-Policy limits where scripts load from. CSV exports neutralise spreadsheet formula injection. | Search of `web/src` and `mobile/src` finds no raw HTML injection. `run.ts`: "Security response headers", "CSV export". `docs/HEADERS.md`. There is no browser test of this. The CSP still allows inline styles (`style-src 'unsafe-inline'`), noted for Nosipho. |
| NFR-SEC-008 | Protect state-changing requests against CSRF | **Met** | `SameSite=Lax` session cookie, a single allowed CORS origin, JSON-only bodies, and a token bound to the session by HMAC that every write must send back as a header, compared in constant time. | `run.ts`: "Cross-site request forgery". `docs/CSRF.md`. |
| NFR-SEC-009 | Uploaded files stored outside any executable path | **Not built** (nothing to violate) | There is no upload endpoint. The documents table records metadata only. | Search of the server finds no upload handling. The rule applies the moment document upload (FR-DOC) is built: store outside the web root, validate type and size, serve through time-limited links. |
| NFR-SEC-010 | Secure session ids, rotated on privilege change, invalidated on logout | **Met** | Sessions are random, server-side rows named by an `HttpOnly`, `Secure` cookie. A new id is issued at sign-in (with two-factor on, no session exists until both factors are right), signing out revokes the row, an idle session ends after 30 minutes and any session after 8 hours. Two-factor sign-in (TOTP and recovery codes) is available, and the web and mobile screens for it exist. | `run.ts`: "Session rotation on a privilege change", "Sign out", "Idle session timeout". `src/test/two-factor.ts` (78 checks). `docs/SESSIONS.md`, `docs/TWO-FACTOR.md`. Administrator two-factor is not yet mandatory in production (`REQUIRE_ADMIN_2FA`, to be switched on at deployment). |
| NFR-SEC-011 | Immutable audit entry for every financially significant action | **Met** | `audit_entry` records actor, time, entity, previous value, new value and reason, and `UPDATE` and `DELETE` are revoked from the application's role, so the application cannot alter it. Written for: timesheet approval, rejection and override; rate changes and approvals; invoice approval, issue and payment; credit notes; changes to settings such as the VAT rate and company bank details (with the value replaced); placement termination; consent; vetting access; user and two-factor changes. | `run.ts`: "Dashboard, reports and audit", "Settings are administrator-only, and money actions are audited"; `db/tests.sql` (audit role section). **Limits:** "immutable" holds against the application's login only, because the database owner could still change rows. `INVOICE_CANCELLED` and `BANKING_ACCESSED` exist as actions but nothing writes them, because there is no invoice-cancel route and bank accounts are only ever shown masked. The new actions need `db/migrations-006-audit-actions.sql` on an existing database. |
| NFR-SEC-012 | No stack traces or internal detail in messages | **Met** | The error handler returns a short message and a reference for any server fault and logs the detail separately; database errors are translated into plain messages. With `NODE_ENV=production`, internals are hidden everywhere; the framework header is removed. | `run.ts`: "Security response headers", "Validation and error handling". `docs/HEADERS.md`. Depends on `NODE_ENV=production` at deployment. In development, stack traces are shown by design. |

## Privacy and regulatory compliance (NFR-PRI)

| ID | Requirement | Status | Control | Evidence |
| --- | --- | --- | --- | --- |
| NFR-PRI-001 | Collect and process personal information only for the stated purposes | **Met (by design)** | The schema holds only the fields the specification lists; nothing is sent to a third party and there is no analytics. | Review of `db/01_schema.sql`. Procedural, no automated check. |
| NFR-PRI-002 | Record consent before disclosing a consultant to a client | **Met** | A database trigger refuses a submission to a client unless consent is on record (BR-012), regardless of which client or API path attempts it. | `run.ts`: "Submissions and consent". `db/03_triggers.sql`. |
| NFR-PRI-003 | Client Managers see only minimum personal information, no identity number or personal contact details before placement | **Met** | Client Managers read restricted views (`v_consultant_profile_client`, `v_placement_client`, `v_timesheet_client`) that leave out the identity number, banking, personal contact details and pay rates. | `run.ts`: "Data isolation". Role pass: client manager. |
| NFR-PRI-004 | Retain financial records as required and unplaced candidates only for a configurable period | **Partly** | The schema carries the rules: `retention_expires_on` is set on each consultant and `data_retention_rule` holds the periods (12 months unplaced, 5 years financial). **Nothing acts on them.** No job removes or anonymises a record when its date passes. | `db/01_schema.sql`, `db/04_seed.sql`. The 30-day *backup* retention is separate and is built and tested. |
| NFR-PRI-005 | Delete or anonymise a consultant's information on request, keeping anonymised financial records | **Not built** | The `is_anonymised` flag exists and queries already skip anonymised consultants, and the audit action `CONSULTANT_ANONYMISED` is defined. No route or function performs the anonymisation. (Priority: Should.) | Search of the server for anything that sets the flag finds nothing. |
| NFR-PRI-006 | No personal information, credentials or session tokens in application logs | **Met** | A server fault is logged as one line holding an error id, method, path, error name, SQLSTATE, constraint and routine, never the database error's message or row values. Control characters are removed so a crafted path cannot forge a second log record. | `run.ts`: "Validation and error handling" (log-line checks), "Database faults do not end the process". `server/src/lib/logging.ts`. |
| NFR-PRI-007 | Record date, purpose and recipient of every disclosure of a consultant profile | **Partly** | Each disclosure writes an audit entry with the actor, time, the submission and a fixed reason ("Professional profile disclosed to client company"). The recipient can be found by following the submission to its request and client, but purpose and recipient are not fields of their own. (Priority: Should.) | `requests.ts` submission route. |

## Reliability (NFR-REL)

| ID | Requirement | Status | Control | Evidence |
| --- | --- | --- | --- | --- |
| NFR-REL-001 | Invoice generation is transactional, so a partial invoice is never saved | **Met** | Preparing and issuing an invoice run inside one database transaction, and the included weeks are marked invoiced in the same transaction. Totals are rounded to the cent at every step so lines add up to the subtotal, and a bad stored VAT rate stops the invoice with an instruction instead of producing a wrong total. | `run.ts`: "Invoicing", "Money rounding". |
| NFR-REL-002 | A timesheet is never saved partly submitted | **Met** | Submission runs in a single transaction, and a database trigger (`trg_timesheet_status_transition`) enforces the allowed status changes. | `run.ts`: "Timesheets". |
| NFR-REL-003 | Daily backup, defined retention, periodically tested restore | **Partly** | `npm run backup` takes a snapshot with a manifest (checksum, row counts, key fingerprints) and prunes past 30 days; `npm run restore` refuses an existing target, verifies counts, decrypts every value and recomputes every blind index. A CI workflow runs the drill. | `npm run test:backup` (23 checks), `docs/BACKUP.md`. A backup of the live Neon database was restored on 2026-10-16: 31 tables, every row count, all three key fingerprints, 14 encrypted values and 2 identity fingerprints verified (`docs/DEPLOY.md` section 5). **Gap:** the backup is not scheduled, and the restore has been proven into a scratch database, not as a replacement of the live one. |
| NFR-REL-004 | Email provider failure does not stop any transaction | **Met (by design)**, delivery not built | Notifications are written to the `notification` table inside the transaction and are meant to be delivered afterwards by a separate worker, so a mail outage cannot reach the business transaction. **No delivery worker exists yet**, so no email is sent at all. | `server/src/services/notify.ts`. When the worker is built it must run outside the request and have a test. |
| NFR-REL-005 | Offline synchronisation is idempotent | **Met** | Each offline submission carries a token; sending the same token again changes nothing and creates no duplicate. | `run.ts`: "Offline synchronisation" (check named for BR-019 and NFR-REL-005). |

## Supporting controls

These are not requirements in their own right, but several rows above rely on them.

| Control | Where |
| --- | --- |
| Passwords hashed with peppered Argon2id; breached passwords refused; sign-in throttled per account and per address | `docs/PASSWORDS.md`, `docs/LOGIN.md`, `docs/THROTTLE.md` |
| Crash resilience: dropped database connections, query timeouts, 503 on outages, graceful shutdown, friendly web errors | `docs/RESILIENCE.md` |
| Dependency advisories: `npm audit` is clean for `server` and `web`; `mobile` still has the React Router advisory | `npm audit` in each package |
| Every pull request runs the server suites, a backup drill and the web build in CI | `docs/CI.md` |

## How to re-check

From `server/`, against a throwaway database (never the live one):

```
npm test                 # 323 checks: most of the rows above
npm run test:accounts    # 47: invitations, password reset, suspension
npm run test:2fa         # 78: two-factor sign-in
npx tsx src/test/e2e.ts  # 19: routes end to end
npx tsx src/test/validation.ts  # 26: the server still refuses what the forms refuse
npm run test:backup      # 23: backup and restore drill
```

The web and mobile apps have no automated tests. Their rows were checked by hand
in a browser: the four-role pass (`docs/ROLE-PASS-2026-10-14.md`) and the
crash-resilience and routing passes described in `docs/RESILIENCE.md`.

## Open items

Ordered roughly by how much they matter for a security review.

1. **Migration 006 in Neon** (NFR-SEC-011). Run `db/migrations-006-audit-actions.sql` as the owner before the API that writes the new audit actions is deployed.
2. **Unused audit actions** (NFR-SEC-011). Write or remove `INVOICE_CANCELLED` and `BANKING_ACCESSED` when invoice cancellation or bank-account reveal is built.
3. **Retention is not enforced** (NFR-PRI-004) and **anonymisation does not exist** (NFR-PRI-005).
4. **Disclosure record** (NFR-PRI-007): add purpose and recipient as fields.
5. **No email delivery worker** (NFR-REL-004, FR-NOT).
6. **Backups are not scheduled** (NFR-REL-003). The first Neon backup restored cleanly; a daily run still needs a scheduler and an off-machine copy.
7. **Hosted deployment** (NFR-SEC-001, NFR-SEC-012): TLS at the host, `NODE_ENV=production`, `REQUIRE_ADMIN_2FA=true`, and a four-role check against the live system.
8. **File uploads** (NFR-SEC-009) when document management is built.
9. **`mobile/` dependency advisory** and the remaining mobile gaps listed in the project notes (signed-out screen, failed-save handling).
