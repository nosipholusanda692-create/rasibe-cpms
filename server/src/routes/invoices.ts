import { Router } from 'express';
import { z } from 'zod';
import { query, withActor } from '../lib/db.js';
import { badRequest, notFound, conflict, project, assertCapability } from '../lib/errors.js';
import { requireAuth, requireInternal, requireAdmin } from '../middleware/auth.js';
import { audit, queueNotification } from '../services/notify.js';

export const invoicesRouter = Router();
export const dashboardRouter = Router();
export const reportsRouter = Router();

// =====================================================================
// Invoicing (UC-20 to UC-23)
// =====================================================================
invoicesRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const q = z.object({
      status: z.string().optional(),
      clientId: z.string().uuid().optional(),
    }).parse(req.query);

    const params: unknown[] = [];
    const where: string[] = ['1=1'];
    if (q.status) { params.push(q.status.split(',')); where.push(`i.status = ANY($${params.length}::invoice_status_enum[])`); }
    if (q.clientId) { params.push(q.clientId); where.push(`i.client_id = $${params.length}`); }

    const rows = await query<any>(
      req.actor!,
      `SELECT i.invoice_id, i.invoice_number, i.status, i.period_start, i.period_end,
              i.subtotal, i.vat_amount, i.total, i.amount_paid, i.issued_at, i.due_date,
              i.exported_at, cl.client_id, cl.legal_name AS client_name,
              (SELECT count(*)::int FROM invoice_line l WHERE l.invoice_id = i.invoice_id) AS line_count,
              CASE WHEN i.due_date IS NOT NULL AND i.due_date < current_date
                        AND i.status IN ('ISSUED','OVERDUE','PART_PAID')
                   THEN (current_date - i.due_date)::int ELSE 0 END AS days_overdue
         FROM invoice i JOIN client_company cl ON cl.client_id = i.client_id
        WHERE ${where.join(' AND ')}
        ORDER BY i.created_at DESC`,
      params,
    );
    res.json({ items: project(req.actor!.role, rows) });
  } catch (e) { next(e); }
});

invoicesRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const rows = await query<any>(
      req.actor!,
      `SELECT i.*, cl.legal_name AS client_name, cl.billing_address, cl.vat_number,
              cl.registration_number, cl.payment_terms_days,
              coalesce((SELECT json_agg(json_build_object(
                  'lineId', l.invoice_line_id, 'type', l.line_type, 'description', l.description,
                  'quantity', l.quantity, 'unitRate', l.unit_rate, 'lineTotal', l.line_total,
                  'timesheetId', l.timesheet_id))
                FROM invoice_line l WHERE l.invoice_id = i.invoice_id), '[]') AS lines
         FROM invoice i JOIN client_company cl ON cl.client_id = i.client_id
        WHERE i.invoice_id = $1`,
      [id],
    );
    if (!rows.length) throw notFound('Invoice not found');
    res.json(project(req.actor!.role, rows[0]));
  } catch (e) { next(e); }
});

/**
 * Prepare a draft invoice for a client and period (UC-20).
 *
 * Only approved weeks are drawn in, and any week still awaiting approval is
 * reported back so the administrator knows what is being left out rather than
 * discovering it later.
 */
