# Password hashing

RCP-11, then the pepper and the breached-password check.

## The change

New passwords are hashed with Argon2id. Existing ones stay bcrypt until the
next successful sign-in, which is the only moment the password is known, and
are rewritten then. A wrong password is refused and leaves the stored hash
alone.

The parameters are the OWASP minimum: 19 MiB of memory, two passes, one
thread. They are written into the hash, so raising them later does not lock
anyone out. `needsRehash` compares a stored hash with the current parameters
and the next sign-in rewrites it.

`password_hash` is `varchar(255)`. A peppered Argon2id string at these
parameters is about a hundred and ten characters.

bcrypt stays in the process for one reason: the seed, and any account created
before RCP-11, is a `$2a$` hash produced by pgcrypto. Removing the check would
lock those accounts out.

## Pepper

`PASSWORD_PEPPER` is a 32-byte key in the environment. It is passed to Argon2id
as its secret, so it is mixed into every hash but stored in none of them. A
copy of the database without the running service's configuration cannot be
used to test guesses offline, because each guess also needs the pepper.

It is loaded by the same code as `DATA_ENCRYPTION_KEY`. In development and CI
a fixed value is derived when it is unset. In production the server refuses
to start without it. Hashing without it in production would quietly produce
hashes a stolen database is enough to attack, which is the thing the pepper
is for.

Argon2 does not record whether a secret was used, so a peppered hash is stored
as `$pepper-v1` followed by the normal Argon2 string. That prefix is how the
service knows to supply the pepper, and the version leaves room for a second
pepper later. There are three stored forms:

| Stored form | Written | Next successful sign-in |
| --- | --- | --- |
| `$pepper-v1$argon2id$…` | Now | Nothing to do |
| `$argon2id$…` | Between RCP-11 and the pepper | Rewritten with the pepper |
| `$2a$…` | The seed, through pgcrypto | Rewritten with the pepper |

**Losing the pepper loses every password.** No peppered hash verifies without
it, and there is no recovery short of resetting every account. It has to be
backed up with `DATA_ENCRYPTION_KEY`, in the place RCP-16 defines, not in the
database it protects.

Rotation is not built. A second pepper would be `$pepper-v2`, and both would
have to be loaded until every account had signed in once.

## Breached passwords

A password change asks Have I Been Pwned whether the new password has already
been published. Only the first five hexadecimal characters of its SHA-1 are
sent. The service returns every suffix it holds for that prefix, and the
match is made here. The request asks for padding, so the size of the answer
does not narrow down the prefix either.

SHA-1 is used because that is how the corpus is indexed. It is a lookup key
sent to a third party, not a stored hash. CodeQL's weak-password-hash query may
report it for that reason; it is a correct report of SHA-1 near a password and
a false one about storage.

A match is refused with a field message on `newPassword`. If the service does
not answer within two seconds, or answers with an error, the change is allowed
and a warning without the password is logged. Refusing every change while a
third party is down would hold people on the password they are trying to
leave.

The check runs on a password change, which is the only place a user sets a
password. It does not run at sign-in. Existing passwords were not checked when
they were set, and the seed's `Password123!` is in the corpus.

The composition rules on a new password (ten characters, upper case, lower
case, a number) are unchanged. NIST SP 800-63B recommends length and a breach
check rather than composition. Removing the rules is a separate decision.

## What this does not cover

**The decoy matches peppered Argon2id, not a leftover hash.** Sign-in timing is
equalised against the current form. An account still on bcrypt answers a wrong
password with a different algorithm, so it is distinguishable until that
person signs in successfully once. No production account is in that position.

**Nothing forces old passwords through the breach check.** An account keeps
its password until its owner changes it.

## Evidence

`server/src/test/run.ts`:

- *Password hashing.* A bcrypt hash is due for rewriting. A new hash is
  peppered Argon2id and is not due again. A wrong password against a bcrypt
  account is refused and leaves the hash alone. The correct one signs in and
  rewrites it, and the rewrite signs in on its own.
- *Password pepper.* A peppered hash verifies with the service. The same
  Argon2 string without the pepper does not. An Argon2id hash from before the
  pepper is due for rewriting, still signs in, and is peppered by that sign-in.
- *Breached passwords.* The suite points `PWNED_PASSWORDS_URL` at a local
  stand-in rather than the real service. A listed password is refused. Every
  request carried five hexadecimal characters and never the rest of the hash.
  An unlisted password is accepted and then signs in. A change still goes
  through while the stand-in returns 503.

The timing checks use an account moved to the current form first, so they
compare like with like.
