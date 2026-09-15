import { Router } from 'express';
import { z } from 'zod';
import { query } from '../lib/db.js';
import { requireAuth, requireInternal } from '../middleware/auth.js';

export const skillsRouter = Router();

skillsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const q = z.object({ search: z.string().optional() }).parse(req.query);
    const rows = await query(
      req.actor!,
      `SELECT skill_id, name, category,
              (SELECT count(*)::int FROM consultant_skill cs WHERE cs.skill_id = s.skill_id) AS consultant_count
         FROM skill s
        WHERE s.is_active AND ($1::text IS NULL OR s.name ILIKE '%'||$1||'%')
        ORDER BY s.category NULLS LAST, s.name`,
      [q.search ?? null],
    );
    res.json({ items: rows });
  } catch (e) { next(e); }
});

skillsRouter.post('/', requireInternal, async (req, res, next) => {
  try {
    const b = z.object({
      name: z.string().min(1, 'Enter a skill name'),
      category: z.string().optional(),
    }).parse(req.body);
    const rows = await query(
      req.actor!,
      `INSERT INTO skill (name, category) VALUES ($1,$2) RETURNING *`,
      [b.name, b.category ?? null],
    );
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});
