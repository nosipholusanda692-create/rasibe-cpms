# Per-address sign-in throttle

RCP-10. Completes FR-AUT-009. Relates to NFR-SEC-004 and FR-AUT-011.

## The problem

An account locks after five failures in fifteen minutes. That stops one attack
and is blind to its mirror image.

| Attack | Shape | Stopped by the lockout |
| --- | --- | --- |
| Brute force | Many passwords against one account | Yes, at the fifth attempt |
| Password spraying | One password against many accounts | No |

A sprayer tries `Password123!` against two hundred addresses in turn. Every
account sees exactly one failure. No counter gets near five, nothing locks,
nothing is logged as unusual, and the attacker needs only one person in two
hundred to have chosen that password. This is the attack that succeeds against
real systems, precisely because it never trips the control that everybody has.

The rows to detect it were already being written. `login_attempt` has recorded
the address on every attempt since the schema was built, for FR-AUT-011. Until
now nothing read them.

## The change

Failures are counted per address as well as per account. Twenty failures from
one address in fifteen minutes and that address is refused, whatever account it
asks about next.

The count is taken **before the account is looked up**. That ordering is what
stops it becoming an account enumeration oracle: the answer depends only on the
caller's own address and is identical whatever address they are guessing at.

## Why twenty and not five

The two counters look alike and measure completely different things.

An account's failures belong to one person. Five is generous for somebody
mistyping their own password.

An address's failures belong to **everyone behind that address**. A client site
behind one corporate NAT, a household, a university, a mobile carrier doing
carrier-grade NAT — all of them are one address to this server. Our client
managers sit at client companies, so every approver at one client shares a
public address. At five, one forgetful person there would lock that client's
entire staff out of approving timesheets, with a message about *their address*
that no user can act on.

The blast radii are not comparable either. A too-tight account lockout
inconveniences one person for fifteen minutes and tells them exactly what
happened. A too-tight address throttle takes out a whole site, and the only way
to diagnose it is to read `login_attempt`.

The security given up is smaller than it looks. Twenty in fifteen minutes is
eighty an hour, so spraying a thousand accounts from one address takes about
twelve hours. Five would make that fifty. Against a single-address attacker
that is a real gain; against anyone with a botnet it is nothing, because they
have thousands of addresses and the per-address budget barely registers.

## What a throttled request gets

`429 Too Many Requests`, with `Retry-After`, and a message that names the
network rather than any account.

It is returned **immediately**, without the decoy comparison that NFR-SEC-004
added to every other refusal. That looks like an exception to the timing rule
and is not. Equalised timing exists to hide whether an account exists; this
response is decided before any account is consulted and so reveals nothing of
the kind. Spending a deliberately slow hash on every request from an address
already known to be attacking would hand that attacker a way to exhaust the
server's CPU — the throttle would become the denial of service it is meant to
prevent.

Because the block is on the address, a correct password from a throttled
address is refused too. That is intentional: an attacker who finally guesses
right is still stopped. It is also the reason the limit has to be generous
enough for a shared office.

## IPv6 is counted by its /64

IPv4 is counted exactly. IPv6 is counted by the first four groups.

A single IPv6 subscriber is routinely handed an entire /64 — eighteen
quintillion addresses — and anyone renting IPv6 capacity can have more for
nothing. Counting exact IPv6 addresses would produce a control an attacker
would never notice, because every request could come from a fresh address.

Two details matter in the implementation and both are asserted. A dual-stack
socket reports IPv4 callers as `::ffff:203.0.113.5`; treating that as IPv6
would widen one caller into a /64 and multiply their budget. And
`2001:0db8:0001:0002::1` and `2001:db8:1:2::1` are the same address written two
ways, so the key is normalised through a number — otherwise an attacker gets
two budgets by varying the spelling.

`login_attempt` keeps both: `ip_address` is still the exact address, for
FR-AUT-011, and `ip_prefix` is what the throttle counts. They differ only for
IPv6.

## The deployment failure mode

**If anything sits in front of the API and `TRUST_PROXY` is not set, this
control will take the whole system down.**

Without it, `req.ip` is the proxy's own address for every request. Every user
shares one bucket, twenty failures from anybody throttles everybody, and the
fifteen-minute window refills only to be emptied again. It is a self-inflicted
denial of service that looks like an outage rather than a misconfiguration.

`TRUST_PROXY` was already on the deployment checklist because it decides what
gets written to `login_attempt`. This ticket promotes it from a logging detail
to an availability requirement. The matching warning in `docs/TLS.md` also
stands: the edge must *overwrite* `X-Forwarded-For` rather than append to a
client-supplied value, or a caller picks their own throttle bucket and steps
around this entirely.

## What this does not cover

**A distributed attack.** Twenty per address is no obstacle to a botnet with
ten thousand addresses, which is one attempt each. Stopping that needs
something that looks across addresses — a global failure rate, or anomaly
detection on the aggregate — and neither is here.

**A slow attack.** Nineteen failures every fifteen minutes, indefinitely, is
never throttled. The window is a rate limit, not a budget.

**Successful sign-ins do not reset the counter.** The window expires on its
own. Letting a success clear the count would hand an attacker who holds one
valid credential a way to reset their own budget at will.

**There is no limit on attempts overall.** Only failures are counted, and only
per address. A flood of requests that never reaches the sign-in handler is a
question for the edge, not for this code.

## Evidence

Thirteen checks in `server/src/test/run.ts` under *Per-address throttle*. Six
cover the address key directly: IPv4 counted exactly, an IPv4-mapped address
not widened, IPv6 grouped by /64, two addresses in one /64 sharing a budget, a
neighbouring /64 kept separate, and leading zeros not producing a second
budget.

The rest drive the real thing. Twenty failures are sent across twenty
*different* addresses, which is the case the account lockout cannot see, and
the suite asserts that none of them is refused for being locked. The
twenty-first request is refused 429, the message names no account, a correct
password from that address is refused as well, `Retry-After` is present, the
address recovers once the window is cleared, and the exact address is still on
the record beside the throttle key.

Four of those were confirmed to fail with the enforcement disabled.

Running that negative pass also found a mistake in the test itself. The check
for a correct password during a throttle was sent as a raw request and came
back `403`, not `401` — CSRF is enforced in middleware, ahead of the route, so
it had never reached the throttle at all. With the throttle enabled it would
have returned `403` as well and the check would have looked like a pass for
entirely the wrong reason.

### The throttle and the timing suite

The two controls pull against each other, which is worth recording.

The NFR-SEC-004 checks take a median of twelve refusals for each of two
addresses: twenty-four failures from one address, more than this throttle
allows. Left alone, the later samples came back as 429s returned without a
comparison — a third code path, and a fast one, which dragged both medians down
and would have hidden a genuine timing difference.

So `timeRefusal` now clears the address budget as well as the account lock
before each sample, for the same reason it already cleared the lock: to keep
every sample on the one code path being measured. It is the same trap that
made the lock clearing necessary in the first place, in a new place.
