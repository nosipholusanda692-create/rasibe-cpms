# Sessions

A session is a random identifier in the `rasibe_session` cookie (httpOnly,
Secure, SameSite=Lax) that names a row in `user_session`. The role is read from
the database on every request, so a revoked session or a changed role takes
effect at once.

## Two limits

| Limit | Setting | Default | Ends a session that... |
| --- | --- | --- | --- |
| Absolute | `SESSION_TTL_HOURS` | 8 | ...was opened this long ago, however busy |
| Idle | `SESSION_IDLE_MINUTES` | 30 | ...has had no request for this long |

The idle limit is the one that matters for a shared or unattended computer: a
client manager who approves timesheets and walks away from a desk at a client
site leaves nothing usable behind after thirty minutes. Someone actively
working is never interrupted, because each request moves the clock forward.

This is the cookie-session equivalent of a short-lived token with refresh. The
difference is that revocation is immediate: there is no token still valid in
somebody's hands for the rest of its lifetime.

## How it works

`user_session.last_seen_at` records the last request. `loadSession` refuses a
session whose `last_seen_at` is older than the idle limit and **revokes** it,
so raising the setting later cannot bring an abandoned session back.

`last_seen_at` is written at most once a minute per session, so that ordinary
use is not a database write on every request. A session can therefore last up
to a minute longer than the limit, which is not a meaningful difference.

A request with an idle session is answered `401` with
`error: "session_idle"` and a message saying why, so the client can show
"you were signed out after 30 minutes without activity" instead of a bare
sign-in screen. Neither client polls the server, so leaving a page open does
not count as activity; if polling is added later, it should not go through a
signed-in route or it will keep sessions alive indefinitely.

## Other ways a session ends

- signing out;
- signing in again in the same browser (NFR-SEC-010);
- changing the password, which ends every other session;
- turning on two-factor authentication, which ends every other session;
- an administrator suspending the account or resetting its two-factor.

## Applying it to an existing database

`db/migrations-004-idle-timeout.sql`, once, as the owner (the Neon SQL Editor
is enough). Existing sessions start their idle clock from that moment.