invoicesRouter.post('/prepare', requireAdmin, async (req, res, next) => {
  try {
    const b = z.object({
      clientId: z.string().uuid(),
      periodStart: z.string(),
      periodEnd: z.string(),
    }).parse(req.body);

    const out = await withActor(req.actor!, async (c) => {
      const approved = await c.query(
        `SELECT t.timesheet_id, t.week_start, t.week_end, t.total_standard_hours,
                t.total_overtime_hours, t.bill_rate, t.overtime_multiplier,
                con.full_name AS consultant_name, p.job_title
           FROM timesheet t
           JOIN placement p ON p.placement_id = t.placement_id
           JOIN consultant con ON con.consultant_id = p.consultant_id
          WHERE p.client_id = $1
            AND t.week_start >= $2::date AND t.week_end <= $3::date
            AND t.status = 'APPROVED'
            AND t.invoice_id IS NULL
          ORDER BY con.full_name, t.week_start`,
        [b.clientId, b.periodStart, b.periodEnd]);

      const outstanding = await c.query(
        `SELECT t.timesheet_id, t.week_start, t.status, con.full_name AS consultant_name
           FROM timesheet t
           JOIN placement p ON p.placement_id = t.placement_id
           JOIN consultant con ON con.consultant_id = p.consultant_id
          WHERE p.client_id = $1
            AND t.week_start >= $2::date AND t.week_end <= $3::date
            AND t.status IN ('DRAFT','PENDING_SYNC','SUBMITTED','REJECTED')`,
        [b.clientId, b.periodStart, b.periodEnd]);

      if (!approved.rows.length) {
        return { invoice: null, lines: [], outstanding: outstanding.rows,
                 message: 'There are no approved hours for this client in that period.' };
      }

      const vatRegistered = (await c.query(
        `SELECT setting_value FROM system_setting WHERE setting_key = 'vat_registered'`
      )).rows[0]?.setting_value === 'true';
      const vatRate = vatRegistered
        ? Number((await c.query(`SELECT setting_value FROM system_setting WHERE setting_key = 'vat_rate'`)).rows[0]?.setting_value ?? 0)
        : 0;

      const inv = await c.query(
        `INSERT INTO invoice (client_id, period_start, period_end, status, vat_rate)
         VALUES ($1,$2::date,$3::date,'DRAFT',$4) RETURNING *`,
        [b.clientId, b.periodStart, b.periodEnd, vatRate]);
      const invoiceId = inv.rows[0].invoice_id;

      let subtotal = 0;
      const lines = [];
      for (const t of approved.rows) {
        // the rate held on the timesheet is used, never the current placement rate (BR-008)
        const std = Number(t.total_standard_hours);
        const ot = Number(t.total_overtime_hours);
        const rate = Number(t.bill_rate);

        if (std > 0) {
          const total = +(std * rate).toFixed(2);
          subtotal += total;
          const l = await c.query(
            `INSERT INTO invoice_line (invoice_id, timesheet_id, line_type, description,
                                       quantity, unit_rate, line_total)
             VALUES ($1,$2,'STANDARD',$3,$4,$5,$6) RETURNING *`,
            [invoiceId, t.timesheet_id,
             `${t.consultant_name} — ${t.job_title} — week of ${t.week_start}`, std, rate, total]);
          lines.push(l.rows[0]);
        }
        // overtime is a separate line per rate kind rather than blended in
        if (ot > 0) {
          const otRate = +(rate * Number(t.overtime_multiplier ?? 1.5)).toFixed(2);
          const total = +(ot * otRate).toFixed(2);
          subtotal += total;
          const l = await c.query(
            `INSERT INTO invoice_line (invoice_id, timesheet_id, line_type, description,
                                       quantity, unit_rate, line_total)
             VALUES ($1,$2,'OVERTIME',$3,$4,$5,$6) RETURNING *`,
            [invoiceId, t.timesheet_id,
             `${t.consultant_name} — overtime — week of ${t.week_start}`, ot, otRate, total]);
          lines.push(l.rows[0]);
        }
      }

      const vatAmount = +(subtotal * vatRate / 100).toFixed(2);
      const updated = await c.query(
        `UPDATE invoice SET subtotal = $2, vat_amount = $3, total = $4, status = 'AWAITING_APPROVAL'
          WHERE invoice_id = $1 RETURNING *`,
        [invoiceId, subtotal, vatAmount, +(subtotal + vatAmount).toFixed(2)]);

      return { invoice: updated.rows[0], lines, outstanding: outstanding.rows,
               message: outstanding.rows.length
                 ? `${outstanding.rows.length} week(s) are not yet approved and have been left out.`
                 : 'All approved hours for the period are included.' };
    });

    res.status(out.invoice ? 201 : 200).json(out);
  } catch (e) { next(e); }
});

invoicesRouter.post('/:id/approve', requireAdmin, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const rows = await query<any>(req.actor!,
      `UPDATE invoice SET status = 'APPROVED' WHERE invoice_id = $1 RETURNING *`, [id]);
    if (!rows.length) throw notFound('Invoice not found');
    res.json(project(req.actor!.role, rows[0]));
  } catch (e) { next(e); }
});

/**
 * Issue (UC-21).
 *
 * Writing the invoice and marking its weeks as invoiced happen in one
 * transaction, so the same hours can never be billed twice or lost (NFR-REL-001).
 */
