# Schema diff

`db/` is the schema the application runs. `01_schema.sql` through `04_seed.sql` stay as they are. The design `schema.sql` is not in this repository. Where that file disagrees with `db/`, this database wins.

## Added here

These tables are in `db/01_schema.sql` and are part of the running application:

- `user_session` — session id, expiry, and revocation
- `login_attempt` — each sign-in attempt, with a timestamp and an address
- `system_setting` — configuration such as `max_hours_per_day`

## Left out

`consultant_demographics` (race, gender, disability) is not created. It stays out.

## Enum names

The design file is not in this clone, so this note does not list its enum names. Tests and later migrations follow the types declared in `db/01_schema.sql`.

## Tests

`db/tests.sql` is the suite for this schema. It runs 36 checks in one transaction and then rolls back, so the seed data stays. It covers consent before submission, overlapping full-time placements, rate approval before activation, timesheet rules, invoicing only from an approved week, the 60/30/14 `PLACEMENT_ENDING` templates, `rasibe_app` blocked from updating or deleting `audit_entry`, `user_session` expiry and revocation, and the `login_attempt` / `failed_logins` lockout shape.

Run it with `PGOPTIONS=-c rasibe.tests_strict=on`. Without that setting, a failed check is only a notice and `psql` exits 0.

The design-folder suite, including Luhn identity checks and `consultant_demographics`, targets objects that are not in this database. Do not run that file against `rasibe`.
