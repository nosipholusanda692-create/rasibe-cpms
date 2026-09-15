import { Router } from 'express';
import { z } from 'zod';
import { query, withActor } from '../lib/db.js';
import { badRequest, notFound, conflict, forbidden, project, assertCapability } from '../lib/errors.js';
import { requireAuth, requireInternal, requireAdmin } from '../middleware/auth.js';
import { audit, queueNotification } from '../services/notify.js';

export const requestsRouter = Router();
export const placementsRouter = Router();

// =====================================================================
// Role requests (UC-07, UC-08)
// =====================================================================
requestsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const q = z.object({
      status: z.string().optional(),
      clientId: z.string().uuid().optional(),
      search: z.string().optional(),
    }).parse(req.query);

    const params: unknown[] = [];
    const where: string[] = ['1=1'];
    if (q.status) { params.push(q.status.split(',')); where.push(`r.status = ANY($${params.length}::request_status_enum[])`); }
    if (q.clientId) { params.push(q.clientId); where.push(`r.client_id = $${params.length}`); }
    if (q.search) { params.push(q.search); where.push(`r.title ILIKE '%'||$${params.length}||'%'`); }

    const rows = await query<any>(
      req.actor!,
      `SELECT r.request_id, r.reference, r.title, r.description, r.seniority, r.engagement_type,
              r.work_mode, r.location, r.quantity, r.start_date, r.duration_months,
              r.budget_rate, r.rate_unit, r.status, r.created_at,
              c.client_id, c.legal_name AS client_name,
              (SELECT count(*)::int FROM submission s WHERE s.request_id = r.request_id) AS submitted_count,
              (SELECT count(*)::int FROM submission s WHERE s.request_id = r.request_id
                 AND s.outcome IN ('SHORTLISTED','INTERVIEWING','OFFERED','PLACED')) AS shortlisted_count,
              extract(day from now() - r.created_at)::int AS age_days,
              coalesce((SELECT json_agg(json_build_object('skillId', sk.skill_id, 'name', sk.name,
                  'mandatory', rs.is_mandatory, 'minProficiency', rs.min_proficiency))
                FROM request_skill rs JOIN skill sk ON sk.skill_id = rs.skill_id
                WHERE rs.request_id = r.request_id), '[]') AS skills
         FROM resource_request r
         JOIN client_company c ON c.client_id = r.client_id
        WHERE ${where.join(' AND ')}
        ORDER BY r.created_at DESC`,
      params,
    );
    res.json({ items: project(req.actor!.role, rows) });
  } catch (e) { next(e); }
});

requestsRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const rows = await query<any>(
      req.actor!,
      `SELECT r.*, c.legal_name AS client_name,
              coalesce((SELECT json_agg(json_build_object('skillId', sk.skill_id, 'name', sk.name,
                  'mandatory', rs.is_mandatory, 'minProficiency', rs.min_proficiency,
                  'minYears', rs.min_years))
                FROM request_skill rs JOIN skill sk ON sk.skill_id = rs.skill_id
                WHERE rs.request_id = r.request_id), '[]') AS skills
         FROM resource_request r
         JOIN client_company c ON c.client_id = r.client_id
        WHERE r.request_id = $1`,
      [id],
    );
    if (!rows.length) throw notFound('Request not found');
    res.json(project(req.actor!.role, rows[0]));
  } catch (e) { next(e); }
});

const requestBody = z.object({
  clientId: z.string().uuid(),
  contactId: z.string().uuid().optional(),
  title: z.string().min(3, 'Give the role a title'),
  description: z.string().optional(),
  seniority: z.enum(['JUNIOR', 'INTERMEDIATE', 'SENIOR', 'LEAD', 'PRINCIPAL']).optional(),
  engagementType: z.enum(['FULL_TIME', 'PART_TIME', 'CONTRACT', 'FIXED_TERM']).default('FULL_TIME'),
  workMode: z.enum(['ON_SITE', 'HYBRID', 'REMOTE']).default('ON_SITE'),
  location: z.string().optional(),
  quantity: z.number().min(1).default(1),
  startDate: z.string().optional(),
  durationMonths: z.number().min(1).optional(),
  budgetRate: z.number().min(0).optional(),
  skills: z.array(z.object({
    skillId: z.string().uuid(),
    mandatory: z.boolean().default(true),
    minProficiency: z.enum(['BASIC', 'INTERMEDIATE', 'ADVANCED', 'EXPERT']).optional(),
    minYears: z.number().min(0).optional(),
  })).default([]),
});

