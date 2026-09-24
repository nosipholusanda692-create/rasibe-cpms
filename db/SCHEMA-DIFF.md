# Schema reconciliation (RCP-01)

Agreed with Nosipho: **`db/` is the schema the application runs.** The four files stay in this order:

1. `01_schema.sql` — types, tables, keys
2. `02_security.sql` — roles, row-level security, projection views
3. `03_triggers.sql` — state machines and financial invariants
4. `04_seed.sql` — reference data and demonstration accounts

Nothing in `db/` is deleted or replaced by the design-phase file. `design/database/schema.sql` in the `XADAD7112` folder is the historical planning schema. It is what `tests.sql` still targets until RCP-02. Do not apply it to the `rasibe` database.

## Counts

| | Design `schema.sql` | Running `db/01_schema.sql` |
| --- | --- | --- |
| Tables | 25 | 27 |
| Enum types | 17 | 17 |
| Schema | `rasibe` (`search_path`) | `public` |

`02_security.sql`, `03_triggers.sql` and `04_seed.sql` have no design-file counterpart. They exist only in `db/`.

## Tables only in `db/`

These are what the API already queries. The design file has never had them.

| Table | Why it is here |
| --- | --- |
| `user_session` | Cookie session: issued, expires, revoked, address. Read by `server/src/middleware/auth.ts`. |
| `login_attempt` | Each sign-in attempt, success or failure, with timestamp and address (FR-AUT-011). |
| `system_setting` | Administrator settings without a deployment (cycle, hour ceiling, invoice numbering). |

## Tables only in the design file

| Table | Why it is not in `db/` |
| --- | --- |
| `consultant_demographics` | Race, gender and disability, isolated in design because BBBEE reporting was unresolved. The running schema does not store those fields. Leave it out. |

## Enum differences that matter

Same 17-type count, not the same types.

| Design | Running `db/` |
| --- | --- |
| `id_number_type_enum` (`SA_ID`, `PASSPORT`) | No such type. `consultant.id_number` is `varchar(40)` |
| `engagement_enum` | Same values, named `engagement_type_enum` |
| `availability_enum` includes `ARCHIVED` | No `ARCHIVED`. Leaving the pool is `is_active` / `is_anonymised` |
| `document_type_enum` has `ID`, `QUALIFICATION`, `VETTING_RESULT`, `RIGHT_TO_WORK`, `CLIENT_AGREEMENT`, `REFERENCE` | `CV`, `CONTRACT`, `CERTIFICATION`, `VETTING`, `ID_DOCUMENT`, `OTHER` |
| `channel_enum` includes `PUSH` and `SMS` | `EMAIL`, `IN_APP` only |
| No invoice line type | `invoice_line_type_enum`: `STANDARD`, `OVERTIME`, `CREDIT`, `ADJUSTMENT` |
| `notification_event_enum` uses `CONTRACT_ENDING`, `INVOICE_OVERDUE`, `NEW_RESOURCE_REQUEST`, `CANDIDATE_SUBMITTED` | `TIMESHEET_OVERDUE`, `PLACEMENT_ENDING`, `REQUEST_RAISED`, `SUBMISSION_OUTCOME`, `ACCOUNT_CREATED`, `PASSWORD_RESET` |

`timesheet_status_enum` and `invoice_status_enum` use the same labels. Member order differs; PostgreSQL enum order is not interchangeable, so RCP-02 must follow **`db/`**, not the design file.

## What RCP-02 must not assume

- Tests that `CREATE` inside schema `rasibe`, or that expect `consultant_demographics`, will not pass against this database.
- Tests for `user_session` and `login_attempt` do not exist yet. RCP-02 adds them (expiry, revocation, lockout counter).
- `id_number`, `vetting_status` and `bank_account_ref` are still plaintext. Encryption is RCP-08, not this ticket.