invoicesRouter.post('/:id/issue', requireAdmin, async (req, res, next) => {
  try {
    assertCapability(req.actor!.role, 'issue_invoice');
    const id = z.string().uuid().parse(req.params.id);

    const out = await withActor(req.actor!, async (c) => {
      const cur = await c.query(`SELECT * FROM invoice WHERE invoice_id = $1`, [id]);
      if (!cur.rows.length) throw notFound('Invoice not found');
      if (cur.rows[0].status !== 'APPROVED') {
        throw conflict('An invoice must be approved before it can be issued (BR-010).');
      }

      const issued = await c.query(
        `UPDATE invoice SET status = 'ISSUED', issued_by = $2 WHERE invoice_id = $1 RETURNING *`,
        [id, req.actor!.userId]);

      // same transaction: the weeks become INVOICED and can never be billed again
      await c.query(
        `UPDATE timesheet SET status = 'INVOICED', invoice_id = $1
          WHERE timesheet_id IN (SELECT timesheet_id FROM invoice_line
                                  WHERE invoice_id = $1 AND timesheet_id IS NOT NULL)`,
        [id]);

      await audit(c, {
        actorUserId: req.actor!.userId, action: 'INVOICE_ISSUED',
        entityTable: 'invoice', entityId: id,
        next: { invoiceNumber: issued.rows[0].invoice_number, total: issued.rows[0].total },
      });

      const contact = await c.query(
        `SELECT cc.user_id, cc.email FROM client_contact cc
          WHERE cc.client_id = $1 AND cc.is_primary AND cc.is_active LIMIT 1`,
        [issued.rows[0].client_id]);
      if (contact.rows.length) {
        await queueNotification(c, {
          event: 'INVOICE_ISSUED',
          recipientUserId: contact.rows[0].user_id,
          recipientEmail: contact.rows[0].email,
          vars: {
            number: issued.rows[0].invoice_number,
            period: `${issued.rows[0].period_start} to ${issued.rows[0].period_end}`,
            total: `R ${Number(issued.rows[0].total).toFixed(2)}`,
            due: issued.rows[0].due_date,
          },
          relatedTable: 'invoice', relatedId: id,
        });
      }
      return issued.rows[0];
    });

    res.json(project(req.actor!.role, out));
  } catch (e) { next(e); }
});

/** Correction is a credit note, never an amendment (BR-011). */
invoicesRouter.post('/:id/credit-note', requireAdmin, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const b = z.object({ reason: z.string().min(5, 'Give a reason for the credit note') }).parse(req.body);

    const out = await withActor(req.actor!, async (c) => {
      const orig = await c.query(`SELECT * FROM invoice WHERE invoice_id = $1`, [id]);
      if (!orig.rows.length) throw notFound('Invoice not found');
      if (!['ISSUED', 'OVERDUE', 'PART_PAID', 'PAID'].includes(orig.rows[0].status)) {
        throw conflict('Only an issued invoice can be credited.');
      }

      const cn = await c.query(
        `INSERT INTO invoice (client_id, period_start, period_end, status, vat_rate,
                              subtotal, vat_amount, total, credit_note_for)
         VALUES ($1,$2,$3,'DRAFT',$4,$5,$6,$7,$8) RETURNING *`,
        [orig.rows[0].client_id, orig.rows[0].period_start, orig.rows[0].period_end,
         orig.rows[0].vat_rate, -orig.rows[0].subtotal, -orig.rows[0].vat_amount,
         -orig.rows[0].total, id]);

      const origLines = await c.query(`SELECT * FROM invoice_line WHERE invoice_id = $1`, [id]);
      for (const l of origLines.rows) {
        await c.query(
          `INSERT INTO invoice_line (invoice_id, line_type, description, quantity, unit_rate, line_total)
           VALUES ($1,'CREDIT',$2,$3,$4,$5)`,
          [cn.rows[0].invoice_id, `Credit — ${l.description}`, -l.quantity, l.unit_rate, -l.line_total]);
      }

      await audit(c, {
        actorUserId: req.actor!.userId, action: 'CREDIT_NOTE_RAISED',
        entityTable: 'invoice', entityId: id,
        next: { creditNoteId: cn.rows[0].invoice_id }, reason: b.reason,
      });
      return cn.rows[0];
    });

    res.status(201).json(project(req.actor!.role, out));
  } catch (e) { next(e); }
});

