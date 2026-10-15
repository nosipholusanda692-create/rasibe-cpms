import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { loadKey } from './crypto.js';

/**
 * Time-based one-time codes (RFC 6238), as produced by Google Authenticator,
 * Microsoft Authenticator and similar apps.
 *
 * HMAC-SHA1 is what those apps implement, and it is not the weakness SHA-1 has
 * elsewhere: an HMAC does not depend on collision resistance, and RFC 6238
 * still specifies it. Choosing SHA-256 would silently break most phones.
 */

export const STEP_SECONDS = 30;
export const DIGITS = 6;

/** Steps either side of now that are accepted, for a phone clock that drifts. */
const WINDOW = 1;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = ALPHABET.indexOf(ch);
    if (index < 0) throw new Error('Not a base32 secret');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160 bits, the length RFC 4226 recommends for HMAC-SHA1. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/** RFC 4226 section 5.3: the counter-based code the time-based one is built on. */
export function hotp(key: Buffer, counter: number, digits = DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function stepAt(timeMs: number): number {
  return Math.floor(timeMs / 1000 / STEP_SECONDS);
}

export function totpAt(secret: string, timeMs: number, digits = DIGITS): string {
  return hotp(base32Decode(secret), stepAt(timeMs), digits);
}

function sameCode(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The step the code belongs to, or null.
 *
 * A step at or before `lastStep` is refused even when the digits are right, so
 * a code seen over someone's shoulder or replayed from a log is spent once.
 */
export function verifyTotp(
  secret: string,
  code: string,
  lastStep: number | null,
  nowMs = Date.now(),
): number | null {
  const digits = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(digits)) return null;

  const key = base32Decode(secret);
  const now = stepAt(nowMs);
  let matched: number | null = null;
  // Every candidate is computed, so the time taken does not say which matched.
  for (let step = now - WINDOW; step <= now + WINDOW; step++) {
    if (sameCode(hotp(key, step), digits) && (lastStep === null || step > lastStep)) {
      matched ??= step;
    }
  }
  return matched;
}

/** What the app reads from the QR code. */
export function otpauthUri(secret: string, account: string, issuer = 'Rasibe CPMS'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString().replace(/\+/g, '%20')}`;
}

// ---------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------

export const RECOVERY_CODE_COUNT = 10;

/**
 * Held as an HMAC under a key the database never sees, so a copy of the table
 * cannot be turned back into codes. A slow hash is unnecessary here: each code
 * is 50 random bits, not something a person chose, so there is no dictionary
 * to work through.
 */
const recoveryKey = loadKey('PASSWORD_PEPPER', 'password-pepper');

/** Ten lower-case base32 characters, shown as two groups of five. */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(randomBytes(7)).slice(0, 10).toLowerCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

export function normaliseRecoveryCode(code: string): string {
  return code.replace(/[\s-]/g, '').toLowerCase();
}

export function looksLikeRecoveryCode(code: string): boolean {
  return /^[a-z2-7]{10}$/.test(normaliseRecoveryCode(code));
}

export function recoveryCodeDigest(code: string): Buffer {
  return createHmac('sha256', recoveryKey)
    .update(`rasibe-recovery-code-v1:${normaliseRecoveryCode(code)}`)
    .digest();
}
