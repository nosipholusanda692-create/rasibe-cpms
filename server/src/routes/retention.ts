import { Router } from 'express';
import { z } from 'zod';
import { withActor } from '../lib/db.js';
import { badRequest, notFound, conflict, assertCapability } from '../lib/errors.js';
import { requireAdmin, requireInternal } from '../middleware/auth.js';
import { isoDate } from '../lib/validation.js';
import { audit } from '../services/notify.js';
import { anonymiseConsultant, findDue, retentionMonths } from '../lib/retention.js';

/**
 * Retention of unplaced candidates and anonymisation on request.
 *
 * NFR-PRI-004 / BR-021  unplaced candidates are kept only for the configured period
 * NFR-PRI-005           anonymise a consultant's information on request
 *
 * Nothing here runs on a timer. An administrator looks at who is due, then runs
 * it: removal of personal data is not something to happen unattended.
 */
export const retentionRouter = Router();

const MAX_CONSENT_YEARS = 10;

/** Who is due, and under what period. A preview: nothing is changed. */
retentionRouter.get('/', requireAdmin, async (req, res, next) => {
  try {
    assertCapability(req.actor!.role, 'manage_settings');
    const out = await withActor(req.actor!, async (c) => {
      const months = await retentionMonths(c);
      const due = await findDue(c, months, 100);
      return { months, due: due.total, items: due.items };
    });
    res.json(out);
  } catch (e) { next(e); }
});

/** Anonymise every unplaced candidate whose period has passed. */
retentionRouter.post('/run', requireAdmin, async (req, res, next) => {
  try {
    assertCapability(req.actor!.role, 'manage_settings');
    const b = z.object({ dryRun: z.boolean().optional() }).strict().parse(req.body ?? {});

    const { months, due } = await withActor(req.actor!, async (c) => {
      const m = await retentionMonths(c);
      return { months: m, due: await findDue(c, m, 500) };
    });

    if (b.dryRun) {
      res.json({ dryRun: true, months, due: due.total, anonymised: 0, failed: 0 });
      return;
    }

    // One transaction each, so a single record that cannot be anonymised does not
    // hold up, or undo, the others.
    let anonymised = 0;
    let failed = 0;
    for (const row of due.items) {
      try {
        await withActor(req.actor!, (c) => anonymiseConsultant(
          c, req.actor!, row.consultant_id,
          `Retention period of ${months} months passed with no placement (BR-021)`));
        anonymised++;
      } catch { failed++; }
    }
    res.json({ dryRun: false, months, due: due.total, anonymised, failed });
  } catch (e) { next(e); }
});

/** NFR-PRI-005: anonymise one consultant on their request. */
retentionRouter.post('/consultants/:id/anonymise', requireAdmin, async (req, res, next) => {
  try {
    assertCapability(req.actor!.role, 'manage_settings');
    const id = z.string().uuid().parse(req.params.id);
    const b = z.object({
      reason: z.string().trim().min(5, 'Give a reason of at least five characters').max(500),
    }).strict().parse(req.body ?? {});

    const r = await withActor(req.actor!, (c) => anonymiseConsultant(c, req.actor!, id, b.reason));
    res.json({
      consultant_id: r.consultantId,
      anonymised: true,
      invoice_lines_rewritten: r.invoiceLinesRewritten,
      documents_removed: r.documentsRemoved,
      account_closed: r.accountClosed,
    });
  } catch (e) { next(e); }
});

/**
 * BR-021: an unplaced candidate may be kept longer if they consent. The date they
 * agreed to, and how consent was given, are recorded; null withdraws it.
 */
retentionRouter.post('/consultants/:id/consent', requireInternal, async (req, res, next) => {
  try {
    assertCapability(req.actor!.role, 'manage_consultants');
    const id = z.string().uuid().parse(req.params.id);
    const b = z.object({
      retainUntil: isoDate.nullable(),
      reason: z.string().trim().min(5, 'Record how the consultant gave their consent (five characters or more)').max(500),
    }).strict().parse(req.body ?? {});

    const out = await withActor(req.actor!, async (c) => {
      const cur = await c.query(
        `SELECT is_anonymised, to_char(retention_consent_until, 'YYYY-MM-DD') AS until,
                ($2::date IS NOT NULL AND $2::date <= current_date) AS in_past,
                ($2::date IS NOT NULL AND $2::date > current_date + ($3::int || ' years')::interval) AS too_far
           FROM consultant WHERE consultant_id = $1 FOR UPDATE`,
        [id, b.retainUntil, MAX_CONSENT_YEARS]);
      if (!cur.rows.length) throw notFound('Consultant not found');
      const p = cur.rows[0];
      if (p.is_anonymised) throw conflict('This consultant has been anonymised; there is nothing to keep.');
      if (p.in_past) {
        throw badRequest('Check the details you entered', {
          retainUntil: ['The date must be in the future. To withdraw consent, send no date.'],
        });
      }
      if (p.too_far) {
        throw badRequest('Check the details you entered', {
          retainUntil: [`Consent to keep a record cannot run more than ${MAX_CONSENT_YEARS} years ahead.`],
        });
      }

      await c.query(`UPDATE consultant SET retention_consent_until = $2::date WHERE consultant_id = $1`,
        [id, b.retainUntil]);
      await audit(c, {
        actorUserId: req.actor!.userId, action: 'RETENTION_CONSENT_RECORDED',
        entityTable: 'consultant', entityId: id,
        previous: { retention_consent_until: p.until },
        next: { retention_consent_until: b.retainUntil },
        reason: b.reason,
      });
      return { consultant_id: id, retention_consent_until: b.retainUntil };
    });
    res.json(out);
  } catch (e) { next(e); }
});
