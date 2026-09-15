import { Router } from 'express';
import { z } from 'zod';
import { query, withActor } from '../lib/db.js';
import { badRequest, notFound, forbidden, conflict, project, assertCapability } from '../lib/errors.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { audit, queueNotification } from '../services/notify.js';

export const timesheetsRouter = Router();

/** Monday of the week containing the given date. */
function weekStart(d: Date): string {
  const copy = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = copy.getUTCDay() === 0 ? 7 : copy.getUTCDay();
  copy.setUTCDate(copy.getUTCDate() - (dow - 1));
  return copy.toISOString().slice(0, 10);
}
function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------
timesheetsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const q = z.object({
      status: z.string().optional(),
      placementId: z.string().uuid().optional(),
      weekStart: z.string().optional(),
      outstanding: z.coerce.boolean().optional(),
    }).parse(req.query);

    const params: unknown[] = [];
    const where: string[] = ['1=1'];
    if (q.status) { params.push(q.status.split(',')); where.push(`t.status = ANY($${params.length}::timesheet_status_enum[])`); }
    if (q.placementId) { params.push(q.placementId); where.push(`t.placement_id = $${params.length}`); }
    if (q.weekStart) { params.push(q.weekStart); where.push(`t.week_start = $${params.length}::date`); }
    if (q.outstanding) where.push(`t.status IN ('DRAFT','PENDING_SYNC','SUBMITTED','REJECTED')`);

    const rows = await query<any>(
      req.actor!,
      `SELECT t.timesheet_id, t.placement_id, t.week_start, t.week_end, t.status,
              t.total_standard_hours, t.total_overtime_hours, t.bill_rate, t.pay_rate,
              t.submitted_at, t.approved_at, t.rejected_reason, t.is_override,
              t.row_version, t.invoice_id,
              p.reference AS placement_reference, p.job_title,
              con.consultant_id, con.full_name AS consultant_name,
              cl.client_id, cl.legal_name AS client_name,
              (cc.first_name || ' ' || cc.last_name) AS approver_name,
              (current_date - t.week_end)::int AS days_since_week_end
         FROM timesheet t
         JOIN placement p ON p.placement_id = t.placement_id
         JOIN consultant con ON con.consultant_id = p.consultant_id
         JOIN client_company cl ON cl.client_id = p.client_id
         LEFT JOIN client_contact cc ON cc.contact_id = p.approver_contact_id
        WHERE ${where.join(' AND ')}
        ORDER BY t.week_start DESC, con.full_name`,
      params,
    );
    res.json({ items: project(req.actor!.role, rows) });
  } catch (e) { next(e); }
});

timesheetsRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const rows = await query<any>(
      req.actor!,
      `SELECT t.*, p.reference AS placement_reference, p.job_title,
              p.standard_hours_per_day, con.full_name AS consultant_name,
              cl.legal_name AS client_name,
              coalesce((SELECT json_agg(json_build_object(
                  'lineId', l.timesheet_line_id, 'workDate', l.work_date,
                  'normalHours', l.normal_hours, 'overtimeHours', l.overtime_hours,
                  'isPublicHoliday', l.is_public_holiday, 'isLeave', l.is_leave, 'note', l.note)
                  ORDER BY l.work_date)
                FROM timesheet_line l WHERE l.timesheet_id = t.timesheet_id), '[]') AS lines
         FROM timesheet t
         JOIN placement p ON p.placement_id = t.placement_id
         JOIN consultant con ON con.consultant_id = p.consultant_id
         JOIN client_company cl ON cl.client_id = p.client_id
        WHERE t.timesheet_id = $1`,
      [id],
    );
    if (!rows.length) throw notFound('Timesheet not found');
    res.json(project(req.actor!.role, rows[0]));
  } catch (e) { next(e); }
});

/**
 * The consultant's own current week, created on demand.
 * A timesheet may only exist against an active placement (BR-002), which the
 * database enforces independently.
 */