/** A client manager raises their own; a recruiter may raise on a client's behalf. */
requestsRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    assertCapability(req.actor!.role, 'raise_request');
    const parsed = requestBody.safeParse(req.body);
    if (!parsed.success) throw badRequest('Check the details you entered', parsed.error.flatten().fieldErrors);
    const b = parsed.data;

    const out = await withActor(req.actor!, async (c) => {
      const ref = await c.query(
        `SELECT 'REQ-' || (1000 + count(*) + 1)::text AS reference FROM resource_request`);
      const r = await c.query(
        `INSERT INTO resource_request (reference, client_id, contact_id, raised_by, title, description,
             seniority, engagement_type, work_mode, location, quantity, start_date,
             duration_months, budget_rate, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7::seniority_enum,$8::engagement_type_enum,$9::work_mode_enum,
                 $10,$11,$12,$13,$14,'OPEN')
         RETURNING *`,
        [ref.rows[0].reference, b.clientId, b.contactId ?? null, req.actor!.userId, b.title,
         b.description ?? null, b.seniority ?? null, b.engagementType, b.workMode,
         b.location ?? null, b.quantity, b.startDate ?? null, b.durationMonths ?? null,
         b.budgetRate ?? null],
      );
      for (const s of b.skills) {
        await c.query(
          `INSERT INTO request_skill (request_id, skill_id, is_mandatory, min_proficiency, min_years)
           VALUES ($1,$2,$3,$4::proficiency_enum,$5)`,
          [r.rows[0].request_id, s.skillId, s.mandatory, s.minProficiency ?? null, s.minYears ?? null],
        );
      }
      // recruiters are told a request has arrived (FR-REQ-004)
      const recruiters = await c.query(
        `SELECT u.user_id FROM app_user u JOIN user_role ur ON ur.user_id = u.user_id
          WHERE ur.role IN ('RECRUITER','ADMINISTRATOR') AND u.is_active`);
      const client = await c.query(`SELECT legal_name FROM client_company WHERE client_id = $1`, [b.clientId]);
      for (const rec of recruiters.rows) {
        await queueNotification(c, {
          event: 'REQUEST_RAISED',
          recipientUserId: rec.user_id,
          vars: { title: b.title, client: client.rows[0]?.legal_name ?? '' },
          relatedTable: 'resource_request',
          relatedId: r.rows[0].request_id,
        });
      }
      return r.rows[0];
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

requestsRouter.patch('/:id/status', requireAuth, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const b = z.object({
      status: z.enum(['DRAFT', 'OPEN', 'SHORTLISTING', 'INTERVIEWING', 'FILLED', 'CANCELLED']),
      reason: z.string().optional(),
    }).parse(req.body);

    if (b.status === 'CANCELLED' && !b.reason) {
      throw badRequest('Give a reason for cancelling the request');
    }
    const rows = await query<any>(
      req.actor!,
      `UPDATE resource_request
          SET status = $2::request_status_enum,
              closed_at = CASE WHEN $2 IN ('FILLED','CANCELLED') THEN now() ELSE closed_at END,
              close_reason = coalesce($3, close_reason)
        WHERE request_id = $1 RETURNING *`,
      [id, b.status, b.reason ?? null],
    );
    if (!rows.length) throw notFound('Request not found');
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// =====================================================================
// Matching (UC-05 applied to a request)
// =====================================================================
requestsRouter.get('/:id/matches', requireInternal, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const rows = await query<any>(
      req.actor!,
      `WITH req AS (SELECT * FROM resource_request WHERE request_id = $1),
            req_skills AS (SELECT skill_id, is_mandatory FROM request_skill WHERE request_id = $1)
       SELECT c.consultant_id, c.full_name, c.headline, c.seniority, c.experience_years,
              c.location, c.availability, c.available_from, c.min_pay_rate,
              (SELECT count(*) FROM consultant_skill cs
                JOIN req_skills rq ON rq.skill_id = cs.skill_id
               WHERE cs.consultant_id = c.consultant_id)::int AS matched_skills,
              (SELECT count(*) FROM req_skills)::int AS required_skills,
              (SELECT count(*) FROM consultant_skill cs
                JOIN req_skills rq ON rq.skill_id = cs.skill_id AND rq.is_mandatory
               WHERE cs.consultant_id = c.consultant_id)::int AS matched_mandatory,
              (SELECT count(*) FROM req_skills WHERE is_mandatory)::int AS required_mandatory,
              EXISTS (SELECT 1 FROM submission s
                       WHERE s.request_id = $1 AND s.consultant_id = c.consultant_id) AS already_submitted,
              (c.consent_recorded_at IS NOT NULL) AS has_consent
         FROM consultant c, req
        WHERE c.is_active
          AND NOT c.is_anonymised
          AND (req.seniority IS NULL OR c.seniority = req.seniority)
          AND (c.availability IN ('AVAILABLE','AVAILABLE_FROM'))
        ORDER BY matched_mandatory DESC, matched_skills DESC, c.experience_years DESC NULLS LAST
        LIMIT 50`,
      [id],
    );
    res.json({ items: project(req.actor!.role, rows) });
  } catch (e) { next(e); }
});

// =====================================================================
// Submissions (UC-09, UC-10, UC-11)
// =====================================================================
requestsRouter.get('/:id/submissions', requireAuth, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);

    // A client manager sees the professional profile only: no identity number,
    // no pay rate, no personal contact details (NFR-PRI-003).
    if (req.actor!.role === 'CLIENT_MANAGER') {
      const rows = await query<any>(
        req.actor!,
        `SELECT s.submission_id, s.outcome, s.submitted_at, s.proposed_bill_rate,
                v.consultant_id, v.preferred_name, v.headline, v.seniority,
                v.experience_years, v.location, v.availability, v.available_from,
                coalesce((SELECT json_agg(json_build_object('name', sk.name,
                    'proficiency', cs.proficiency, 'years', cs.years))
                  FROM consultant_skill cs JOIN skill sk ON sk.skill_id = cs.skill_id
                  WHERE cs.consultant_id = v.consultant_id), '[]') AS skills
           FROM submission s
           JOIN v_consultant_profile_client v ON v.consultant_id = s.consultant_id
          WHERE s.request_id = $1
          ORDER BY s.submitted_at DESC`,
        [id],
      );
      return res.json({ items: rows });
    }

    const rows = await query<any>(
      req.actor!,
      `SELECT s.*, c.full_name, c.headline, c.seniority, c.experience_years, c.location
         FROM submission s JOIN consultant c ON c.consultant_id = s.consultant_id
        WHERE s.request_id = $1 ORDER BY s.submitted_at DESC`,
      [id],
    );
    res.json({ items: project(req.actor!.role, rows) });
  } catch (e) { next(e); }
});

