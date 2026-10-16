# Deploying

| Part | Where |
|---|---|
| Database | Neon, managed PostgreSQL 18, AWS Europe Central 1 (Frankfurt) |
| API and both clients | One web app. Express serves `web/dist` at `/`, `mobile/dist` at `/m/`, and the API at `/api` |

Both clients call `/api` on the origin they were loaded from, and the session
cookie is `SameSite=Lax`, so a client on a different domain from its API cannot
sign in. That is why the clients are served by the API rather than by a separate
static host. The mobile app is built with its base set to `/m/` (its manifest
and service worker are relative to where they are served), so the two share one
origin, one cookie jar and one set of security headers. Section 6 covers it.

The college Azure subscription does not have the PostgreSQL resource provider
registered, and a student cannot register it. Neon is used instead; the Azure
route is kept at the foot of this file in case the provider is registered later.
Moving between them is a backup and a restore.

**Data location.** Frankfurt is outside South Africa. That is acceptable for a
demonstration holding only fabricated data. A live system holding real
consultants' details would need a lawful basis for the transfer under POPIA
section 72, or a South African region.

This file covers the database (sections 1 to 5) and how the clients are served
(section 6). Choosing a host for the API is the remaining step.

## 1. Create the project

At [neon.tech](https://neon.tech), sign up with GitHub, then create a project:

| Setting | Value |
|---|---|
| Project name | `rasibe-cpms` |
| Region | AWS Europe Central 1 (Frankfurt), the closest offered to South Africa |
| Postgres version | 18, the current default. `pg_dump` and `pg_restore` must be 18 or newer (section 4) |
| Services | Postgres database only. Object storage, Functions, AI gateway and Neon Auth stay off: the API has its own sign-in |

Skip the "prompt for your agent" step and wire it up by hand. Then:

1. **Databases → New database**: `rasibe`, owner `neondb_owner`.
2. **Connect**, with **Connection pooling switched off**, gives the direct host (no `-pooler` in the name). Setup and backups use that one: the pooler shares connections between clients, which suits the API but not building a schema or `pg_dump`.
3. **Reset password** on `neondb_owner` if the password was ever shown on screen, and keep the new one in a password manager only.

The free plan has no IP allow-list. The database is protected by the role
passwords and by a connection that is both encrypted and certificate-checked,
which `db:setup` refuses to run without.

## 2. Trust the server's certificate

`verify-full` checks that the server is the one named, not just that the line is
encrypted. Neon's certificates chain to Let's Encrypt, which Windows and Node
already trust, so no file is needed: `PGSSLROOTCERT=system` tells both the API
and `pg_dump` to use the system's own store.

## 3. Generate the secrets

Five values, each generated once and stored in the password manager. The three
keys are covered in [ENCRYPTION.md](ENCRYPTION.md) and [PASSWORDS.md](PASSWORDS.md);
losing one makes the encrypted columns, or every password, unrecoverable, and
[BACKUP.md](BACKUP.md) explains why they are backed up apart from the data.

| Value | Used by |
|---|---|
| `DATA_ENCRYPTION_KEY`, `DATA_INDEX_KEY`, `PASSWORD_PEPPER` | The API, the backfill, and setup (the pepper hashes the demo passwords, so it must be the value the API will use) |
| `RASIBE_APP_PASSWORD` | The API's database login |
| `RASIBE_REPORTING_PASSWORD` | The reporting login |

In PowerShell, 32 random bytes as hex:

```powershell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') })
```

Plus `DEMO_ACCOUNT_PASSWORD`: the one password every seeded account gets in place
of the published `Password123!`. Shared only with the team and the lecturer.

## 4. Build the database

From `server/`, in a new PowerShell window. `Read-Host -AsSecureString` keeps each
value off the screen and out of the command history.

```powershell
function Secret($prompt) { [Net.NetworkCredential]::new('', (Read-Host -AsSecureString $prompt)).Password }

$env:NODE_ENV = 'production'
$env:BACKUP_PGHOST = 'ep-morning-wave-ba31c64f.c-8.eu-central-1.aws.neon.tech'
$env:BACKUP_PGUSER = 'neondb_owner'
$env:BACKUP_PGDATABASE = 'rasibe'
$env:PGSSLMODE = 'verify-full'
$env:PGSSLROOTCERT = 'system'

$env:BACKUP_PGPASSWORD         = Secret 'neondb_owner password'
$env:RASIBE_APP_PASSWORD       = Secret 'rasibe_app password'
$env:RASIBE_REPORTING_PASSWORD = Secret 'rasibe_reporting password'
$env:DEMO_ACCOUNT_PASSWORD     = Secret 'Demo account password'
$env:PASSWORD_PEPPER           = Secret 'PASSWORD_PEPPER'
$env:DATA_ENCRYPTION_KEY       = Secret 'DATA_ENCRYPTION_KEY'
$env:DATA_INDEX_KEY            = Secret 'DATA_INDEX_KEY'

npm run db:setup
```

`db:setup` refuses before connecting if a value is missing or weak, and refuses a
database that already holds the schema. It creates `rasibe_app` and
`rasibe_reporting` with the passwords given, so they never exist with the
published ones, then applies `01`–`04`, replaces the demo password, checks every
function the API calls by name, and signs in as `rasibe_app` to prove the login
works. It prints no secret.

Then encrypt the seeded identity and banking values, as the application role:

```powershell
$env:PGHOST = $env:BACKUP_PGHOST; $env:PGDATABASE = 'rasibe'; $env:PGUSER = 'rasibe_app'
$env:PGPASSWORD = $env:RASIBE_APP_PASSWORD

npm run encrypt-existing
```

### Which login the API uses

The API must connect as `rasibe_app`, never as `neondb_owner`. The owner has
`BYPASSRLS` and owns every table, so either alone switches every row-level
security policy off: a client manager would see every client's data, and nothing
would fail. The connection string Neon shows by default is the owner's, which
makes the mistake easy to make when filling in the host's settings.

So the API checks its own login before it listens (`server/src/lib/db-role.ts`).
In production it refuses to start if the login is a superuser, has `BYPASSRLS`,
owns any table in `public`, or if a table has policies but row-level security is
off; it also refuses if it cannot run the check. Outside production it warns
instead. There is no setting to turn it off. The message names the fault and
prints no credentials.

## 5. Take the first backup, and prove it restores

`pg_dump` and `pg_restore` must be the same major version as the server or
newer, and Neon runs PostgreSQL 18, so PostgreSQL 16 tools stop with "server
version mismatch". Either put the version 18 command line tools on the `PATH`, or
set `PG_DOCKER_CONTAINER` to a running `postgres:18` container. The 16 container
the test suites use will not do. A throwaway one that only listens on this machine:

```powershell
docker run -d --name rasibe-pg18 -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:55434:5432 postgres:18
```

In Docker mode the tools reach Neon over the network
from inside the container. The container has no certificate store, so the backup
installs the public root certificates Node trusts into the container's `/tmp`
and still verifies Neon's certificate (`PGSSLMODE=verify-full` with
`PGSSLROOTCERT=system`). No secret goes into the container's files; the password
is passed by name.