timesheetsRouter.get('/my/current', requireAuth, async (req, res, next) => {
  try {
    if (req.actor!.role !== 'CONSULTANT') throw forbidden('Only a consultant has a timesheet of their own');
    const ws = req.query.weekStart ? String(req.query.weekStart) : weekStart(new Date());

    const out = await withActor(req.actor!, async (c) => {
      const placements = await c.query(
        `SELECT p.placement_id, p.reference, p.job_title, p.standard_hours_per_day,
                cl.legal_name AS client_name
           FROM placement p
           JOIN consultant con ON con.consultant_id = p.consultant_id
           JOIN client_company cl ON cl.client_id = p.client_id
          WHERE con.user_id = $1 AND p.status IN ('ACTIVE','ENDING_SOON')`,
        [req.actor!.userId],
      );

      const sheets = [];
      for (const p of placements.rows) {
        let t = await c.query(
          `SELECT * FROM timesheet WHERE placement_id = $1 AND week_start = $2::date`,
          [p.placement_id, ws]);
        if (!t.rows.length) {
          t = await c.query(
            `INSERT INTO timesheet (placement_id, week_start, week_end)
             VALUES ($1,$2::date,($2::date + 6)) RETURNING *`,
            [p.placement_id, ws]);
        }
        const lines = await c.query(
          `SELECT timesheet_line_id, work_date, normal_hours, overtime_hours,
                  is_public_holiday, is_leave, note
             FROM timesheet_line WHERE timesheet_id = $1 ORDER BY work_date`,
          [t.rows[0].timesheet_id]);
        sheets.push({ ...t.rows[0], placement: p, lines: lines.rows });
      }
      return sheets;
    });

    res.json({ weekStart: ws, weekEnd: addDays(ws, 6), items: project(req.actor!.role, out) });
  } catch (e) { next(e); }
});

const lineSchema = z.object({
  workDate: z.string(),
  normalHours: z.number().min(0).max(24),
  overtimeHours: z.number().min(0).max(24).default(0),
  isPublicHoliday: z.boolean().default(false),
  isLeave: z.boolean().default(false),
  note: z.string().max(300).optional(),
});

/** Saves the week without submitting it. Permitted only while it is a draft. */
timesheetsRouter.put('/:id/lines', requireAuth, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const b = z.object({ lines: z.array(lineSchema) }).parse(req.body);

    const out = await withActor(req.actor!, async (c) => {
      const t = await c.query(`SELECT * FROM timesheet WHERE timesheet_id = $1`, [id]);
      if (!t.rows.length) throw notFound('Timesheet not found');
      if (!['DRAFT', 'PENDING_SYNC', 'REJECTED'].includes(t.rows[0].status)) {
        throw conflict('This week has been submitted and can no longer be edited (BR-018).');
      }

      const today = new Date().toISOString().slice(0, 10);
      for (const l of b.lines) {
        if (l.workDate > today) {
          throw badRequest(`Hours cannot be recorded against ${l.workDate}, which is in the future (BR-004).`);
        }
      }

      await c.query(`DELETE FROM timesheet_line WHERE timesheet_id = $1`, [id]);
      for (const l of b.lines) {
        await c.query(
          `INSERT INTO timesheet_line (timesheet_id, work_date, normal_hours, overtime_hours,
                                       is_public_holiday, is_leave, note)
           VALUES ($1,$2::date,$3,$4,$5,$6,$7)`,
          [id, l.workDate, l.normalHours, l.overtimeHours, l.isPublicHoliday, l.isLeave, l.note ?? null],
        );
      }
      if (t.rows[0].status === 'REJECTED') {
        await c.query(`UPDATE timesheet SET status = 'DRAFT' WHERE timesheet_id = $1`, [id]);
      }
      return (await c.query(`SELECT * FROM timesheet WHERE timesheet_id = $1`, [id])).rows[0];
    });

    res.json(project(req.actor!.role, out));
  } catch (e) { next(e); }
});

