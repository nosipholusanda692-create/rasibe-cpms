import { Router } from 'express';
import { z } from 'zod';
import { query } from '../lib/db.js';
import { requireAuth, requireInternal } from '../middleware/auth.js';
import { badRequest, notFound, conflict } from '../lib/errors.js';
import { searchText, queryBool } from '../lib/validation.js';

export const skillsRouter = Router();

/**
 * The skills list.
 *
 * Retired skills are hidden by default, because this list feeds the pickers
 * used for matching. `includeRetired=true` is for the maintenance screen,
 * which has to show them or a retired skill could never be restored. Only
 * staff can ask for it: for a consultant or a client manager the flag is
 * ignored, so a retired skill is not disclosed to them.
 */
skillsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const q = z.object({
      search: searchText.optional(),
      includeRetired: queryBool(false),
    }).parse(req.query);

    const staff = req.actor!.role === 'ADMINISTRATOR' || req.actor!.role === 'RECRUITER';
    const withRetired = staff && q.includeRetired === true;

    const rows = await query(
      req.actor!,
      `SELECT skill_id, name, category, is_active,
              (SELECT count(*)::int FROM consultant_skill cs WHERE cs.skill_id = s.skill_id) AS consultant_count
         FROM skill s
        WHERE ($2::boolean OR s.is_active) AND ($1::text IS NULL OR s.name ILIKE '%'||$1||'%')
        ORDER BY s.category NULLS LAST, s.name`,
      [q.search ?? null, withRetired],
    );
    res.json({ items: rows });
  } catch (e) { next(e); }
});

skillsRouter.post('/', requireInternal, async (req, res, next) => {
  try {
    const b = z.object({
      name: z.string().min(1, 'Enter a skill name'),
      category: z.string().optional(),
    }).strict().parse(req.body);
    const rows = await query(
      req.actor!,
      `INSERT INTO skill (name, category) VALUES ($1,$2) RETURNING *`,
      [b.name, b.category ?? null],
    );
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

/**
 * FR-CFG-005 — maintain the skills taxonomy.
 *
 * A skill is renamed or recategorised rather than deleted. Deleting one would
 * take the proficiency and years recorded against every consultant with it,
 * and those were entered by hand. Retiring it keeps the history and removes
 * the skill from future matching.
 */
skillsRouter.patch('/:id', requireInternal, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const b = z.object({
      name: z.string().min(1, 'Enter a skill name').max(120).optional(),
      category: z.string().max(80).nullable().optional(),
      isActive: z.boolean().optional(),
    }).parse(req.body);

    const sets: string[] = [];
    const params: unknown[] = [id];
    if (b.name !== undefined) { params.push(b.name); sets.push(`name = $${params.length}`); }
    if (b.category !== undefined) { params.push(b.category); sets.push(`category = $${params.length}`); }
    if (b.isActive !== undefined) { params.push(b.isActive); sets.push(`is_active = $${params.length}`); }
    if (!sets.length) throw badRequest('Nothing to update');

    const rows = await query<any>(
      req.actor!,
      `UPDATE skill SET ${sets.join(', ')} WHERE skill_id = $1
       RETURNING skill_id, name, category, is_active`,
      params,
    );
    if (!rows.length) throw notFound('Skill not found');
    res.json(rows[0]);
  } catch (e) { next(e); }
});

/**
 * Retiring a skill. Kept separate from the patch above so the count of
 * consultants affected can be reported back before anything is hidden.
 */
skillsRouter.post('/:id/retire', requireInternal, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const rows = await query<any>(
      req.actor!,
      `UPDATE skill SET is_active = false WHERE skill_id = $1
       RETURNING skill_id, name,
         (SELECT count(*)::int FROM consultant_skill cs WHERE cs.skill_id = $1) AS consultant_count`,
      [id],
    );
    if (!rows.length) throw notFound('Skill not found');
    res.json(rows[0]);
  } catch (e) { next(e); }
});
