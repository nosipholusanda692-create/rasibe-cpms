import { z } from 'zod';

/**
 * Shared rules for query strings, where everything arrives as text.
 *
 * Each value is checked against what the database will accept before it gets
 * there. Without this a malformed value reaches PostgreSQL, fails a cast, and
 * the person sees "something went wrong" instead of what to fix.
 */

/** A calendar date as YYYY-MM-DD, and a real one: 2026-02-30 is refused. */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'That is not a real date');

/**
 * `?flag=true` / `?flag=false`.
 *
 * Not z.coerce.boolean(): that is Boolean(value), and the string "false" is
 * truthy, so `?includeInactive=false` would mean true.
 */
export const queryBool = (fallback?: boolean) =>
  z
    .enum(['true', 'false', '1', '0'], {
      errorMap: () => ({ message: 'Use true or false' }),
    })
    .optional()
    .transform((v) => (v === undefined ? fallback : v === 'true' || v === '1'));

/** A whole number within bounds, from text. */
export const queryInt = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

/** Free-text search, bounded so one request cannot ask for a huge pattern match. */
export const searchText = z.string().trim().max(200);

/** One value, or several separated by commas, each from the list. */
export function enumList(values: readonly string[]) {
  return z
    .string()
    .refine((s) => s.split(',').every((v) => values.includes(v)), {
      message: `Use one or more of: ${values.join(', ')}`,
    });
}

// The values of the database enums the routes filter on (db/01_schema.sql).
export const ROLES = ['ADMINISTRATOR', 'RECRUITER', 'CONSULTANT', 'CLIENT_MANAGER'] as const;
export const SENIORITY = ['JUNIOR', 'INTERMEDIATE', 'SENIOR', 'LEAD', 'PRINCIPAL'] as const;
export const AVAILABILITY = ['AVAILABLE', 'AVAILABLE_FROM', 'ON_PLACEMENT', 'NOT_AVAILABLE'] as const;
export const REQUEST_STATUS = [
  'DRAFT', 'OPEN', 'SHORTLISTING', 'INTERVIEWING', 'FILLED', 'CANCELLED',
] as const;
export const PLACEMENT_STATUS = [
  'PENDING_RATE_APPROVAL', 'PENDING_START', 'ACTIVE', 'ENDING_SOON', 'ENDED', 'TERMINATED', 'RENEWED',
] as const;
export const TIMESHEET_STATUS = [
  'DRAFT', 'PENDING_SYNC', 'SUBMITTED', 'REJECTED', 'APPROVED', 'INVOICED', 'LOCKED',
] as const;
export const INVOICE_STATUS = [
  'DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'ISSUED', 'OVERDUE', 'PART_PAID', 'PAID', 'CANCELLED',
] as const;
