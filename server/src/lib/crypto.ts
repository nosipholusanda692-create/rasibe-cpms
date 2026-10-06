import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

/**
 * Encryption at rest for restricted personal data (NFR-SEC-005).
 *
 * The keys live in the environment and never reach PostgreSQL. The database
 * stores ciphertext and a blind index, so a copy of the data — a dump, a stolen
 * backup, a managed snapshot — is useless without the running service's
 * configuration. That is the property the requirement is asking for, and it is
 * the reason this is not done with pgcrypto: a key handed to the database in a
 * statement would be recoverable from its logs.
 */

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Development and CI run without configured keys, so the suite and a fresh
 * clone work with no setup. Production does not get that courtesy: a missing
 * key there means the data would be written in clear, which is the failure the
 * requirement exists to prevent.
 */
const DEV_KEY_SEED = 'rasibe-development-key-not-for-production';

function deriveDevKey(purpose: string): Buffer {
  return createHmac('sha256', DEV_KEY_SEED).update(purpose).digest();
}

/** Accepts 64 hex characters or base64, both of which must give 32 bytes. */
function parseKey(raw: string, name: string): Buffer {
  const key = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(`${name} must be 32 bytes, as 64 hex characters or base64. Got ${key.length}.`);
  }
  return key;
}

function loadKey(name: string, purpose: string): Buffer {
  const raw = process.env[name];
  if (raw) return parseKey(raw, name);
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `${name} is not set. Restricted personal data cannot be stored without it. ` +
        'Generate one with: openssl rand -hex 32',
    );
  }
  return deriveDevKey(purpose);
}

const dataKey = loadKey('DATA_ENCRYPTION_KEY', 'data');
const indexKey = loadKey('DATA_INDEX_KEY', 'index');

/** True when the value is already ciphertext this module produced. */
export function isEncrypted(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(`${VERSION}:`);
}

/**
 * Returns `v1:` followed by the nonce, the authentication tag and the
 * ciphertext. The version is there so a future key rotation can tell old values
 * from new ones instead of guessing.
 */
export function encrypt(plain: string | null | undefined): string | null {
  if (plain === null || plain === undefined || plain === '') return null;
  if (isEncrypted(plain)) return plain;

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, dataKey, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
}

/**
 * Values without the prefix are returned untouched. Rows written before this
 * ticket are plaintext until the backfill runs, and a half-migrated table
 * should still be readable rather than throwing in front of a user. The suite
 * asserts separately that no such rows survive, so this tolerance cannot
 * quietly become the normal case.
 */
export function decrypt(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!isEncrypted(value)) return value;

  const raw = Buffer.from(value.slice(VERSION.length + 1), 'base64');
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = raw.subarray(IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, dataKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

/**
 * A deterministic fingerprint, so `id_number` can keep its UNIQUE constraint.
 *
 * Ciphertext is different every time by design, which is what makes a unique
 * index on it useless. This is derived with a separate key: it is exposed to
 * the same database as the ciphertext, and a shared key would let one be used
 * against the other.
 *
 * Spacing and case are removed first, so the same identity number entered two
 * ways still collides.
 */
export function blindIndex(plain: string | null | undefined): string | null {
  if (plain === null || plain === undefined || plain === '') return null;
  const normalised = plain.replace(/[\s-]/g, '').toUpperCase();
  return createHmac('sha256', indexKey).update(normalised).digest('hex');
}
