# Sign-in hardening

RCP-09. Relates to NFR-SEC-004 and FR-AUT-009.

## The problem

The sign-in form already answered a wrong password and an unknown address with
the same words:

> Email address or password is incorrect

That wording was doing no work at all, because the two answers did not take the
same time to arrive.

Verifying a password with bcrypt is deliberately slow — that slowness is the
point of it. When the address was unknown there was no hash to check, so the
code returned immediately and skipped the expensive part. Measured against this
codebase before the change, with the API and database on one laptop:

| Attempt | Status | Median | Range |
| --- | --- | --- | --- |
| Known address, wrong password | 401 | 146 ms | 136 – 163 ms |
| Unknown address | 401 | 12 ms | 11 – 14 ms |

The ranges do not overlap. No statistics, no repeated sampling, no averaging
over noise: one request per address, and the response time says whether the
account exists. An attacker with a list of email addresses learns which of them
are real, which turns a generic credential-stuffing attempt into a targeted one
against addresses known to exist.

## The change

Every refusal now does the same work. Where there is no password to verify, the
time one would have taken is spent anyway, comparing against a decoy hash that
no password matches. The decoy is built at startup from random bytes that are
not kept, so there is no value that could match it.

Two paths were returning early and both now spend that time:

- the address is unknown, or the account is deactivated
- the account is locked

The second matters for its own reason. A locked account that answered faster
than an unlocked one would tell an attacker which addresses they had already
driven into lockout — in effect, a list of the accounts they had been working
on most successfully.

After the change, on the same machine:

| Attempt | Status | Median | Range |
| --- | --- | --- | --- |
| Known address, wrong password | 401 | 137 ms | 129 – 215 ms |
| Unknown address | 401 | 130 ms | 121 – 168 ms |

Seven milliseconds apart, with the ranges overlapping heavily.

The cost factor used for the decoy has to stay level with the cost used for
real passwords, or the two paths drift apart again. Both are 10.

## The residual

The two paths are close but not identical. A known address with a wrong
password also writes an incremented failure count, which an unknown address has
nothing to write. That is the seven milliseconds.

It is left as it is. Seven milliseconds sits inside the spread of a single
sample on an idle machine, let alone across a network, where ordinary jitter is
larger than the whole remaining signal. Closing it would mean writing a failure
count for an account that does not exist, which trades a measurable property for
a fictional row.

## What this does not cover

**A locked account still answers with 423 and a different message.** Timing is
equalised, but the status code itself discloses that the address exists. That is
a deliberate trade: a legitimate user who has locked themselves out is told so,
rather than being left to retry a password they know is correct. It is recorded
here rather than left implied, and it is a decision that can be reversed by
returning the ordinary refusal instead.

**Per-address throttling is not account enumeration's only route.** Sign-in is
still answerable as fast as bcrypt allows, so an attacker can work through a
list at that rate. Limiting attempts by origin rather than by account is
RCP-10.

## Evidence

`server/src/scripts/measure-login.ts` produces the tables above. It is a
developer tool rather than a test, because a number printed on one laptop is not
an assertion. Run the API, then run the script.

Two things have to be right or its numbers are meaningless, and both were wrong
on the first attempt at writing it:

- sign in is a state-changing request, so it needs a CSRF token. Without one
  every request is refused by the middleware before reaching the handler, and
  all the profiles measure the same refusal. The script prints the status code
  for that reason.
- the lockout counter has to be cleared between samples, or the sixth attempt
  onwards takes the locked branch and the result is an average of two different
  code paths.

The server suite asserts the property rather than the numbers. It compares the
two refusals as a proportion of each other rather than in milliseconds, so the
check means the same thing on a slow shared runner as on a developer laptop:
both paths scale with the cost of the hash, so their ratio does not. It also
asserts that the unknown-address refusal is not a fast path at all, that both
refusals carry the same status, wording and error code, that five failures still
lock the account, that a locked account is not refused faster than a password
check, and that the account signs in again once the lock clears.

Those checks were confirmed to fail against the code as it stood before this
ticket — three of them did, with a measured drift of 0.91 — so they test the
change rather than merely accompanying it.
