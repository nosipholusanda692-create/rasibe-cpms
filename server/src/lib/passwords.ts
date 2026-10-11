import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Algorithm, hash, parseOptions, verify, type Options } from '@node-rs/argon2';
import { loadKey } from './crypto.js';

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

/**
 * The pepper is a key held in the environment and given to Argon2id as its
 * secret. A copy of the database alone cannot be attacked offline, because
 * every guess also needs this value.
 *
 * Losing it is the same as losing every password: nothing peppered verifies
 * without it. It is loaded the way the encryption keys are, so production
 * refuses to start without one rather than quietly hashing without it.
 *
 * The secret is not recorded in the Argon2 string, so the stored value says
 * whether it was used. The version leaves room for a second pepper later.
 */
const pepper = loadKey('PASSWORD_PEPPER', 'password-pepper');
export const PEPPER_MARK = '$pepper-v1';
const PEPPERED_OPTIONS: Options = { ...PASSWORD_OPTIONS, secret: pepper };

export function isPeppered(stored: string): boolean {
  return stored.startsWith(`${PEPPER_MARK}$argon2`);
}

export function isArgon2(stored: string): boolean {
  return stored.startsWith('$argon2') || isPeppered(stored);
}

function argon2Part(stored: string): string {
  return isPeppered(stored) ? stored.slice(PEPPER_MARK.length) : stored;
}

/** True when the stored hash is not peppered Argon2id at the parameters above. */
export function needsRehash(stored: string): boolean {
  if (!isPeppered(stored)) return true;
  try {
    const parsed = parseOptions(argon2Part(stored));
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

export async function hashPassword(password: string): Promise<string> {
  return PEPPER_MARK + (await hash(password, PEPPERED_OPTIONS));
}

/**
 * Verifies every form still stored. Peppered Argon2id is current. Argon2id
 * without the pepper was written between RCP-11 and this change. bcrypt is
 * the seed, written by pgcrypto as `$2a$`. The last two are rewritten at the
 * next successful sign-in.
 */
export function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (isPeppered(stored)) return verify(argon2Part(stored), password, PEPPERED_OPTIONS);
  if (isArgon2(stored)) return verify(stored, password);
  return bcrypt.compare(password, stored);
}

/**
 * The decoy is peppered Argon2id at the same parameters as a real hash, built
 * once from random bytes that are not kept. An unknown address has nothing to
 * check, so this is what gets checked instead: the refusal takes as long as a
 * wrong password against an account that is already current.
 *
 * An account still on bcrypt is the exception. Its check is a different
 * algorithm, so its timing does not match, and it stops being the exception
 * at the next successful sign-in. Nothing in production is on bcrypt yet.
 */
let decoyHash: Promise<string> | null = null;

export async function spendDecoyComparison(password: string): Promise<void> {
  decoyHash ??= hashPassword(randomBytes(32).toString('hex'));
  await verifyPassword(password, await decoyHash);
}