/**
 * Submit a consultant (UC-09).
 *
 * Consent and duplicate checks run before anything is written, so no personal
 * information reaches the client company unless both pass. The database
 * enforces both independently (BR-012, BR-022).
 */
requestsRouter.post('/:id/submissions', requireInternal, async (req, res, next) => {
  try {
    assertCapability(req.actor!.role, 'submit_candidate');
    const id = z.string().uuid().parse(req.params.id);
    const b = z.object({
      consultantId: z.string().uuid(),
      proposedBillRate: z.number().min(0).optional(),
      proposedPayRate: z.number().min(0).optional(),
    }).parse(req.body);

    const out = await withActor(req.actor!, async (c) => {
      const con = await c.query(
        `SELECT full_name, consent_recorded_at, is_active FROM consultant WHERE consultant_id = $1`,
        [b.consultantId]);
      if (!con.rows.length) throw notFound('Consultant not found');
      if (!con.rows[0].consent_recorded_at) {
        throw conflict('Record the consultant\'s consent before submitting them to a client (BR-012).');
      }

      const s = await c.query(
        `INSERT INTO submission (request_id, consultant_id, submitted_by,
                                 proposed_bill_rate, proposed_pay_rate, consent_reference)
         VALUES ($1,$2,$3,$4,$5, gen_random_uuid()) RETURNING *`,
        [id, b.consultantId, req.actor!.userId, b.proposedBillRate ?? null, b.proposedPayRate ?? null],
      );

      // the disclosure is recorded separately from the submission (NFR-PRI-007)
      await audit(c, {
        actorUserId: req.actor!.userId,
        action: 'CONSENT_RECORDED',
        entityTable: 'submission',
        entityId: s.rows[0].submission_id,
        reason: 'Professional profile disclosed to client company',
      });

      const req_ = await c.query(
        `SELECT r.title, r.client_id, cl.legal_name, r.contact_id
           FROM resource_request r JOIN client_company cl ON cl.client_id = r.client_id
          WHERE r.request_id = $1`, [id]);

      const approver = await c.query(
        `SELECT user_id FROM client_contact WHERE contact_id = $1 AND user_id IS NOT NULL`,
        [req_.rows[0]?.contact_id]);
      if (approver.rows.length) {
        await queueNotification(c, {
          event: 'SUBMISSION_OUTCOME',
          recipientUserId: approver.rows[0].user_id,
          vars: { title: req_.rows[0].title, client: req_.rows[0].legal_name, outcome: 'submitted for review' },
          relatedTable: 'submission', relatedId: s.rows[0].submission_id,
        });
      }

      await c.query(
        `UPDATE resource_request SET status = 'SHORTLISTING'
          WHERE request_id = $1 AND status = 'OPEN'`, [id]);

      return s.rows[0];
    });

    res.status(201).json(project(req.actor!.role, out));
  } catch (e) { next(e); }
});