/** Submit for approval (UC-17). The trigger snapshots the rates (BR-008). */
timesheetsRouter.post('/:id/submit', requireAuth, async (req, res, next) => {
  try {
    assertCapability(req.actor!.role, 'submit_timesheet');
    const id = z.string().uuid().parse(req.params.id);

    const out = await withActor(req.actor!, async (c) => {
      const t = await c.query(
        `SELECT t.*, p.approver_contact_id, p.job_title, con.full_name AS consultant_name
           FROM timesheet t
           JOIN placement p ON p.placement_id = t.placement_id
           JOIN consultant con ON con.consultant_id = p.consultant_id
          WHERE t.timesheet_id = $1`, [id]);
      if (!t.rows.length) throw notFound('Timesheet not found');

      const hours = Number(t.rows[0].total_standard_hours) + Number(t.rows[0].total_overtime_hours);
      if (hours <= 0) throw badRequest('Record some hours before submitting the week.');

      const r = await c.query(
        `UPDATE timesheet SET status = 'SUBMITTED' WHERE timesheet_id = $1 RETURNING *`, [id]);

      const approver = await c.query(
        `SELECT user_id FROM client_contact WHERE contact_id = $1 AND user_id IS NOT NULL`,
        [t.rows[0].approver_contact_id]);
      if (approver.rows.length) {
        await queueNotification(c, {
          event: 'TIMESHEET_AWAITING_APPROVAL',
          recipientUserId: approver.rows[0].user_id,
          vars: {
            consultant: t.rows[0].consultant_name,
            week: t.rows[0].week_start,
            hours: hours.toFixed(2),
          },
          relatedTable: 'timesheet', relatedId: id,
        });
      }
      return r.rows[0];
    });

    res.json(project(req.actor!.role, out));
  } catch (e) { next(e); }
});

/**
 * Approve or reject (UC-18).
 *
 * Rejection requires a reason, enforced both here and by a check constraint,
 * because a rejection without one leaves the consultant unable to correct the
 * week (BR-005).
 */
timesheetsRouter.post('/:id/decision', requireAuth, async (req, res, next) => {
  try {
    assertCapability(req.actor!.role, 'approve_timesheet');
    const id = z.string().uuid().parse(req.params.id);
    const b = z.object({
      decision: z.enum(['APPROVE', 'REJECT']),
      reason: z.string().optional(),
    }).parse(req.body);

    if (b.decision === 'REJECT' && (b.reason ?? '').trim().length < 5) {
      throw badRequest('Give a reason of at least five characters so the week can be corrected (BR-005).');
    }

    const out = await withActor(req.actor!, async (c) => {
      const t = await c.query(
        `SELECT t.*, con.user_id AS consultant_user_id, con.full_name
           FROM timesheet t
           JOIN placement p ON p.placement_id = t.placement_id
           JOIN consultant con ON con.consultant_id = p.consultant_id
          WHERE t.timesheet_id = $1`, [id]);
      if (!t.rows.length) throw notFound('Timesheet not found');
      if (t.rows[0].status !== 'SUBMITTED') {
        throw conflict(`This week is ${t.rows[0].status} and is not awaiting a decision.`);
      }

      const r = await c.query(
        `UPDATE timesheet
            SET status = $2::timesheet_status_enum,
                approved_by = $3,
                rejected_reason = $4
          WHERE timesheet_id = $1 RETURNING *`,
        [id, b.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', req.actor!.userId,
         b.decision === 'REJECT' ? b.reason : null],
      );

      await audit(c, {
        actorUserId: req.actor!.userId,
        action: b.decision === 'APPROVE' ? 'TIMESHEET_APPROVED' : 'TIMESHEET_REJECTED',
        entityTable: 'timesheet', entityId: id,
        previous: { status: 'SUBMITTED' },
        next: { status: r.rows[0].status },
        reason: b.reason,
      });

      if (t.rows[0].consultant_user_id) {
        await queueNotification(c, {
          event: b.decision === 'APPROVE' ? 'TIMESHEET_APPROVED' : 'TIMESHEET_REJECTED',
          recipientUserId: t.rows[0].consultant_user_id,
          vars: { week: t.rows[0].week_start, reason: b.reason ?? '' },
          relatedTable: 'timesheet', relatedId: id,
        });
      }
      return r.rows[0];
    });

    res.json(project(req.actor!.role, out));
  } catch (e) { next(e); }
});

/** Administrator override: returns an approved week for correction (UC-19). */
timesheetsRouter.post('/:id/override', requireAdmin, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const b = z.object({ reason: z.string().min(5, 'Give a reason for the override') }).parse(req.body);

    const out = await withActor(req.actor!, async (c) => {
      const r = await c.query(
        `UPDATE timesheet SET status = 'SUBMITTED' WHERE timesheet_id = $1 RETURNING *`, [id]);
      if (!r.rows.length) throw notFound('Timesheet not found');
      await audit(c, {
        actorUserId: req.actor!.userId, action: 'TIMESHEET_OVERRIDDEN',
        entityTable: 'timesheet', entityId: id, reason: b.reason,
      });
      return r.rows[0];
    });
    res.json(project(req.actor!.role, out));
  } catch (e) { next(e); }
});

