# Rasibe mobile

The phone client. Two roles, two jobs: a consultant records hours, a client
manager approves them.

Everything a recruiter or administrator does — consultant search, clients,
placements, invoicing, reporting — stays on the web client. Putting it here
would be the mistake: this app exists for people standing on a client site, not
sitting at a desk.

## Why a progressive web application

The documentation specifies a mobile client. This is built as an installable
PWA rather than a native app, for reasons that are practical rather than
convenient.

The API requires `X-CSRF-Token` on every write, derived from the session and
delivered in a `rasibe_csrf` cookie. A browser carries that automatically.
React Native has no cookie jar semantics by default and sends no `Origin`
header, so going native would mean adding token-based authentication to the
API and weakening a control that currently works.

A PWA inherits the whole security layer unchanged: same origin, same session
cookie, same CSRF token, same helmet headers. It installs to the home screen,
runs full screen, and works offline.

What it gives up: push notifications on iOS require the user to install to the
home screen first, and there is no app store listing. Email remains the primary
notification channel, so neither is load-bearing.

## Running it

The API must be running on port 4000 and the database must be up.

```bash
npm install
npm run dev          # http://localhost:5174
```

To use it from a real phone on the same network, the dev server already listens
on all interfaces. Find your machine's address and open `http://<address>:5174`.

### Demonstration accounts

Password `Password123!` for both. The sign-in screen lists them; tap a row to
fill the form in.

| Role | Email |
| --- | --- |
| Consultant | `thabo.m@example.co.za` |
| Client manager | `s.naidoo@nedgroupit.co.za` |

An administrator or recruiter who signs in here is told to use the web client
rather than shown screens that were never meant for them.

## Offline capture

This is the reason the app exists. Consultants work in client buildings with no
signal, and a system that needs a connection to record hours would not be used.

A week captured offline is held in `localStorage` against a `clientUuid`
generated on the device before any connectivity exists. When a connection
returns the queue is sent to `POST /api/timesheets/sync`, which answers in one
of three ways:

| Outcome | What it means |
| --- | --- |
| `accepted` | The week was written. |
| `already_accepted` | That token had already been processed. Nothing is created, so retransmission is harmless. |
| `conflict` | The office copy has moved on. The server version stands, the local copy is kept, and the consultant is told. |

The failure mode of a bad connection is a **repeated** request, not a lost one,
which is why the operation is keyed by a token rather than simply retried.

A failed write while apparently online is also queued rather than lost: the
connection may have dropped between the check and the send.

### What the service worker does, and does not, do

It caches the application shell so the app opens with no signal. It never
caches API responses. A stale timesheet is worse than no timesheet, and work
that spans a connection gap is carried by the queue, not by the cache.

## Screens

| Screen | Who | Purpose |
| --- | --- | --- |
| Sign in | Both | Session and CSRF token established |
| My week | Consultant | Day rows, quick fill, save or submit |
| Approvals | Client manager | Approve in two taps, reject with a reason |
| Alerts | Both | Notifications raised by the API |
| Account | Both | Placements, anything still queued, sign out |

## Design notes

**A row per day, not a table.** Seven columns on a phone is unusable. Each day
is a full-width row with two number fields.

**Actions at the bottom.** Save and Submit sit above the home indicator, within
thumb reach. This was feedback item FB-01 from the client's own mock-up review:
the controls were too small and too high to use confidently.

**48px targets and 16px inputs.** Above the 44px minimum, and 16px stops iOS
zooming the page when a field takes focus.

**Safe areas respected.** Fixed bars use `env(safe-area-inset-*)` so nothing
hides behind a notch or a home indicator.

**Quick fill.** A standard week is the common case, so it is one tap rather than
seven entries. Weekends and future days are left alone.

## Tests

```bash
# with the API running on port 4000
npx tsx test/mobile.ts
```

43 assertions covering CSRF, rate confidentiality on the device, capture,
approval, rejection and correction, the offline queue including duplicate and
conflict handling, and what the phone must not be able to reach.

They run against the real API and database, not mocks.
