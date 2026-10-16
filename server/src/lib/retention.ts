/**
 * Retention and anonymisation of consultants.
 *
 * NFR-PRI-004 / BR-021  an unplaced candidate is kept for a configurable period,
 *                       12 months by default, unless they consent to longer.
 * NFR-PRI-005           a consultant's information can be anonymised on request,
 *                       keeping the financial records.
 *
 * Both end in the same operation. A consultant is anonymised, not deleted:
 * placements and submissions refer to them and must stay (financial records are
 * kept, BR-020), and a deleted row would leave those pointing at nothing.
 * Everything that identifies the person goes; what is left is a seniority, a
 * skill set and the history of work done, none of it traceable to anyone.
 *
 * What is NOT reached, and is said so in docs/SECURITY-CONTROLS.md:
 *  - the audit log, which is append-only by design (it records field names and
 *    reasons, not the personal values);
 *  - free text typed by staff elsewhere (a timesheet note, a submission
 *    outcome), which may happen to mention a name;
 *  - backups taken before the anonymisation, which age out on their own
 *    30-day schedule.
 */
import type { PoolClient } from 'pg';
import { conflict, notFound } from './errors.js';
import { audit } from '../services/notify.js';
import type { Actor } from './db.js';

export const DEFAULT_RETENTION_MONTHS = 12;
export const ANONYMISED_NAME = 'Anonymised consultant';

/** Placement states in which the person is, or is about to be, working. */
const LIVE_PLACEMENT = `('PENDING_RATE_APPROVAL','PENDING_START','ACTIVE','ENDING_SOON')`;
/** Submission states in which a client is still considering the person. */
const OPEN_SUBMISSION = `('SUBMITTED','SHORTLISTED','INTERVIEWING','OFFERED')`;

/** The configured retention period for unplaced candidates, in months. */
export async function retentionMonths(c: Pick<PoolClient, 'query'>): Promise<number> {
  const r = await c.query(
    `SELECT setting_value FROM system_setting WHERE setting_key = 'candidate_retention_months'`);
  const n = Number(r.rows[0]?.setting_value);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_RETENTION_MONTHS;
}

/**
 * Unplaced candidates whose retention period has passed.
 *
 * "Unplaced" is strict: no placement of any kind, ever, and no submission a
 * client is still considering. Anybody who has worked for a client belongs to
 * the financial record and is not a candidate for this rule. A consultant who
 * has agreed to be kept longer is not due until that date has passed too.
 */
export async function findDue(c: Pick<PoolClient, 'query'>, months: number, limit = 100) {
  const base = `
    SELECT c.consultant_id, c.full_name, c.created_at,
           GREATEST((c.created_at + ($1::int || ' months')::interval)::date,
                    COALESCE(c.retention_consent_until, '-infinity'::date)) AS due_on
      FROM consultant c
     WHERE NOT c.is_anonymised
       AND NOT EXISTS (SELECT 1 FROM placement p WHERE p.consultant_id = c.consultant_id)
       AND NOT EXISTS (SELECT 1 FROM submission s
                        WHERE s.consultant_id = c.consultant_id AND s.outcome IN ${OPEN_SUBMISSION})`;
  const total = await c.query(`SELECT count(*)::int AS n FROM (${base}) d WHERE d.due_on <= current_date`, [months]);
  const rows = await c.query(
    `SELECT d.consultant_id, d.full_name, d.created_at, d.due_on,
            (current_date - d.due_on)::int AS days_overdue
       FROM (${base}) d
      WHERE d.due_on <= current_date
      ORDER BY d.due_on, d.consultant_id
      LIMIT $2`, [months, limit]);
  return { total: total.rows[0].n as number, items: rows.rows };
}

export interface AnonymiseResult {
  consultantId: string;
  invoiceLinesRewritten: number;
  documentsRemoved: number;
  /** Storage keys of removed documents, so the caller can delete the files. */
  documentKeys: string[];
  accountClosed: boolean;
}

/**
 * Anonymises one consultant inside the caller's transaction, and audits it.
 * The audit entry names what was cleared, never the values.
 */