/** Export for the bookkeeper. Records that an export happened, nothing more. */
invoicesRouter.post('/:id/export', requireAdmin, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const out = await withActor(req.actor!, async (c) => {
      const inv = await c.query(
        `SELECT i.*, cl.legal_name FROM invoice i
          JOIN client_company cl ON cl.client_id = i.client_id WHERE i.invoice_id = $1`, [id]);
      if (!inv.rows.length) throw notFound('Invoice not found');
      const lines = await c.query(`SELECT * FROM invoice_line WHERE invoice_id = $1`, [id]);
      await c.query(`UPDATE invoice SET exported_at = now() WHERE invoice_id = $1`, [id]);

      const header = 'invoice_number,client,date,description,quantity,unit_rate,line_total';
      const body = lines.rows.map((l: any) =>
        [inv.rows[0].invoice_number, `"${inv.rows[0].legal_name}"`, inv.rows[0].issued_at?.toISOString?.().slice(0, 10) ?? '',
         `"${l.description}"`, l.quantity, l.unit_rate, l.line_total].join(',')).join('\n');
      return `${header}\n${body}`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="invoice-${id}.csv"`);
    res.send(out);
  } catch (e) { next(e); }
});

invoicesRouter.post('/:id/payment', requireAdmin, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const b = z.object({ amount: z.number().min(0) }).parse(req.body);
    const rows = await query<any>(req.actor!,
      `UPDATE invoice SET amount_paid = amount_paid + $2 WHERE invoice_id = $1 RETURNING *`,
      [id, b.amount]);
    if (!rows.length) throw notFound('Invoice not found');
    res.json(project(req.actor!.role, rows[0]));
  } catch (e) { next(e); }
});

// =====================================================================
// Dashboard (UC-26)
// =====================================================================
dashboardRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const role = req.actor!.role;

    const [timesheets, placements, invoices, requests, expiries, utilisation] = await Promise.all([
      query<any>(req.actor!,
        `SELECT count(*) FILTER (WHERE status = 'SUBMITTED')::int AS awaiting_approval,
                count(*) FILTER (WHERE status IN ('DRAFT','PENDING_SYNC') AND week_end < current_date)::int AS not_submitted,
                count(*) FILTER (WHERE status = 'REJECTED')::int AS rejected,
                count(*) FILTER (WHERE status = 'SUBMITTED' AND current_date - week_end > 7)::int AS overdue
           FROM timesheet`),
      query<any>(req.actor!,
        `SELECT count(*) FILTER (WHERE status IN ('ACTIVE','ENDING_SOON'))::int AS active,
                count(*) FILTER (WHERE status IN ('ACTIVE','ENDING_SOON')
                                 AND end_date <= current_date + 90)::int AS ending_90,
                count(*) FILTER (WHERE status = 'PENDING_RATE_APPROVAL')::int AS pending_rates
           FROM placement`),
      query<any>(req.actor!,
        `SELECT count(*) FILTER (WHERE status IN ('ISSUED','OVERDUE','PART_PAID'))::int AS outstanding_count,
                coalesce(sum(total - amount_paid) FILTER (WHERE status IN ('ISSUED','OVERDUE','PART_PAID')),0) AS outstanding_value,
                count(*) FILTER (WHERE status = 'OVERDUE')::int AS overdue_count
           FROM invoice`),
      query<any>(req.actor!,
        `SELECT count(*) FILTER (WHERE status IN ('OPEN','SHORTLISTING','INTERVIEWING'))::int AS open
           FROM resource_request`),
      query<any>(req.actor!,
        `SELECT count(*)::int AS expiring_30 FROM certification
          WHERE expires_on IS NOT NULL AND expires_on <= current_date + 30`),
      role === 'ADMINISTRATOR'
        ? query<any>(req.actor!, `SELECT * FROM v_report_pool_utilisation`)
        : Promise.resolve([]),
    ]);

    const payload: Record<string, unknown> = {
      timesheets: timesheets[0],
      placements: placements[0],
      invoices: invoices[0],
      requests: requests[0],
      documents: expiries[0],
    };

    // margin is reachable by the administrator alone (BR-006, BR-007)
    if (role === 'ADMINISTRATOR') {
      const margin = await query<any>(req.actor!,
        `SELECT coalesce(sum(revenue),0) AS revenue, coalesce(sum(cost),0) AS cost,
                coalesce(sum(margin),0) AS margin
           FROM v_report_margin_by_placement`);
      payload.margin = margin[0];
      payload.utilisation = utilisation[0];
    }

    res.json(payload);
  } catch (e) { next(e); }
});

// =====================================================================
// Reports (UC-27, UC-28)
// =====================================================================
reportsRouter.get('/margin', requireAdmin, async (req, res, next) => {
  try {
    assertCapability(req.actor!.role, 'view_margin');
    const rows = await query(req.actor!,
      `SELECT * FROM v_report_margin_by_placement ORDER BY margin DESC NULLS LAST`);
    res.json({ items: rows });
  } catch (e) { next(e); }
});

reportsRouter.get('/utilisation', requireInternal, async (req, res, next) => {
  try {
    const rows = await query(req.actor!, `SELECT * FROM v_report_pool_utilisation`);
    res.json(rows[0]);
  } catch (e) { next(e); }
});

reportsRouter.get('/outstanding-timesheets', requireInternal, async (req, res, next) => {
  try {
    const rows = await query(req.actor!,
      `SELECT t.timesheet_id, t.week_start, t.status, con.full_name AS consultant_name,
              cl.legal_name AS client_name, (current_date - t.week_end)::int AS days_since_week_end
         FROM timesheet t
         JOIN placement p ON p.placement_id = t.placement_id
         JOIN consultant con ON con.consultant_id = p.consultant_id
         JOIN client_company cl ON cl.client_id = p.client_id
        WHERE t.status IN ('DRAFT','PENDING_SYNC','SUBMITTED','REJECTED')
          AND t.week_end < current_date
        ORDER BY t.week_start`);
    res.json({ items: rows });
  } catch (e) { next(e); }
});

reportsRouter.get('/placements-ending', requireInternal, async (req, res, next) => {
  try {
    const days = Number(req.query.days ?? 90);
    const rows = await query(req.actor!,
      `SELECT p.placement_id, p.reference, p.end_date, p.status,
              con.full_name AS consultant_name, cl.legal_name AS client_name,
              (p.end_date - current_date)::int AS days_remaining
         FROM placement p
         JOIN consultant con ON con.consultant_id = p.consultant_id
         JOIN client_company cl ON cl.client_id = p.client_id
        WHERE p.status IN ('ACTIVE','ENDING_SOON')
          AND p.end_date <= current_date + $1::int
        ORDER BY p.end_date`, [days]);
    res.json({ items: rows });
  } catch (e) { next(e); }
});

reportsRouter.get('/invoice-ageing', requireInternal, async (req, res, next) => {
  try {
    const rows = await query(req.actor!,
      `SELECT cl.legal_name AS client_name,
              coalesce(sum(i.total - i.amount_paid) FILTER (WHERE i.due_date >= current_date),0) AS current_due,
              coalesce(sum(i.total - i.amount_paid) FILTER (WHERE i.due_date < current_date
                       AND i.due_date >= current_date - 30),0) AS overdue_30,
              coalesce(sum(i.total - i.amount_paid) FILTER (WHERE i.due_date < current_date - 30),0) AS overdue_60_plus
         FROM invoice i JOIN client_company cl ON cl.client_id = i.client_id
        WHERE i.status IN ('ISSUED','OVERDUE','PART_PAID')
        GROUP BY cl.legal_name ORDER BY cl.legal_name`);
    res.json({ items: rows });
  } catch (e) { next(e); }
});

reportsRouter.get('/audit', requireAdmin, async (req, res, next) => {
  try {
    assertCapability(req.actor!.role, 'view_audit');
    const q = z.object({
      entityTable: z.string().optional(),
      entityId: z.string().uuid().optional(),
      limit: z.coerce.number().min(1).max(500).default(100),
    }).parse(req.query);

    const params: unknown[] = [];
    const where: string[] = ['1=1'];
    if (q.entityTable) { params.push(q.entityTable); where.push(`a.entity_table = $${params.length}`); }
    if (q.entityId) { params.push(q.entityId); where.push(`a.entity_id = $${params.length}`); }
    params.push(q.limit);

    const rows = await query(req.actor!,
      `SELECT a.audit_id, a.action, a.entity_table, a.entity_id, a.previous_value,
              a.new_value, a.reason, a.occurred_at, u.full_name AS actor_name
         FROM audit_entry a LEFT JOIN app_user u ON u.user_id = a.actor_user_id
        WHERE ${where.join(' AND ')}
        ORDER BY a.occurred_at DESC LIMIT $${params.length}`, params);
    res.json({ items: rows });
  } catch (e) { next(e); }
});
