# Two-factor authentication

A second factor after the password: a six-digit code from an authenticator app
(Google Authenticator, Microsoft Authenticator, Authy and similar), or one of
ten single-use recovery codes when the phone is not to hand.

The server side is complete and tested (`npm run test:2fa`, 78 checks). The
web client and the mobile app both have the screens (see "Web screens" and
"Mobile screens" below). The setting that makes it compulsory for
administrators is off.

## How it works

**Codes.** RFC 6238: HMAC-SHA1, six digits, a new code every 30 seconds. One
step either side of now is accepted, for a phone clock that drifts. SHA-1 is
what the apps implement; inside an HMAC it does not rely on collision
resistance, which is the property that is broken. `lib/totp.ts` uses
`node:crypto` only and is checked against the RFC's own test vectors.

**Storage.** The secret is encrypted with `DATA_ENCRYPTION_KEY`, the same
AES-256-GCM scheme as the identity and banking fields (`docs/ENCRYPTION.md`).
Recovery codes are stored as an HMAC under `PASSWORD_PEPPER`, so neither a
database dump nor a backup is enough to produce a valid code. The challenge
between the two sign-in steps is stored as a SHA-256, like the invitation and
reset tokens.

**Replay.** The last accepted 30-second step is recorded. A code at or before
it is refused even with the right digits, so a code seen over a shoulder is
spent once. Spending is a conditional `UPDATE`, so two requests racing with
the same code cannot both succeed.

**Lockout.** A wrong code counts toward the same five-failure lockout as a
wrong password. A correct password does not reset the count; only a correct
code does. A challenge allows five attempts and lasts five minutes.

**Sessions.** No session exists until both factors are right, and the session
is created by the same code path as a password-only sign-in, so session
rotation (NFR-SEC-010) and the CSRF token behave identically. Turning
two-factor on signs the account out everywhere else, because those sessions
were opened with the password alone.

**Audit.** `TWO_FACTOR_ENABLED`, `TWO_FACTOR_DISABLED`, `TWO_FACTOR_RESET` and
`RECOVERY_CODE_USED` are written to `audit_entry`.

## Lost phone

The person uses a recovery code. If they have none left, an administrator
resets their two-factor with a reason, which is recorded in the audit trail.
The reset removes the secret and the recovery codes and signs the person out
everywhere; they then sign in with their password and enrol again.

An administrator cannot reset their own. If they could, the second factor would
be optional on exactly the accounts where it matters most. Rasibe therefore
needs at least two administrators once `REQUIRE_ADMIN_2FA` is on, or a lost
administrator phone needs the database owner to clear the four `totp_` columns
on `app_user` and delete that person's `recovery_code` rows.

## Requiring it for administrators

`REQUIRE_ADMIN_2FA=true` holds an administrator who has not enrolled at
enrolment. They can reach `/api/auth/me`, sign-out, `/api/auth/2fa/setup` and
`/api/auth/2fa/enable`. Everything else answers `403` with
`error: "two_factor_enrolment_required"`. While it is on, an administrator
cannot turn their own two-factor off. Other roles are not affected; for them it
stays optional.

Leave it off until a build of the web client with the screens below is
deployed. Switched on before then, administrators would have no way to enrol.

## Web screens

- **Sign in.** After a correct password for an account with two-factor, the
  form asks for the code. A wrong code can be retried; an expired challenge
  goes back to the password step with a message. Signing in with a recovery
  code when three or fewer are left shows a warning until it is dismissed.
- **Sign-in security** (`/account/security`, every role, under Account in the
  menu). Turn on: password, then a QR code with the key underneath, then a
  code from the app, then the ten recovery codes with download and copy. Done
  stays disabled until the person ticks that they have saved them. Turn off:
  password and a code, with a confirmation.
- **Required.** While `REQUIRE_ADMIN_2FA` holds an administrator, every page
  redirects to Sign-in security until they have enrolled.
- **User accounts.** "Two-factor on" under the status, and a Reset 2FA button
  on other people's accounts that asks for the reason.

## Mobile screens

Consultants and client managers are the only roles that use the mobile app, and
both can turn two-factor on there. The behaviour matches the web screens.

- **Sign in.** The password step, then "Enter your code" for an account with
  two-factor. The field accepts the six digits or a recovery code. A wrong code
  can be retried; an expired challenge returns to the password step with a
  message. "Use a different account" abandons the challenge. After a recovery
  code, a bar warns when three or fewer remain.
- **Sign-in security** (`/account/security`, reached from the Account tab, which
  shows On or Off). Turn on: password, QR code with the key underneath for
  typing it in by hand, a code from the app, then the ten recovery codes with
  copy and download. Done stays disabled until the person ticks that they have
  saved them. Turn off: password and a code.
- The QR code is drawn on the phone from the `otpauth` link (`qrcode` package);
  the key is never sent to a third party.
- Administrators and recruiters still cannot sign in to the mobile app, so
  `REQUIRE_ADMIN_2FA` does not affect it.

## API, for the client screens

All under `/api/auth`, all writes need the CSRF header as usual.

### Signing in

`POST /login` with `{ email, password }`:

- without two-factor: unchanged, `{ user, landing }`;
- with two-factor: `{ twoFactorRequired: true }` and an httpOnly cookie
  `rasibe_2fa`. No session yet. Show the code screen.

`POST /login/verify` with `{ code }`, where the code is six digits or a
recovery code (spaces, hyphens and case do not matter):

| Answer | Meaning |
| --- | --- |
| `200 { user, landing }` | Signed in. With a recovery code, also `recoveryCodesRemaining`; warn when it is low. |
| `401 two_factor_invalid` | Wrong code. Let them try again. |
| `401 two_factor_expired` | More than five minutes, or five wrong codes. Back to the password screen. |
| `423 locked` | The account is locked. Same message as for passwords. |

### Settings screen

`GET /me` now includes `twoFactor: { enabled, required }`. `required` is true
for an administrator while the setting is on; show the enrolment screen first.

`POST /2fa/setup` with `{ currentPassword }` returns `{ secret, otpauthUri }`.
Draw `otpauthUri` as a QR code and show `secret` underneath for typing in by
hand. Nothing is switched on yet.

`POST /2fa/enable` with `{ code }` returns `{ recoveryCodes }`, ten of them,
once. Show them with a prompt to save or print them; they cannot be shown
again. A wrong code is `400` with a message on `detail.code`.

`POST /2fa/disable` with `{ currentPassword, code }`. Either kind of code
works.

### Users screen (administrators)

`POST /2fa/reset/:userId` with `{ reason }`, at least 10 characters. `403` on
one's own account, `409` if that person has no two-factor to reset.

## Applying it to an existing database

A rebuild from `01` to `04` already includes everything. For a database built
before this change, such as the Neon one, run
`db/migrations-003-two-factor.sql` once as the owner: paste it into the Neon
SQL Editor, or use `psql` with the owner connection. It is safe to run twice.