Use the **direct** host (pooling off). A backup takes a snapshot, and Neon's
pooler cannot hold one open.

```powershell
$env:BACKUP_DIR = 'C:\rasibe\backups'
npm run backup
npm run restore -- C:\rasibe\backups\<newest>.json rasibe_restore_check
```

The restore goes into a new database and checks every count, encrypted value and
key fingerprint. Delete `rasibe_restore_check` under **Databases** once it passes.

To practise the restore without touching Neon, restore into the `postgres:18`
container instead: set `BACKUP_PGHOST=localhost`, `BACKUP_PGPORT=55434`,
`BACKUP_PGUSER=postgres` and `BACKUP_PGPASSWORD=postgres`, and clear `PGSSLMODE`
and `PGSSLROOTCERT`. A Neon dump grants to Neon's own platform roles, so create
them in the container first, or `pg_restore` stops on the first one:

```powershell
docker exec -i rasibe-pg18 psql -U postgres -d postgres -c "CREATE ROLE rasibe_app NOLOGIN;" -c "CREATE ROLE rasibe_reporting NOLOGIN;" -c "CREATE ROLE cloud_admin NOLOGIN;" -c "CREATE ROLE neon_superuser NOLOGIN;"
```

Remove the container afterwards (`docker rm -f rasibe-pg18`): it holds a copy of
the data.

First drill, 2026-10-16: backup of the live database (31 tables, 143 rows)
restored into a scratch database; every row count, key fingerprint, encrypted
value and identity fingerprint checked out.

Neon keeps its own history for point-in-time restore, but it holds none of the
three keys. A restore without them yields rows nobody can read, so the procedure
in [BACKUP.md](BACKUP.md) still applies.

Close the window afterwards: the values live only in that session.

## 6. Running the suites against Neon

To prove the API works on Neon itself, run the suites against a copy, never
the live database. They create fixture accounts, lock and unlock sign-ins,
revoke sessions and write to the audit trail, none of which can be taken out
of the live data afterwards.

1. **Branches → Create branch**: name `test-run`, parent `production`,
   "Branch data and schema", auto-delete after one day. **Connect**, with
   pooling off, gives its host.
2. In a new PowerShell window, from `server/`:

```powershell
function Secret($prompt) { [Net.NetworkCredential]::new('', (Read-Host -AsSecureString $prompt)).Password }

$env:NODE_ENV = 'test'
$env:PGHOST = '<test-run host>'
$env:PGDATABASE = 'rasibe'
$env:PGUSER = 'rasibe_app'
$env:PGSSLMODE = 'verify-full'
$env:PGSSLROOTCERT = 'system'

$env:PGPASSWORD          = Secret 'rasibe_app password'
$env:PASSWORD_PEPPER     = Secret 'PASSWORD_PEPPER'
$env:DATA_ENCRYPTION_KEY = Secret 'DATA_ENCRYPTION_KEY'
$env:DATA_INDEX_KEY      = Secret 'DATA_INDEX_KEY'

npm run reset-demo-for-tests
npm test
npm run test:accounts
```

