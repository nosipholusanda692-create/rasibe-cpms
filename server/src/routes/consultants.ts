import { Router } from 'express';
import { z } from 'zod';
import { query, withActor } from '../lib/db.js';
import { badRequest, notFound, forbidden, project, assertCapability } from '../lib/errors.js';
import { requireAuth, requireInternal } from '../middleware/auth.js';
import { audit } from '../services/notify.js';
// NFR-SEC-005. The identity number is encrypted before it reaches the database.
// Reads need nothing here: project() decrypts on the way out.
import { encrypt, blindIndex } from '../lib/crypto.js';

export const consultantsRouter = Router();

/**
 * Consultant search (UC-05).
 *
 * Deactivated consultants are excluded here rather than filtered in the
 * interface, so a stale result set cannot be used to submit somebody who has
 * been removed from the pool (BR-017).
 */
consultantsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const q = z
      .object({
        search: z.string().optional(),
        skill: z.string().uuid().optional(),
        seniority: z.string().optional(),
        availability: z.string().optional(),
        availableFrom: z.string().optional(),
        maxRate: z.coerce.number().optional(),
        location: z.string().optional(),
        page: z.coerce.number().min(1).default(1),
        pageSize: z.coerce.number().min(1).max(100).default(25),
      })
      .parse(req.query);

    // A client manager may only ever see the anonymous professional profile
    // (NFR-PRI-003), so they read from the restricted view.
    if (req.actor!.role === 'CLIENT_MANAGER') {
      const rows = await query(
        req.actor!,
        `SELECT * FROM v_consultant_profile_client
          WHERE ($1::text IS NULL OR headline ILIKE '%'||$1||'%')
          ORDER BY seniority DESC NULLS LAST
          LIMIT $2 OFFSET $3`,
        [q.search ?? null, q.pageSize, (q.page - 1) * q.pageSize],
      );
      return res.json({ items: rows, page: q.page, pageSize: q.pageSize });
    }

    const params: unknown[] = [];
    const where: string[] = ['c.is_active', 'NOT c.is_anonymised'];

    if (q.search) {
      params.push(q.search);
      where.push(`(c.full_name ILIKE '%'||$${params.length}||'%'
                   OR c.headline ILIKE '%'||$${params.length}||'%'
                   OR c.email ILIKE '%'||$${params.length}||'%')`);
    }
    if (q.skill) {
      params.push(q.skill);
      where.push(`EXISTS (SELECT 1 FROM consultant_skill cs
                          WHERE cs.consultant_id = c.consultant_id AND cs.skill_id = $${params.length})`);
    }
    if (q.seniority) {
      params.push(q.seniority);
      where.push(`c.seniority = $${params.length}::seniority_enum`);
    }
    if (q.availability) {
      params.push(q.availability);
      where.push(`c.availability = $${params.length}::availability_enum`);
    }
    if (q.availableFrom) {
      // available now, or becoming available on or before the date asked for
      params.push(q.availableFrom);
      where.push(`(c.availability = 'AVAILABLE'
                   OR (c.availability = 'AVAILABLE_FROM' AND c.available_from <= $${params.length}::date))`);
    }
    if (q.maxRate !== undefined) {
      params.push(q.maxRate);
      where.push(`coalesce(c.min_pay_rate, 0) <= $${params.length}`);
    }
    if (q.location) {
      params.push(q.location);
      where.push(`c.location ILIKE '%'||$${params.length}||'%'`);
    }

    params.push(q.pageSize, (q.page - 1) * q.pageSize);

    const rows = await query<any>(
      req.actor!,
      `SELECT c.consultant_id, c.full_name, c.preferred_name, c.headline, c.seniority,
              c.experience_years, c.location, c.availability, c.available_from,
              c.min_pay_rate, c.preferred_pay_rate, c.rate_unit, c.email, c.mobile,
              c.vetting_status,
              coalesce(json_agg(json_build_object(
                'skillId', s.skill_id, 'name', s.name,
                'proficiency', cs.proficiency, 'years', cs.years)
                ORDER BY cs.is_primary DESC, cs.years DESC)
                FILTER (WHERE s.skill_id IS NOT NULL), '[]') AS skills
         FROM consultant c
         LEFT JOIN consultant_skill cs ON cs.consultant_id = c.consultant_id
         LEFT JOIN skill s ON s.skill_id = cs.skill_id
        WHERE ${where.join(' AND ')}
        GROUP BY c.consultant_id
        ORDER BY c.full_name
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    const total = await query<{ n: number }>(
      req.actor!,
      `SELECT count(*)::int AS n FROM consultant c WHERE ${where.join(' AND ')}`,
      params.slice(0, params.length - 2),
    );

    res.json({
      items: project(req.actor!.role, rows),
      total: total[0]?.n ?? rows.length,
      page: q.page,
      pageSize: q.pageSize,
    });
  } catch (e) {
    next(e);
  }
});

consultantsRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);

    if (req.actor!.role === 'CLIENT_MANAGER') {
      const rows = await query(req.actor!,
        `SELECT * FROM v_consultant_profile_client WHERE consultant_id = $1`, [id]);
      if (!rows.length) throw notFound('Consultant not found');
      return res.json(rows[0]);
    }

    const rows = await query<any>(
      req.actor!,
      `SELECT c.*,
              coalesce((SELECT json_agg(json_build_object(
                 'skillId', s.skill_id, 'name', s.name, 'category', s.category,
                 'proficiency', cs.proficiency, 'years', cs.years,
                 'lastUsedYear', cs.last_used_year, 'isPrimary', cs.is_primary)
                 ORDER BY cs.is_primary DESC, cs.years DESC)
               FROM consultant_skill cs JOIN skill s ON s.skill_id = cs.skill_id
               WHERE cs.consultant_id = c.consultant_id), '[]') AS skills,
              coalesce((SELECT json_agg(json_build_object(
                 'certificationId', ce.certification_id, 'name', ce.name,
                 'issuingBody', ce.issuing_body, 'issuedOn', ce.issued_on,
                 'expiresOn', ce.expires_on)
                 ORDER BY ce.expires_on NULLS LAST)
               FROM certification ce WHERE ce.consultant_id = c.consultant_id), '[]') AS certifications,
              coalesce((SELECT json_agg(json_build_object(
                 'documentId', d.document_id, 'type', d.doc_type, 'fileName', d.file_name,
                 'version', d.version, 'isRestricted', d.is_restricted,
                 'expiresOn', d.expires_on, 'uploadedAt', d.uploaded_at)
                 ORDER BY d.uploaded_at DESC)
               FROM document d WHERE d.consultant_id = c.consultant_id), '[]') AS documents,
              coalesce((SELECT json_agg(json_build_object(
                 'placementId', p.placement_id, 'reference', p.reference,
                 'clientName', cl.legal_name, 'jobTitle', p.job_title,
                 'startDate', p.start_date, 'endDate', p.end_date, 'status', p.status)
                 ORDER BY p.start_date DESC)
               FROM placement p JOIN client_company cl ON cl.client_id = p.client_id
               WHERE p.consultant_id = c.consultant_id), '[]') AS placements
         FROM consultant c
        WHERE c.consultant_id = $1`,
      [id],
    );
    if (!rows.length) throw notFound('Consultant not found');

    // reading vetting or banking is itself an event worth recording
    if (req.actor!.role === 'ADMINISTRATOR' && rows[0].vetting_status) {
      await withActor(req.actor!, (c) =>
        audit(c, {
          actorUserId: req.actor!.userId,
          action: 'VETTING_ACCESSED',
          entityTable: 'consultant',
          entityId: id,
        }),
      );
    }

    res.json(project(req.actor!.role, rows[0]));
  } catch (e) {
    next(e);
  }
});

const consultantBody = z.object({
  fullName: z.string().min(2, 'Enter the full name'),
  preferredName: z.string().optional(),
  email: z.string().email('Enter a valid email address'),
  mobile: z.string().optional(),
  idNumber: z.string().optional(),
  location: z.string().optional(),
  nationality: z.string().optional(),
  rightToWork: z.string().optional(),
  seniority: z.enum(['JUNIOR', 'INTERMEDIATE', 'SENIOR', 'LEAD', 'PRINCIPAL']).optional(),
  headline: z.string().optional(),
  experienceYears: z.number().min(0).max(60).optional(),
  availability: z.enum(['AVAILABLE', 'AVAILABLE_FROM', 'ON_PLACEMENT', 'NOT_AVAILABLE']).default('AVAILABLE'),
  availableFrom: z.string().optional().nullable(),
  minPayRate: z.number().min(0).optional(),
  preferredPayRate: z.number().min(0).optional(),
});

consultantsRouter.post('/', requireInternal, async (req, res, next) => {
  try {
    assertCapability(req.actor!.role, 'manage_consultants');
    const parsed = consultantBody.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('Check the details you entered', parsed.error.flatten().fieldErrors);
    }
    const b = parsed.data;
    if (b.availability === 'AVAILABLE_FROM' && !b.availableFrom) {
      throw badRequest('Give the date the consultant becomes available');
    }

    const months = 12;
    const rows = await query<any>(
      req.actor!,
      `INSERT INTO consultant (full_name, preferred_name, email, mobile, id_number, location,
                               nationality, right_to_work, seniority, headline, experience_years,
                               availability, available_from, min_pay_rate, preferred_pay_rate,
                               retention_expires_on, id_number_bidx)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::seniority_enum,$10,$11,$12::availability_enum,$13,$14,$15,
               (now() + ($16 || ' months')::interval)::date, $17)
       RETURNING *`,
      [b.fullName, b.preferredName ?? null, b.email, b.mobile ?? null, encrypt(b.idNumber),
       b.location ?? null, b.nationality ?? null, b.rightToWork ?? null, b.seniority ?? null,
       b.headline ?? null, b.experienceYears ?? null, b.availability, b.availableFrom ?? null,
       b.minPayRate ?? null, b.preferredPayRate ?? null, String(months), blindIndex(b.idNumber)],
    );
    res.status(201).json(project(req.actor!.role, rows[0]));
  } catch (e) {
    next(e);
  }
});

consultantsRouter.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);

    // a consultant may maintain their own record, nobody else's (UC-04)
    if (req.actor!.role === 'CONSULTANT') {
      const own = await query<any>(req.actor!,
        `SELECT consultant_id FROM consultant WHERE user_id = $1`, [req.actor!.userId]);
      if (own[0]?.consultant_id !== id) throw forbidden();
    } else {
      assertCapability(req.actor!.role, 'manage_consultants');
    }

    const b = consultantBody.partial().parse(req.body);
    const sets: string[] = [];
    const params: unknown[] = [id];
    const map: Record<string, string> = {
      fullName: 'full_name', preferredName: 'preferred_name', email: 'email', mobile: 'mobile',
      location: 'location', nationality: 'nationality',
      rightToWork: 'right_to_work', headline: 'headline', experienceYears: 'experience_years',
      availableFrom: 'available_from', minPayRate: 'min_pay_rate',
      preferredPayRate: 'preferred_pay_rate',
    };

    // a consultant may not reprice themselves
    const forbiddenForConsultant = ['minPayRate', 'preferredPayRate', 'idNumber'];

    for (const [k, v] of Object.entries(b)) {
      if (req.actor!.role === 'CONSULTANT' && forbiddenForConsultant.includes(k)) continue;
      if (k === 'seniority') { params.push(v); sets.push(`seniority = $${params.length}::seniority_enum`); continue; }
      if (k === 'availability') { params.push(v); sets.push(`availability = $${params.length}::availability_enum`); continue; }
      // NFR-SEC-005. One field in, two columns out: the encrypted value and the
      // fingerprint that carries its UNIQUE constraint. They must move together
      // or a later duplicate would slip past.
      if (k === 'idNumber') {
        params.push(encrypt(v as string | null));
        sets.push(`id_number = $${params.length}`);
        params.push(blindIndex(v as string | null));
        sets.push(`id_number_bidx = $${params.length}`);
        continue;
      }
      const col = map[k];
      if (!col) continue;
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    }
    if (!sets.length) throw badRequest('Nothing to update');

    const rows = await query<any>(req.actor!,
      `UPDATE consultant SET ${sets.join(', ')} WHERE consultant_id = $1 RETURNING *`, params);
    if (!rows.length) throw notFound('Consultant not found');
    res.json(project(req.actor!.role, rows[0]));
  } catch (e) {
    next(e);
  }
});

/** Records consent to disclose this consultant to clients (UC-31, BR-012). */
consultantsRouter.post('/:id/consent', requireInternal, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const rows = await withActor(req.actor!, async (c) => {
      const r = await c.query(
        `UPDATE consultant SET consent_recorded_at = now()
          WHERE consultant_id = $1 RETURNING consultant_id, consent_recorded_at`,
        [id],
      );
      if (!r.rows.length) throw notFound('Consultant not found');
      await audit(c, {
        actorUserId: req.actor!.userId,
        action: 'CONSENT_RECORDED',
        entityTable: 'consultant',
        entityId: id,
        reason: req.body?.reason ?? 'Consent to disclosure recorded',
      });
      return r.rows;
    });
    res.json(rows[0]);
  } catch (e) {
    next(e);
  }
});

consultantsRouter.put('/:id/skills', requireInternal, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const body = z.object({
      skills: z.array(z.object({
        skillId: z.string().uuid(),
        proficiency: z.enum(['BASIC', 'INTERMEDIATE', 'ADVANCED', 'EXPERT']),
        years: z.number().min(0).optional(),
        lastUsedYear: z.number().optional(),
        isPrimary: z.boolean().optional(),
      })),
    }).parse(req.body);

    const rows = await withActor(req.actor!, async (c) => {
      await c.query(`DELETE FROM consultant_skill WHERE consultant_id = $1`, [id]);
      for (const s of body.skills) {
        await c.query(
          `INSERT INTO consultant_skill (consultant_id, skill_id, proficiency, years, last_used_year, is_primary)
           VALUES ($1,$2,$3::proficiency_enum,$4,$5,$6)`,
          [id, s.skillId, s.proficiency, s.years ?? null, s.lastUsedYear ?? null, s.isPrimary ?? false],
        );
      }
      return (await c.query(
        `SELECT s.skill_id, s.name, cs.proficiency, cs.years
           FROM consultant_skill cs JOIN skill s ON s.skill_id = cs.skill_id
          WHERE cs.consultant_id = $1`, [id])).rows;
    });
    res.json({ skills: rows });
  } catch (e) {
    next(e);
  }
});

consultantsRouter.post('/:id/deactivate', requireInternal, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const rows = await query<any>(req.actor!,
      `UPDATE consultant SET is_active = false WHERE consultant_id = $1
       RETURNING consultant_id, is_active`, [id]);
    if (!rows.length) throw notFound('Consultant not found');
    res.json(rows[0]);
  } catch (e) {
    next(e);
  }
});
