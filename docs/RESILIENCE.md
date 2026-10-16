# Crash resilience

What happens when something goes wrong that nobody typed: the database goes
away, a query hangs, the network drops, a page fails to draw. The aim is that
the system degrades, says so in words a person can act on, and recovers without
someone restarting it.

Each item below is covered by checks in `server/src/test/run.ts` unless it says
otherwise.

## Server

**A dropped database connection no longer ends the process.** In `pg`, an
`error` event on a client that nobody listens for is thrown, and the process
ends. That happens when the database restarts or fails over (routine on a
managed host) while a connection sits idle in the pool, and when a connection
drops while a request is using it. Both are now handled in
`server/src/lib/db.ts`:

- `pool.on('error')` logs the fault for idle clients; the pool discards them.
- `withActor` listens for errors on the client it holds, logs them, and
  releases a client that failed with `release(true)` so the pool destroys it
  instead of handing a dead connection to the next request. A failed `ROLLBACK`
  also marks the client broken.

**A query cannot run forever.** `withActor` sets `statement_timeout` for the
transaction with `set_config(..., true)`, so the database cancels a runaway
statement after `STATEMENT_TIMEOUT_MS` (default 30 s). It is set per
transaction, not as a pool option, because a pool option is sent as a startup
parameter and Neon's pooler rejects it. `QUERY_TIMEOUT_MS` (default 40 s) is a
client-side backstop, `connectionTimeoutMillis` (10 s) stops a request waiting
for a connection that never comes, and TCP keep-alive is on.

**Outages are 503, not 500.** `transientFault` in `server/src/lib/errors.ts`
turns a cancelled statement, a database shutdown or restart, too many
connections and any connection-class (`08`) error into `503 service_unavailable`
with `Retry-After: 5` and a message that says to try again. Everything else
that is not ours stays a 500 with an error reference. This runs before the
constraint-translation step, which is for the person's own mistakes.

**Stray errors and shutdown** (`server/src/lib/resilience.ts`, installed when
the API runs directly):

| Event | What happens |
| --- | --- |
| Unhandled promise rejection | Logged on one line; the process carries on |
| Uncaught exception | Logged, then a graceful shutdown, exit code 1 (state is unknown, so a supervisor restarts it) |
| `SIGTERM` / `SIGINT` | Graceful shutdown, exit code 0 |

A graceful shutdown stops accepting connections, closes idle sockets, lets
running requests finish, closes the pool and exits. It runs once however many
signals arrive, and a forced exit follows after 10 s so a hung request cannot
hold the process open.

**Money is rounded to the cent at every step.** `roundMoney`
(`server/src/lib/money.ts`) rounds half away from zero by shifting the decimal
point through the number's text, because `toFixed(2)` gives `1.00` for `1.005`
and floating-point addition drifts (a thousand lines of R0.10 are not
R100.00 without rounding). Each line total, the running subtotal, the VAT amount
and the grand total are rounded as they are produced, so an invoice's lines
always sum to its subtotal and its subtotal plus VAT always equals its total.
`NaN`, infinity and amounts too large to hold exactly are refused.

**Settings are checked when saved.** `vat_rate` is turned into a number by
invoice preparation and `max_hours_per_day` is cast to `numeric` by a trigger
on every timesheet save, but settings are stored as text. Before the check, an
administrator typing `abc` into either was saved without complaint and then
broke invoicing or timesheet saving for everyone until it was corrected. Every
setting now has a rule in `server/src/lib/settings-rules.ts` (numbers with a
range and a number of decimals, weekday names, a day list, bounded text without
control characters). A value that fails is a 400 saying what is expected, an
unknown setting is a 404, and a value already stored in a bad state makes
invoice preparation answer with an instruction to correct the VAT rate rather
than a total of `NaN`.

## Web

There is no automated test framework for the web client, so these were checked
by hand in the browser (the evidence is the pull request description).

**Requests that cannot reach the server** (`web/src/lib.tsx`). `fetch` rejects
with "Failed to fetch" when there is no connection, and a proxy answering an
outage returns an HTML page that fails JSON parsing as "Unexpected token <".
Both are now an `ApiError` with a message a person can act on, so every screen
that already shows an `ApiError` shows these too:

| Situation | Message |
| --- | --- |
| No connection, server down, connection dropped mid-reply | Can't reach the server. Check your connection and try again. |
| 502, 503, 504, or a 5xx with no JSON body (from something in front of the API) | The service is temporarily unavailable. Please try again in a moment. |
| A success that is not JSON (a proxy's page, a captive portal) | The server sent a reply that could not be read. Please try again. |
| A 500 from the API | The API's message with a short reference that matches the server log |

**Opening the app while the server is down** shows "Can't connect" with a
**Try again** button, not the sign-in page. Without this the person is told
they are signed out, and the sign-in form could not work either. **Try again**
asks again without a reload and, if the browser still holds a session, carries
straight on.

**A page that fails to draw no longer blanks the window.** `ErrorBoundary`
wraps each page inside the shell, keyed by the address, so the menu keeps
working and choosing another page clears the error; a second boundary around
the whole application is the last resort. It shows a message and **Reload the
page** and **Go to the start** buttons, and in development the error text.

**Signing out while the server is unreachable** says so ("You are still signed
in") instead of doing nothing, because the server still holds the session. A
401 from the sign-out call is treated as done: the session was already gone.

**A failed settings save** is shown as an error, not in the green success
banner it used before, and the value stays in the box so it can be corrected.
