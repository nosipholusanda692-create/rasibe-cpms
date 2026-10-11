import { z } from 'zod';

/**
 * South African identity numbers and bank account references.
 *
 * An identity number is thirteen digits: a date of birth, a sequence, a
 * citizenship digit, a historical digit, and a Luhn check digit. All zeros
 * passes Luhn, which is why that value is refused on its own. The date is
 * read as 19xx when the year is later than this year's last two digits, and
 * as 20xx otherwise, and it has to be a real day that is not still in the
 * future.
 *
 * A bank account reference is not an identity number. South African banks do
 * not share one check digit, so applying Luhn here would refuse real accounts.
 * What is checked is the shape: digits only, a length the banks actually
 * issue, and not all zeros. The masked value stored for the seeded
 * consultants (`****4417`) is a display stand-in, not an account number, and
 * it fails this on purpose.
 *
 * Spaces and hyphens are removed first, which is the same normalisation the
 * blind index uses, so two typings of one number are one number.
 */

const ID_LENGTH = 13;
const ACCOUNT_MIN = 7;
const ACCOUNT_MAX = 16;

export function normaliseDigits(value: string): string {
  return value.replace(/[\s-]/g, '');
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let n = digits.charCodeAt(i) - 48;
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

function dateOfBirth(digits: string, today: Date): Date | null {
  const yearInCentury = Number(digits.slice(0, 2));
  const month = Number(digits.slice(2, 4));
  const day = Number(digits.slice(4, 6));
  const year = (yearInCentury > today.getUTCFullYear() % 100 ? 1900 : 2000) + yearInCentury;
  const born = new Date(Date.UTC(year, month - 1, day));
  if (
    born.getUTCFullYear() !== year
    || born.getUTCMonth() !== month - 1
    || born.getUTCDate() !== day
  ) {
    return null;
  }
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  if (born.getTime() > todayUtc) return null;
  return born;
}

/** Thirteen digits, a real date of birth, not all zeros, and a Luhn check digit. */
export function isValidSaIdNumber(value: string, today = new Date()): boolean {
  const digits = normaliseDigits(value);
  if (!/^\d{13}$/.test(digits)) return false;
  if (/^0+$/.test(digits)) return false;
  if (!luhn(digits)) return false;
  return dateOfBirth(digits, today) !== null;
}

/**
 * Seven to sixteen digits, not all zeros. Seven is the short end of account
 * numbers still in circulation; sixteen covers the longer ones. Anything
 * outside that, or anything that is not digits once spaces and hyphens are
 * removed, is refused.
 */
export function isValidBankAccountRef(value: string): boolean {
  const digits = normaliseDigits(value);
  if (!/^\d+$/.test(digits)) return false;
  if (digits.length < ACCOUNT_MIN || digits.length > ACCOUNT_MAX) return false;
  return !/^0+$/.test(digits);
}

const ID_MESSAGE = 'Enter a valid South African ID number';
const ACCOUNT_MESSAGE = 'Enter the bank account number, digits only';

function asOptionalDigits(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const digits = normaliseDigits(value);
  return digits === '' ? undefined : digits;
}

/** Drop-in for `idNumber` on the consultant body. Blank is treated as omitted. */
export const saIdNumber = z.preprocess(
  asOptionalDigits,
  z.string()
    .length(ID_LENGTH, ID_MESSAGE)
    .regex(/^\d+$/, ID_MESSAGE)
    .refine((value) => isValidSaIdNumber(value), ID_MESSAGE)
    .optional(),
);

/** Drop-in for a bank account reference, on the write path that does not exist yet. */
export const bankAccountRef = z.preprocess(
  asOptionalDigits,
  z.string()
    .regex(/^\d+$/, ACCOUNT_MESSAGE)
    .refine((value) => isValidBankAccountRef(value), ACCOUNT_MESSAGE)
    .optional(),
);