export async function anonymiseConsultant(
  c: PoolClient,
  actor: Actor,
  consultantId: string,
  reason: string,
): Promise<AnonymiseResult> {
  const cur = await c.query(
    `SELECT consultant_id, full_name, email, user_id, is_anonymised
       FROM consultant WHERE consultant_id = $1 FOR UPDATE`, [consultantId]);
  if (!cur.rows.length) throw notFound('Consultant not found');
  const person = cur.rows[0];
  if (person.is_anonymised) throw conflict('This consultant has already been anonymised.');

  // Somebody still working, or about to start, cannot vanish from under a client.
  const live = await c.query(
    `SELECT count(*)::int AS n FROM placement
      WHERE consultant_id = $1 AND status IN ${LIVE_PLACEMENT}`, [consultantId]);
  if (live.rows[0].n > 0) {
    throw conflict('This consultant has a placement that is not finished. End or complete it first.');
  }

  // 1. The record. Seniority, experience, skills and the rate unit stay: they
  //    describe a kind of consultant, not a person. The email is replaced rather
  //    than blanked because the column is required and unique.
  await c.query(
    `UPDATE consultant SET
        full_name = $2, preferred_name = NULL,
        email = 'anonymised-' || consultant_id::text || '@anonymised.invalid',
        id_number = NULL, id_number_bidx = NULL, date_of_birth = NULL,
        mobile = NULL, location = NULL, nationality = NULL, right_to_work = NULL,
        headline = NULL, source = NULL,
        min_pay_rate = NULL, preferred_pay_rate = NULL,
        vetting_status = NULL, vetting_cleared_on = NULL,
        bank_name = NULL, bank_account_ref = NULL,
        consent_recorded_at = NULL, retention_expires_on = NULL, retention_consent_until = NULL,
        is_active = false, is_anonymised = true
      WHERE consultant_id = $1`,
    [consultantId, ANONYMISED_NAME]);

  // 2. Things that hold the person's details and nothing else of value.
  await c.query(`DELETE FROM certification WHERE consultant_id = $1`, [consultantId]);
  const docs = await c.query(
    `DELETE FROM document WHERE consultant_id = $1 RETURNING storage_key`, [consultantId]);
  await c.query(
    `DELETE FROM notification
      WHERE ($1::uuid IS NOT NULL AND recipient_user_id = $1::uuid)
         OR lower(recipient_email) = lower($2)`,
    [person.user_id, person.email]);

  // 3. Invoices are kept, because they are financial records, and their money
  //    never changes (BR-011). The words on a line are the one place the name
  //    was copied to, so it is replaced there.
  const lines = await c.query(
    `UPDATE invoice_line il
        SET description = replace(il.description, $2, $3)
      WHERE position($2 in il.description) > 0
        AND il.timesheet_id IN (
              SELECT t.timesheet_id FROM timesheet t
                JOIN placement p ON p.placement_id = t.placement_id
               WHERE p.consultant_id = $1)`,
    [consultantId, person.full_name, ANONYMISED_NAME]);

  // 4. The sign-in account, if they had one: closed, scrubbed and unusable.
  let accountClosed = false;
  if (person.user_id) {
    await c.query(
      `UPDATE app_user SET
          is_active = false, full_name = 'Anonymised user',
          email = 'anonymised-' || user_id::text || '@anonymised.invalid',
          phone = NULL, password_hash = '!',
          totp_secret = NULL, totp_pending_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL,
          failed_logins = 0, locked_until = NULL
        WHERE user_id = $1`, [person.user_id]);
    await c.query(`UPDATE user_session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
      [person.user_id]);
    await c.query(`DELETE FROM account_token WHERE user_id = $1`, [person.user_id]);
    await c.query(`DELETE FROM login_challenge WHERE user_id = $1`, [person.user_id]);
    await c.query(`DELETE FROM recovery_code WHERE user_id = $1`, [person.user_id]);
    accountClosed = true;
  }

  const result: AnonymiseResult = {
    consultantId,
    invoiceLinesRewritten: lines.rowCount ?? 0,
    documentsRemoved: docs.rows.length,
    documentKeys: docs.rows.map((d: any) => d.storage_key),
    accountClosed,
  };

  await audit(c, {
    actorUserId: actor.userId, action: 'CONSULTANT_ANONYMISED',
    entityTable: 'consultant', entityId: consultantId,
    previous: { anonymised: false },
    next: {
      anonymised: true,
      invoiceLinesRewritten: result.invoiceLinesRewritten,
      documentsRemoved: result.documentsRemoved,
      accountClosed,
    },
    reason,
  });
  return result;
}
