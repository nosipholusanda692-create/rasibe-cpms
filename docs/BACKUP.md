# Backup and restore

RCP-16. Realises NFR-REL-003: a daily backup, a retention period, and a
restore that has actually been carried out.

## A backup is the dump and the three keys

The database dump does not contain everything needed to use it:

| Without | What the restored system does |
| --- | --- |
| `DATA_ENCRYPTION_KEY` | Identity numbers, banking details and vetting outcomes are unreadable ciphertext |
| `DATA_INDEX_KEY` | New identity numbers stop colliding with existing ones, so duplicates get in |
| `PASSWORD_PEPPER` | No current password verifies. Nobody can sign in |

The keys are kept out of the dump on purpose. A key stored with the data it
protects protects nothing. So there are two things to back up, in two places:

1. **The dump**, daily, by `npm run backup`. Stored off the database host.
2. **The three keys**, once, and again whenever one changes. Stored with the
   database password, in a password manager or the hosting platform's secret
   store, and never in the backup directory.

Losing the keys is not recoverable. Losing a dump only costs the days since
the previous one.

## Taking a backup

```
cd server
npm run backup
```

This writes two files into `BACKUP_DIR` (default `backups/`, which git ignores):

- `rasibe-<UTC time>.dump` — `pg_dump` custom format, compressed.
- `rasibe-<UTC time>.json` — the manifest: the dump's SHA-256, the row count
  of every table, and a fingerprint of each of the three keys.

The fingerprint is an HMAC-SHA256 under the key itself, cut to sixteen
characters. It identifies a key without revealing it, which is what lets a
restore say *this is the wrong key* instead of restoring silently and failing
at the first sign-in.

The counts and the dump come from the same exported snapshot, so a backup
taken while people are using the system still restores to exactly the counts
in its manifest.

It connects as the database owner (`BACKUP_PGUSER`, default `postgres`), not
as `rasibe_app`. Row-level security applies to the application role, so a dump
taken as `rasibe_app` would be a partial copy that looks complete. It must also
run with the API's three keys in its environment, or the fingerprints will
describe the wrong keys.

### Daily

Run it from the host's scheduler. On Linux, as the service user:

```
15 2 * * *  cd /srv/rasibe/server && npm run backup >> /var/log/rasibe-backup.log 2>&1
```

Then copy `BACKUP_DIR` off the host. A backup on the same disk as the database
is lost with it. Where a managed PostgreSQL service also takes its own
snapshots, keep this anyway: a platform snapshot cannot be restored anywhere
else, and it does not check the keys.

### Retention

Each run deletes dumps, and their manifests, older than
`BACKUP_RETENTION_DAYS` (default 30). The newest dump is always kept, however
old it is, so a schedule that stopped running does not end with nothing.
Only files this script named are touched.

## Restoring

```
cd server
npm run restore -- backups/rasibe-20261011T021500Z.json rasibe_restored
```

The target must be a new database. Restoring over the live one is never the
script's decision. In order, it:

1. Checks the dump against the manifest's SHA-256. A mismatch stops here and
   nothing is created.
2. Creates the new database and runs `pg_restore`. Tables, row-level security
   policies, triggers, views and grants come back with the data.
3. Verifies the result against the keys in this environment:
   - every table has the row count in the manifest;
   - each key's fingerprint matches the manifest;
   - every encrypted value decrypts;
   - every identity fingerprint is recomputed and matches.

Any failure exits non-zero and names the problem, for example
`PASSWORD_PEPPER in this environment is not the key this backup was taken with.`

To put a verified copy into service, stop the API, then swap names:

```sql
ALTER DATABASE rasibe RENAME TO rasibe_before_restore;
ALTER DATABASE rasibe_restored RENAME TO rasibe;
```

Start the API and sign in. Drop `rasibe_before_restore` once you are sure.

To check an existing database without restoring:

```
npm run restore -- --verify-only backups/rasibe-20261011T021500Z.json rasibe
```

### Without PostgreSQL installed locally

`pg_dump` and `pg_restore` are run as programs. On a machine without them, set
`PG_DOCKER_CONTAINER` to a running PostgreSQL container of the server's major
version or newer (Neon runs 18; `pg_dump` refuses a newer server) and they run inside
it, for example the throwaway database used for tests. A database on this
machine is reached through the container's socket. A database elsewhere (such
as Neon) is reached over the network from inside the container, with
`PGSSLMODE` passed through; with `PGSSLROOTCERT=system` the public root
certificates are installed in the container so the certificate is still
verified. Back up from the remote host, then restore into the local container
by running `restore` with `BACKUP_PGHOST=localhost` and `PGSSLMODE` unset.

```powershell
$env:PG_DOCKER_CONTAINER = 'rasibe-ci'
$env:PGPORT = '55433'
$env:BACKUP_PGPASSWORD = 'postgres'
npm.cmd run backup
```

## Evidence

`.github/workflows/backup-drill.yml` runs `npm run test:backup` on every pull
request and every push to `main`. Against a freshly seeded database it:

- takes a backup and checks the dump, its size, every table's count and the
  three fingerprints, and that no key value appears in the manifest;
- restores it into a new database and verifies it, with every encrypted value
  actually decrypted;
- confirms row-level security is on for the same tables, that `rasibe_app` can
  read the restored accounts, that a peppered password verifies against the
  copy, and that `audit_entry` is still append-only;
- refuses a restore over an existing database, and a dump with one byte
  changed, creating nothing;
- runs the restore check as a separate process with each key replaced in turn
  and requires it to fail naming that key, then pass with the right keys;
- applies retention to dated files and checks what is removed and what is kept,
  including that the newest dump survives.

So the restore is tried on every change, not once by hand.

## Not covered

- **Moving the dump off the host.** That is the hosting platform's storage, and
  there is no host yet. Copy `BACKUP_DIR` somewhere else; until that is done the
  backup and the database share a failure.
- **Point-in-time recovery.** A daily dump loses up to a day. Write-ahead log
  archiving would close that gap and is a platform setting.
- **Encrypting the dump file.** The restricted columns are already ciphertext,
  but names, email addresses, rates and timesheets are not. The backup
  destination needs the same access control as the database.
