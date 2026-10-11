# Password hashing

RCP-11.

## The change

New passwords are hashed with Argon2id. Existing ones stay bcrypt until the
next successful sign-in, which is the only moment the password is known, and
are rewritten then. A wrong password is refused and leaves the stored hash
alone.

The parameters are the OWASP minimum: 19 MiB of memory, two passes, one
thread. They are written into the hash, so raising them later does not lock
anyone out. `needsRehash` compares a stored hash with the current parameters
and the next sign-in rewrites it.

`password_hash` is `varchar(255)`. An Argon2id string at these parameters is
about a hundred characters.

bcrypt stays in the process for one reason: the seed, and any account created
before this change, is a `$2a$` hash produced by pgcrypto. Removing the check
would lock those accounts out.

## What this does not cover

**A pepper.** An extra secret, held outside the database and mixed in before
hashing, means a stolen database alone cannot be attacked. `@node-rs/argon2`
has a place for that secret. It is a separate change, because it needs its own
key and the same care as `DATA_ENCRYPTION_KEY`: lose it and every password
stops verifying.

**A breach check.** Nothing here asks whether the password has already been
published. That is the HaveIBeenPwned check, which comes after this so there
is one hashing path to add it to.

**The decoy matches Argon2id, not a leftover bcrypt hash.** Sign-in timing is
equalised against the steady state. An account that is still bcrypt answers a
wrong password with a different algorithm, so it is distinguishable until that
person signs in successfully once. No production account is in that position.

## Evidence

`server/src/test/run.ts`, under *Password hashing*. A bcrypt hash is recognised
as due for rewriting. A hash produced now is `$argon2id$` and is not due
again. A wrong password against a bcrypt account is refused and does not
change the stored value. The correct password signs that account in, replaces
the hash, and the replacement signs in on its own.

The timing checks were pointed at an account moved to Argon2id first.
Otherwise they would have compared a bcrypt check with an Argon2id decoy and
failed for a reason that has nothing to do with the two paths drifting.
