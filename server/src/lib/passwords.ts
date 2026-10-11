import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Algorithm, hash, parseOptions, verify, type Options } from '@node-rs/argon2';

/**
 * Argon2id parameters (RCP-11).
 *
 * These are the OWASP minimum: 19 MiB of memory, two passes, one thread.
 * Memory is the part that matters. A hash that is only slow can be sped up by
 * buying more machines; a hash that also demands memory cannot, because the
 * machines run out of RAM before they run out of time.
 *
 * Argon2id rather than Argon2d or Argon2i. The d variant is weaker against a
 * side channel, the i variant is weaker against a GPU. The id hybrid is the
 * one the password-storage guidance recommends.
 *
 * Stored hashes name their own parameters, so a later change to these numbers
 * does not invalidate anyone. The next successful sign-in rewrites the hash.
 */
export const PASSWORD_OPTIONS: Options = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

export function isArgon2(stored: string): boolean {
  return stored.startsWith('$argon2');
}

/** True when the stored hash is not Argon2id at the parameters above. */
export function needsRehash(stored: string): boolean {
  if (!isArgon2(stored)) return true;
  try {
    const parsed = parseOptions(stored);
    return (
      parsed.algorithm !== PASSWORD_OPTIONS.algorithm ||
      parsed.memoryCost !== PASSWORD_OPTIONS.memoryCost ||
      parsed.timeCost !== PASSWORD_OPTIONS.timeCost ||
      parsed.parallelism !== PASSWORD_OPTIONS.parallelism
    );
  } catch {
    return true;
  }
}

export function hashPassword(password: string): Promise<string> {
  return hash(password, PASSWORD_OPTIONS);
}

/**
 * Verifies either form. Seeded and existing accounts are bcrypt, written by
 * pgcrypto as `$2a$`. New and rewritten hashes are Argon2id.
 */
export function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (isArgon2(stored)) return verify(stored, password);
  return bcrypt.compare(password, stored);
}

/**
 * The decoy is Argon2id at the same parameters as a real hash, built once from
 * random bytes that are not kept. An unknown address has nothing to check, so
 * this is what gets checked instead: the refusal takes as long as a wrong
 * password against an account that has already moved to Argon2id.
 *
 * An account still on bcrypt is the exception. Its check is a different
 * algorithm, so its timing does not match, and it stops being the exception
 * at the next successful sign-in. Nothing in production is on bcrypt yet.
 */
let decoyHash: Promise<string> | null = null;

export async function spendDecoyComparison(password: string): Promise<void> {
  decoyHash ??= hashPassword(randomBytes(32).toString('hex'));
  await verify(await decoyHash, password);
}