`reset-demo-for-tests` puts the published demonstration password back on every
account of the copy, and clears lockouts, two-factor and sessions, because that
is the state the suites sign in from. It refuses the live endpoint and anything
but `NODE_ENV=test`. The pepper and both keys must be the hosted ones: the
copy's hashes and encrypted fields were made with them.

`npm test` runs once per copy; a second run finds its own fixtures and fails.
To run again, delete `test-run` and branch afresh. Delete it under
**Branches** when finished, and close the window.

## 6. Serving the web and mobile clients

The API serves the built clients itself (`server/src/lib/clients.ts`):

| Path | Served from |
|---|---|
| `/api/...` | the API, unchanged |
| `/m/...` | `mobile/dist`, the consultant and approver app |
| everything else | `web/dist`, the staff client |

Build both, then start the API as usual:

```powershell
cd web;    npm ci; npm run build
cd ../mobile; npm ci; npm run build
cd ../server; npm start        # or npm run dev
```

Build with `NODE_ENV` unset or `production`. Vite treats any other value (for
example `test`, left over from running the suites in the same window) as a
development build: React ships its debug build at twice the size and the mobile
app's service worker is never registered.

Open `http://localhost:4000/` for the staff client and
`http://localhost:4000/m/` for the mobile app. Nothing is served for a client
whose build is missing, so a checkout that has not built anything behaves as it
always did.

| Variable | Effect |
|---|---|
| `WEB_DIST`, `MOBILE_DIST` | Where the builds are, when not in the repository layout |
| `SERVE_CLIENTS=false` | Serve no client, for an API on its own |

**How it behaves**
- A page is answered before the session middleware, so serving the app costs no
  database lookup and sets no cookie.
- A browser navigation to a client-side route (`/consultants/12`, `/m/week`)
  gets the page, so a reload works. A missing script, image or other file is a
  real 404 and is never answered with HTML. `/api` is never answered with a page.
- Hashed bundles under `assets/` are cached for a year. `index.html`, the
  manifest and the service worker are revalidated on every load: a service
  worker that was cached would keep phones on an old release.
- Files outside the build directory and dotfiles are not reachable.
- Page loads are limited to 300 a minute per address (`PAGE_LOADS_PER_MINUTE` in
  `clients.ts`), because each one reads a file from disk. A person loads the page
  a handful of times a minute at most. Bundles, a missing file and `/api` do not
  count. The limit keys on the client address, so behind a proxy set
  `TRUST_PROXY` correctly, as for the sign-in limit.

**Content Security Policy.** The API's policy already fits the built clients and
needed one change: `upgrade-insecure-requests` is now sent only when
`NODE_ENV=production`, because a plain-http local run cannot satisfy it. The
policy is `default-src 'self'`, `script-src 'self'` with no inline script,
`object-src 'none'`, `frame-ancestors 'none'`, `form-action 'self'`,
`base-uri 'self'`, images from here or `data:` (the QR code), and
`style-src 'self' https: 'unsafe-inline'`. Styles keep `'unsafe-inline'` because
React writes `style` attributes; removing it means moving those to classes in
both clients first. Scripts never had it.

**Mobile at `/m/`.** `mobile/vite.config.ts` sets `base: '/m/'` for a build and
`/` for `npm run dev`, which is unchanged. The router's basename, the service
worker's registration and its cache paths, and the manifest's `start_url`,
`scope` and icons all follow from that. Phones that installed the app before
this change must re-add it from `/m/`.

## Alternative: Azure Database for PostgreSQL

Only if `Microsoft.DBforPostgreSQL` is registered on the subscription
(**Subscriptions → Resource providers**). Create a **Flexible server**:
PostgreSQL 16, Development workload (Burstable B1ms), South Africa North if the
subscription allows it, PostgreSQL authentication with admin `rasibe_owner`,
public access with only your client IP in the firewall, and "Allow public access
from any Azure service" left off. Then:

1. **Server parameters → `azure.extensions`**: allow `PGCRYPTO`, `BTREE_GIST`, `PG_TRGM`. `db:setup` checks this before applying anything.
2. **Databases → Add**: `rasibe`.
3. Put Microsoft's listed root certificates (DigiCert Global Root G2 and Microsoft RSA Root Certificate Authority 2017) in one PEM file and set `PGSSLROOTCERT` to its path.

Sections 3 to 5 are unchanged, with `BACKUP_PGHOST` set to
`<server>.postgres.database.azure.com` and `BACKUP_PGUSER` to `rasibe_owner`.