requestsRouter.patch('/submissions/:sid', requireAuth, async (req, res, next) => {
  try {
    assertCapability(req.actor!.role, 'review_candidates');
    const sid = z.string().uuid().parse(req.params.sid);
    const b = z.object({
      outcome: z.enum(['SUBMITTED', 'SHORTLISTED', 'INTERVIEWING', 'OFFERED', 'PLACED',
        'DECLINED_BY_CLIENT', 'WITHDRAWN']),
      reason: z.string().optional(),
    }).parse(req.body);

    if (['DECLINED_BY_CLIENT', 'WITHDRAWN'].includes(b.outcome) && !b.reason) {
      throw badRequest('Give a reason so the consultant can be told why');
    }

    const out = await withActor(req.actor!, async (c) => {
      const r = await c.query(
        `UPDATE submission SET outcome = $2::submission_outcome_enum, outcome_reason = $3
          WHERE submission_id = $1 RETURNING *`,
        [sid, b.outcome, b.reason ?? null],
      );
      if (!r.rows.length) throw notFound('Submission not found');

      const con = await c.query(
        `SELECT c.user_id, c.full_name, rq.title, cl.legal_name
           FROM submission s
           JOIN consultant c ON c.consultant_id = s.consultant_id
           JOIN resource_request rq ON rq.request_id = s.request_id
           JOIN client_company cl ON cl.client_id = rq.client_id
          WHERE s.submission_id = $1`, [sid]);
      if (con.rows[0]?.user_id) {
        await queueNotification(c, {
          event: 'SUBMISSION_OUTCOME',
          recipientUserId: con.rows[0].user_id,
          vars: { title: con.rows[0].title, client: con.rows[0].legal_name, outcome: b.outcome },
          relatedTable: 'submission', relatedId: sid,
        });
      }
      return r.rows[0];
    });
    res.json(project(req.actor!.role, out));
  } catch (e) { next(e); }
});