/**
 * Offline synchronisation (UC-32, FR-MOB-004 to 008).
 *
 * The device generates a clientUuid before any connectivity exists and keeps it
 * with the pending submission. Three outcomes are possible and all three are
 * normal rather than exceptional:
 *
 *   already_accepted — this token has been processed; return success and
 *                      create nothing, so a repeated transmission is harmless
 *   conflict         — the server row has moved on; the server wins, the local
 *                      copy is kept and the consultant is told
 *   accepted         — the submission is written
 */
timesheetsRouter.post('/sync', requireAuth, async (req, res, next) => {
  try {
    assertCapability(req.actor!.role, 'submit_timesheet');
    const b = z.object({
      clientUuid: z.string().uuid(),
      placementId: z.string().uuid(),
      weekStart: z.string(),
      rowVersion: z.number().int().min(0).default(0),
      submit: z.boolean().default(true),
      lines: z.array(lineSchema),
    }).parse(req.body);

    const out = await withActor(req.actor!, async (c) => {
      // 1. has this exact submission already been accepted?
      const existing = await c.query(
        `SELECT timesheet_id, status, row_version FROM timesheet WHERE client_uuid = $1`,
        [b.clientUuid]);
      if (existing.rows.length) {
        return {
          outcome: 'already_accepted' as const,
          timesheet: existing.rows[0],
          message: 'This week had already been received. No duplicate was created.',
        };
      }

      // 2. find or create the week
      let t = await c.query(
        `SELECT * FROM timesheet WHERE placement_id = $1 AND week_start = $2::date`,
        [b.placementId, b.weekStart]);

      if (!t.rows.length) {
        t = await c.query(
          `INSERT INTO timesheet (placement_id, week_start, week_end, client_uuid, status)
           VALUES ($1,$2::date,($2::date + 6),$3,'PENDING_SYNC') RETURNING *`,
          [b.placementId, b.weekStart, b.clientUuid]);
      } else {
        // 3. the server may have moved on while the device was offline
        const serverVersion = Number(t.rows[0].row_version);
        const movedOn = ['APPROVED', 'INVOICED', 'LOCKED'].includes(t.rows[0].status)
          || serverVersion > b.rowVersion;
        if (movedOn) {
          return {
            outcome: 'conflict' as const,
            timesheet: t.rows[0],
            message:
              `The server copy of this week is ${t.rows[0].status} and is newer than the copy on your device. ` +
              'The server version has been kept. Your local copy has not been discarded.',
          };
        }
        await c.query(
          `UPDATE timesheet SET client_uuid = $2 WHERE timesheet_id = $1`,
          [t.rows[0].timesheet_id, b.clientUuid]);
      }

      const id = t.rows[0].timesheet_id;
      const today = new Date().toISOString().slice(0, 10);
      for (const l of b.lines) {
        if (l.workDate > today) {
          throw badRequest(`Hours cannot be recorded against ${l.workDate}, which is in the future (BR-004).`);
        }
      }

      await c.query(`DELETE FROM timesheet_line WHERE timesheet_id = $1`, [id]);
      for (const l of b.lines) {
        await c.query(
          `INSERT INTO timesheet_line (timesheet_id, work_date, normal_hours, overtime_hours,
                                       is_public_holiday, is_leave, note)
           VALUES ($1,$2::date,$3,$4,$5,$6,$7)`,
          [id, l.workDate, l.normalHours, l.overtimeHours, l.isPublicHoliday, l.isLeave, l.note ?? null]);
      }

      if (b.submit) {
        await c.query(`UPDATE timesheet SET status = 'SUBMITTED' WHERE timesheet_id = $1`, [id]);
      }

      const fresh = await c.query(`SELECT * FROM timesheet WHERE timesheet_id = $1`, [id]);
      return {
        outcome: 'accepted' as const,
        timesheet: fresh.rows[0],
        message: b.submit ? 'Week submitted for approval.' : 'Week saved.',
      };
    });

    res.json({ ...out, timesheet: project(req.actor!.role, out.timesheet) });
  } catch (e) { next(e); }
});
