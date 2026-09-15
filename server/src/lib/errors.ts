import type { Role } from './db.js';

// ---------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------
export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string = 'error',
    public detail?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (m: string, d?: unknown) => new AppError(400, m, 'bad_request', d);
export const unauthorised = (m = 'Sign in to continue') => new AppError(401, m, 'unauthorised');
export const forbidden = (m = 'You do not have permission to do that') => new AppError(403, m, 'forbidden');
export const notFound = (m = 'Not found') => new AppError(404, m, 'not_found');
export const conflict = (m: string, d?: unknown) => new AppError(409, m, 'conflict', d);

/**
 * Turns a PostgreSQL error into a message a user can act on.
 *
 * The business rules live in the database as constraints and triggers, so this
 * is where those refusals become HTTP responses. The rule identifier is carried
 * through from the constraint name or the trigger message.
 */
export function translateDbError(err: any): AppError {
  const code: string | undefined = err?.code;
  const constraint: string | undefined = err?.constraint;
  const message: string = err?.message ?? 'Database error';

  if (code === '23505') {
    if (constraint === 'uq_submission')
      return conflict('This consultant has already been submitted to this request (BR-022).');
    if (constraint === 'consultant_id_number_key')
      return conflict('A consultant with that identity number already exists.');
    if (constraint === 'consultant_email_key' || constraint === 'app_user_email_key')
      return conflict('That email address is already in use.');
    if (constraint === 'uq_timesheet_week')
      return conflict('A timesheet already exists for that week on this placement.');
    if (constraint === 'timesheet_client_uuid_key')
      return conflict('This submission has already been received.');
    return conflict('That record already exists.');
  }

  if (code === '23P01' && constraint === 'ex_placement_no_overlap') {
    return conflict(
      'This consultant already holds a full-time placement that overlaps these dates (BR-001).',
    );
  }

  if (code === '23514') {
    if (constraint === 'ck_placement_dates')
      return badRequest('The end date must be later than the start date (BR-014).');
    if (constraint === 'ck_placement_margin')
      return badRequest('The bill rate may not be lower than the pay rate.');
    if (constraint === 'ck_reject_reason')
      return badRequest('A rejection requires a reason of at least five characters (BR-005).');
    if (constraint === 'ck_invoice_issued')
      return badRequest('An issued invoice must carry a number, an issuer and a timestamp (BR-010).');
    if (constraint === 'ck_day_total')
      return badRequest('A day may not record more than 24 hours.');
    // trigger-raised rules carry their own message, which already names the rule
    return badRequest(message.replace(/^.*?:\s*/, ''));
  }

  if (code === '23503') return badRequest('That referenced record does not exist.');
  if (code === '42501') return forbidden(message.replace(/^.*?:\s*/, ''));

  return new AppError(500, 'Unexpected database error', 'db_error',
    process.env.NODE_ENV === 'production' ? undefined : message);
}

// ---------------------------------------------------------------------
// Field-level projection
//
// This is the mechanism behind NFR-SEC-003 and NFR-SEC-004. Restricted keys
// are removed on the server before the response is serialised, so they never
// enter the payload and cannot be recovered from network traffic or a
// modified client.
// ---------------------------------------------------------------------
const NEVER_FOR_CONSULTANT = ['bill_rate', 'margin_amount', 'margin', 'revenue', 'proposed_bill_rate'];
const NEVER_FOR_CLIENT = ['pay_rate', 'margin_amount', 'margin', 'cost', 'proposed_pay_rate',
  'min_pay_rate', 'preferred_pay_rate'];
const NEVER_FOR_RECRUITER = ['margin_amount', 'margin', 'bank_name', 'bank_account_ref',
  'vetting_status', 'vetting_cleared_on'];
const ADMIN_ONLY = ['bank_name', 'bank_account_ref', 'id_number', 'vetting_status', 'vetting_cleared_on'];

function stripKeys<T extends Record<string, any>>(row: T, keys: string[]): T {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!keys.includes(k)) out[k] = v;
  }
  return out as T;
}

/** Removes every field the given role may not see. */
export function project<T extends Record<string, any>>(role: Role, row: T): T;
export function project<T extends Record<string, any>>(role: Role, rows: T[]): T[];
export function project(role: Role, input: any): any {
  if (Array.isArray(input)) return input.map((r) => project(role, r));
  if (input === null || typeof input !== 'object') return input;

  switch (role) {
    case 'ADMINISTRATOR':
      return input;
    case 'RECRUITER':
      return stripKeys(input, NEVER_FOR_RECRUITER);
    case 'CONSULTANT':
      return stripKeys(input, [...NEVER_FOR_CONSULTANT, ...ADMIN_ONLY]);
    case 'CLIENT_MANAGER':
      return stripKeys(input, [...NEVER_FOR_CLIENT, ...ADMIN_ONLY, 'mobile', 'email', 'date_of_birth']);
    default:
      return stripKeys(input, [...NEVER_FOR_CONSULTANT, ...NEVER_FOR_CLIENT, ...ADMIN_ONLY]);
  }
}

/** Guard used by routes that must never run for a given role. */
export function assertCapability(role: Role, capability: string): void {
  const map: Record<string, Role[]> = {
    view_margin: ['ADMINISTRATOR'],
    issue_invoice: ['ADMINISTRATOR'],
    approve_rate: ['ADMINISTRATOR'],
    override_approval: ['ADMINISTRATOR'],
    manage_users: ['ADMINISTRATOR'],
    manage_settings: ['ADMINISTRATOR'],
    view_audit: ['ADMINISTRATOR'],
    view_banking: ['ADMINISTRATOR'],
    view_vetting: ['ADMINISTRATOR'],
    manage_consultants: ['ADMINISTRATOR', 'RECRUITER'],
    manage_clients: ['ADMINISTRATOR', 'RECRUITER'],
    submit_candidate: ['ADMINISTRATOR', 'RECRUITER'],
    create_placement: ['ADMINISTRATOR', 'RECRUITER'],
    view_reports: ['ADMINISTRATOR', 'RECRUITER'],
    raise_request: ['ADMINISTRATOR', 'RECRUITER', 'CLIENT_MANAGER'],
    review_candidates: ['ADMINISTRATOR', 'RECRUITER', 'CLIENT_MANAGER'],
    approve_timesheet: ['ADMINISTRATOR', 'CLIENT_MANAGER'],
    submit_timesheet: ['CONSULTANT'],
    manage_own_profile: ['CONSULTANT', 'ADMINISTRATOR', 'RECRUITER'],
  };
  const allowed = map[capability];
  if (!allowed) throw forbidden(`Unknown capability ${capability}`);
  if (!allowed.includes(role)) throw forbidden();
}