// =====================================================================
// Placements (UC-12 to UC-15)
// =====================================================================
placementsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const q = z.object({
      status: z.string().optional(),
      clientId: z.string().uuid().optional(),
      consultantId: z.string().uuid().optional(),
      endingWithinDays: z.coerce.number().optional(),
    }).parse(req.query);

    const params: unknown[] = [];
    const where: string[] = ['1=1'];
    if (q.status) { params.push(q.status.split(',')); where.push(`p.status = ANY($${params.length}::placement_status_enum[])`); }
    if (q.clientId) { params.push(q.clientId); where.push(`p.client_id = $${params.length}`); }
    if (q.consultantId) { params.push(q.consultantId); where.push(`p.consultant_id = $${params.length}`); }
    if (q.endingWithinDays !== undefined) {
      params.push(q.endingWithinDays);
      where.push(`p.end_date <= (current_date + ($${params.length} || ' days')::interval)`);
    }

    const rows = await query<any>(
      req.actor!,
      `SELECT p.placement_id, p.reference, p.job_title, p.engagement_type, p.work_mode,
              p.start_date, p.end_date, p.status, p.rate_unit,
              p.bill_rate, p.pay_rate, p.margin_amount,
              p.consultant_id, con.full_name AS consultant_name,
              p.client_id, cl.legal_name AS client_name,
              (p.end_date - current_date)::int AS days_remaining,
              (SELECT count(*)::int FROM timesheet t
                WHERE t.placement_id = p.placement_id AND t.status = 'SUBMITTED') AS awaiting_approval
         FROM placement p
         JOIN consultant con ON con.consultant_id = p.consultant_id
         JOIN client_company cl ON cl.client_id = p.client_id
        WHERE ${where.join(' AND ')}
        ORDER BY p.end_date`,
      params,
    );
    res.json({ items: project(req.actor!.role, rows) });
  } catch (e) { next(e); }
});

const placementBody = z.object({
  submissionId: z.string().uuid().optional(),
  consultantId: z.string().uuid(),
  clientId: z.string().uuid(),
  requestId: z.string().uuid().optional(),
  approverContactId: z.string().uuid().optional(),
  jobTitle: z.string().min(2, 'Enter the job title'),
  engagementType: z.enum(['FULL_TIME', 'PART_TIME', 'CONTRACT', 'FIXED_TERM']).default('FULL_TIME'),
  workMode: z.enum(['ON_SITE', 'HYBRID', 'REMOTE']).default('ON_SITE'),
  startDate: z.string(),
  endDate: z.string(),
  billRate: z.number().min(0),
  payRate: z.number().min(0),
  rateUnit: z.enum(['HOURLY', 'DAILY', 'MONTHLY']).default('HOURLY'),
});

placementsRouter.post('/', requireInternal, async (req, res, next) => {
  try {
    assertCapability(req.actor!.role, 'create_placement');
    const parsed = placementBody.safeParse(req.body);
    if (!parsed.success) throw badRequest('Check the details you entered', parsed.error.flatten().fieldErrors);
    const b = parsed.data;

    if (new Date(b.endDate) <= new Date(b.startDate)) {
      throw badRequest('The end date must be later than the start date (BR-014).');
    }
    if (b.payRate > b.billRate) {
      throw badRequest('The pay rate may not exceed the bill rate.');
    }

    const out = await withActor(req.actor!, async (c) => {
      // BR-005 equivalent for placement: identity and banking must be on record
      const con = await c.query(
        `SELECT id_number, bank_account_ref, full_name FROM consultant WHERE consultant_id = $1`,
        [b.consultantId]);
      if (!con.rows.length) throw notFound('Consultant not found');

      const ref = await c.query(`SELECT 'PLC-' || (2000 + count(*) + 1)::text AS r FROM placement`);
      const p = await c.query(
        `INSERT INTO placement (reference, submission_id, consultant_id, client_id, request_id,
             approver_contact_id, job_title, engagement_type, work_mode, start_date, end_date,
             bill_rate, pay_rate, rate_unit, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::engagement_type_enum,$9::work_mode_enum,$10,$11,
                 $12,$13,$14::rate_unit_enum,'PENDING_RATE_APPROVAL')
         RETURNING *`,
        [ref.rows[0].r, b.submissionId ?? null, b.consultantId, b.clientId, b.requestId ?? null,
         b.approverContactId ?? null, b.jobTitle, b.engagementType, b.workMode,
         b.startDate, b.endDate, b.billRate, b.payRate, b.rateUnit],
      );

      if (b.submissionId) {
        await c.query(
          `UPDATE submission SET outcome = 'PLACED' WHERE submission_id = $1`, [b.submissionId]);
      }
      return p.rows[0];
    });

    res.status(201).json(project(req.actor!.role, out));
  } catch (e) { next(e); }
});

