# Security response headers

RCP-20. Relates to NFR-SEC-012.

## The problem

`helmet` has been in front of every response since RCP-12, and it has been
sending a dozen headers that whole time. The suite asserted one of them.

That is not a vulnerability, but it is the shape a vulnerability arrives in. The
helmet options are a single object in `server/src/index.ts`; narrowing them to
fix something unrelated would drop headers silently, and 140 checks would still
have passed. A control nobody verifies is a control nobody can rely on.

## What is asserted

Taken from a live response rather than from the configuration, so what is
checked is what a browser would actually receive.

| Header | Value | What it stops |
| --- | --- | --- |
| `Content-Security-Policy` | helmet defaults, `frame-ancestors 'none'` | Script and resource loading from anywhere unexpected |
| `X-Frame-Options` | `DENY` | The page being displayed inside someone else's frame |
| `X-Content-Type-Options` | `nosniff` | A response being executed as a type it did not declare |
| `Referrer-Policy` | `no-referrer` | Our URLs leaking to whatever a user visits next |
| `Cross-Origin-Opener-Policy` | `same-origin` | A cross-origin opener keeping a handle on the window |
| `X-Permitted-Cross-Domain-Policies` | `none` | Legacy plugin cross-domain policy files |
| `Strict-Transport-Security` | one year, subdomains | Asserted since RCP-06 |

## The change

Two things moved; the rest were already correct and are now simply held in
place.

**Framing is refused outright.** helmet's default is `SAMEORIGIN`, which permits
our own origin to frame us. Nothing this API serves is ever meant to appear in
a frame, so the honest answer is `DENY`.

**Both framing controls had to move together.** This is the part worth
remembering. `X-Frame-Options` and the CSP `frame-ancestors` directive answer
the same question, and a browser that understands `frame-ancestors` ignores
`X-Frame-Options` completely. helmet's default CSP contains
`frame-ancestors 'self'`. Setting `frameguard` to `deny` on its own would have
produced a response that looked stricter while behaving exactly as before in
every modern browser, and a check that asserted only the `X-Frame-Options`
header would have called that a pass.

**The framework is no longer named.** helmet already removed `X-Powered-By`;
`app.disable('x-powered-by')` states it at the Express level as well, so the
version stays off the wire even if the helmet options are narrowed later.
Naming the framework and its version is a small part of NFR-SEC-012: it tells
an attacker which published advisories are worth trying first.

## What this does not cover

**This CSP protects the API, not the application.** It travels on API
responses, which are JSON, and JSON does not execute scripts. The policy that
governs the React application is whichever one is served alongside
`web/dist/index.html`, and that comes from the static host, not from here. A
strict policy on this API should not be read as the single-page application
being covered — it is not, and arranging that is a deployment task on whatever
ends up serving the built front end.

**`style-src` still allows `'unsafe-inline'`.** That is helmet's default, and
tightening it would break the front end, which uses React inline `style`
props in several places. It is Nosipho's area and a real change rather than a
configuration tweak, so it is recorded here instead of taken.

**`Cross-Origin-Embedder-Policy` is not set.** helmet leaves it off by default.
It is a Spectre mitigation aimed at pages that use cross-origin isolation
features, which this API does not, and enabling it would restrict how resources
can be loaded for no benefit here.

**Headers are not the control, only the reminder.** Every one of these asks the
browser to behave. The protections that do not depend on the client's goodwill
are in the database and the middleware: row-level security, the CSRF token
bound to the session, and the authorisation checks on each route.

## Evidence

Nine checks in `server/src/test/run.ts`, under *Security response headers*. They
read a real response from the running application rather than inspecting the
helmet options.

Two of them were confirmed to fail against the configuration as it stood before
this ticket, reporting `SAMEORIGIN` and a policy containing
`frame-ancestors 'self'`. The other seven passed before the change and pass
after it, which is the point of adding them: they are not testing new behaviour,
they are stopping existing behaviour from disappearing unnoticed.
