# Evidence

Dated records of the system building and passing its tests.

```bash
npm run evidence          # rebuilds the database, runs everything
npm run evidence:quick    # skips the rebuild, for a faster check
```

Each run writes `evidence-YYYY-MM-DD-HHMM.md` here: the commit it was taken at,
the schema the committed scripts produce, every suite with its assertion count,
the database checks, the production builds with bundle sizes, and the full
output behind each figure.

Nothing in these files is typed by hand. If a number in a report disagrees with
one here, the file is right.

## Before collecting for a submission

Commit first. The record says so itself if the working tree is dirty, because a
commit hash that does not describe what was run is worse than none.

An administrative database connection is needed for the rebuild — the same one
used for `db/apply.ps1`. On Windows:

```powershell
$env:PGUSER = "postgres"
$env:PGPASSWORD = "your-password"
npm run evidence
```

The suites are deliberately **not** given those credentials. They read
`server/.env` and connect as `rasibe_app`, which cannot bypass row-level
security. Running them as a superuser would make every isolation assertion
meaningless.