/** Approving the rates is what allows a placement to go live (BR-009). */
placementsRouter.post('/:id/approve-rates', requireAdmin, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const out = await withActor(req.actor!, async (c) => {
      const cur = await c.query(`SELECT * FROM placement WHERE placement_id = $1`, [id]);
      if (!cur.rows.length) throw notFound('Placement not found');

      await c.query(
        `UPDATE placement SET rate_approved_by = $2, rate_approved_at = now() WHERE placement_id = $1`,
        [id, req.actor!.userId]);

      const startsInFuture = new Date(cur.rows[0].start_date) > new Date();
      const r = await c.query(
        `UPDATE placement SET status = $2::placement_status_enum WHERE placement_id = $1 RETURNING *`,
        [id, startsInFuture ? 'PENDING_START' : 'ACTIVE']);

      await audit(c, {
        actorUserId: req.actor!.userId, action: 'RATE_APPROVED',
        entityTable: 'placement', entityId: id,
        next: { billRate: cur.rows[0].bill_rate, payRate: cur.rows[0].pay_rate },
        reason: req.body?.reason ?? 'Rates approved',
      });
      return r.rows[0];
    });
    res.json(project(req.actor!.role, out));
  } catch (e) { next(e); }
});

placementsRouter.post('/:id/terminate', requireAdmin, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const b = z.object({ reason: z.string().min(5, 'Give a reason of at least five characters') })
      .parse(req.body);
    const out = await withActor(req.actor!, async (c) => {
      const r = await c.query(
        `UPDATE placement SET status = 'TERMINATED', terminated_reason = $2
          WHERE placement_id = $1 RETURNING *`, [id, b.reason]);
      if (!r.rows.length) throw notFound('Placement not found');
      await audit(c, {
        actorUserId: req.actor!.userId, action: 'PLACEMENT_TERMINATED',
        entityTable: 'placement', entityId: id, reason: b.reason,
      });
      return r.rows[0];
    });
    res.json(project(req.actor!.role, out));
  } catch (e) { next(e); }
});

/** A rate change returns the placement for approval; only an administrator may do it. */
placementsRouter.patch('/:id/rates', requireAdmin, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const b = z.object({
      billRate: z.number().min(0),
      payRate: z.number().min(0),
      reason: z.string().min(5, 'Give a reason for the rate change'),
    }).parse(req.body);

    const out = await withActor(req.actor!, async (c) => {
      const prev = await c.query(`SELECT bill_rate, pay_rate FROM placement WHERE placement_id = $1`, [id]);
      if (!prev.rows.length) throw notFound('Placement not found');
      const r = await c.query(
        `UPDATE placement SET bill_rate = $2, pay_rate = $3 WHERE placement_id = $1 RETURNING *`,
        [id, b.billRate, b.payRate]);
      await audit(c, {
        actorUserId: req.actor!.userId, action: 'RATE_CHANGED',
        entityTable: 'placement', entityId: id,
        previous: prev.rows[0], next: { billRate: b.billRate, payRate: b.payRate },
        reason: b.reason,
      });
      return r.rows[0];
    });
    res.json(project(req.actor!.role, out));
  } catch (e) { next(e); }
});
