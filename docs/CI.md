# Continuous integration

RCP-17. Supporting evidence for the security NFRs rather than a control in its
own right.

## What runs

Five workflows, all on every pull request and on every push to `main`.

| Workflow | Job | What it would catch |
| --- | --- | --- |
| Server CI | `server` | A regression in any of the 132 behavioural checks |
| Database tests | `db-tests` | A row-level security policy that stops holding |
| Secret scan | `gitleaks` | A credential committed to history |
| Dependency audit | `audit` (server, web) | A known flaw in something we ship |
| Web CI | `build` | A front end that no longer compiles |

The first three predate this ticket. The last two are new, and the reason for
each is below.

## Dependency audit

The gate is deliberately narrower than the report.

    npm audit --package-lock-only --omit=dev --audit-level=high

`--omit=dev` is the important half. A flaw in a bundler or a test runner
executes on this runner and on a developer's laptop; it does not reach a user.
Failing the build on it would mean the job went red for something nobody can
act on, and a job that is red for reasons nobody acts on is a job everybody
learns to click past. Those findings are still printed, by a second step that
cannot fail the build, so they stay visible without being load-bearing.

`--package-lock-only` audits the dependency tree as resolved in the lockfile
without installing it. That is both faster and a more honest question: it asks
what we would ship, not what happens to be in `node_modules` on the day.

Finding this job useful required fixing something first. The server was
carrying `proxy-addr` 2.0.7, which has a **critical** advisory for IP address
spoofing. That is not an abstract finding here — RCP-06 put Express behind
`trust proxy` so that `req.ip` identifies the client, the lockout counter is
keyed on what that resolves to, and RCP-10 is about to throttle on it. A flaw
that lets a header forge the address undermines all three. The fix was a patch
release. `qs` and `express` moved by a patch level at the same time. The full
suite was re-run afterwards: 132 passed, 0 failed.

The server now reports zero vulnerabilities at any severity.

## Web CI

`tsc -b && vite build` had only ever been run by hand. Server CI compiles and
tests the API, but nothing in the pipeline compiled the front end at all, so a
change that broke the production build could reach `main` with every check
green. It now runs on every pull request.

## What this does not cover

**No static analysis.** The reference pipeline this was compared against runs
CodeQL. CodeQL's code scanning is free on public repositories; on a private one
it requires GitHub Code Security, a paid add-on. This repository is private, so
the upload step would fail. It is deferred rather than abandoned — see the note
below.

**No dynamic analysis.** Nothing in the pipeline starts the application and
attacks it over HTTP the way an OWASP ZAP baseline scan would. The server suite
exercises the API thoroughly, but it asserts the behaviour we thought to write
down; a baseline scan looks for the categories of problem nobody thought about.

**The audit blocks on severity, not on exploitability.** A high-severity
advisory in a dependency we use in a way the advisory does not describe will
still fail the build, and a moderate one that genuinely affects us will not.
`web` currently carries two moderate `react-router` advisories and neither is
reachable: one is an SSR hydration issue in an application that does no
server-side rendering, and the other is an open redirect through `<Link>` and
`useNavigate`, where every navigation target in this codebase is either a
string literal, a database row identifier, or the `landing` path the server
derives from the signed-in user's role. None of them is attacker-controlled.
Fixing them means `react-router` v6 to v7, which is a breaking change, so it is
recorded here rather than taken.

**Nothing verifies the deployment.** The pipeline proves the code builds and
behaves; it does not prove that what runs in production is what the pipeline
checked.

## Deferred

CodeQL analysis for JavaScript and TypeScript across both projects, pending a
decision on making the repository public. If it stays private, the realistic
substitute is ESLint with the security plugins, which costs nothing and runs
anywhere, and which the reference pipeline also runs alongside CodeQL.
