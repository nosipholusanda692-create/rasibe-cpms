# Release package and deployed-configuration checks

Evidence for how a release is built and what the deployed system refuses.
The test suites (`npm run evidence`, results in `evidence/`) run against a
local database in development mode. This file covers what they cannot: the
package that is actually shipped, and the running site in production mode.

## 1. How the release package is built

The package is built by one workflow, `.github/workflows/deploy-app-service.yml`,
run by hand on `main` (Actions, "Deploy to Azure App Service", Run workflow).
Nothing is built on a laptop, so the package does not depend on one.

| Step | What it does |
| --- | --- |
| Check settings | Stops early if `AZURE_WEBAPP_NAME` or the publish profile secret is missing |
| Build the web client | `npm ci`, `npm run build` in `web/` (`tsc -b && vite build`) |
| Build the mobile app | `npm ci`, `npm run build` in `mobile/`, base path `/m/` |
| Build the server | `npm ci`, `npm run build` in `server/` |
| Assemble | Copies `server/dist`, `web/dist`, `mobile/dist` into `stage/`, and runs `npm ci --omit=dev` there on Linux, because `argon2` ships a native binary per platform |
| Deploy | `azure/webapps-deploy` uploads `stage/` |
| Verify | Calls `/api/health` up to 12 times and passes only when it reports `"database":"connected"` |

Only what runs is shipped: no sources, no tests, no development tools. Every
dependency version comes from the committed lock files (`npm ci`), so the same
commit produces the same package.

To reproduce the build locally without deploying:

```powershell
cd web;    npm ci; npm run build
cd ../mobile; npm ci; npm run build
cd ../server; npm ci; npm run build
```

## 2. CI that gates a change

Every pull request and push to `main` runs these workflows in `.github/workflows/`:

| Workflow | Checks |
| --- | --- |
| `db-tests.yml` | Fresh PostgreSQL 16, applies `db/01` to `db/04`, runs `db/tests.sql` in strict mode |
| `server-ci.yml` | `tsc --noEmit` and the server suites against a seeded database |
| `web-ci.yml` | Web type check and production build |
| `backup-drill.yml` | Backs up, restores and verifies a database with the three keys |
| `dependency-audit.yml` | `npm audit` for shipped dependencies (server and web) |
| `gitleaks.yml` | Secret scan |
| `codeql.yml` | Static analysis for JavaScript and TypeScript, weekly as well |

The run list for a given commit is on the repository's **Actions** tab. For the
submission, attach a screenshot of the runs for the final commit on `main`.

## 3. Deployed-configuration checks

Run against the live site, in production mode (`NODE_ENV=production`), from
outside, with no sign-in. 16 November 2026, 15:40 (UTC+02:00), after the
database moved to a new Neon project.

| Request | Result | What it shows |
| --- | --- | --- |
| `GET /api/health` | 200 | The API is up and reaches the database |
| `GET /api/consultants` | 401 | Data needs a session |
| `GET /api/settings` | 401 | Settings need a session |
| `GET /api/documents?consultantId=...` | 401 | Documents need a session |
| `POST /api/auth/login` with no CSRF token | 403 | A write without the token is refused (NFR-SEC-008) |

Response headers on the sign-in page:

```
Strict-Transport-Security: max-age=31536000; includeSubDomains
Content-Security-Policy: default-src 'self'; ... frame-ancestors 'none'; object-src 'none'; script-src 'self'; upgrade-insecure-requests
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Opener-Policy: same-origin
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
```

No `X-Powered-By` header is sent. `upgrade-insecure-requests` and HSTS appear
only in production, so their presence here confirms the site runs in
production mode, not development.

Also checked by hand the same day, signed in: the four roles land on their own
pages; a PDF uploaded to a consultant's Documents tab (version 1) and
downloaded through a one-time link; the consultant signs in to the mobile app
at `/m/`.

## 4. Not covered here

- The suites that need a database they can write to (`npm test` and the rest)
  are not run against the live database. They create fixture accounts and
  audit entries that cannot be removed afterwards. They run against a
  disposable Neon branch (`docs/DEPLOY.md`, "Running the suites against Neon")
  and in CI.
- Authenticated refusals in production (a recruiter refused the margin report,
  and similar) are asserted by the suites, which run the same code; they were
  not re-run through the live site.
