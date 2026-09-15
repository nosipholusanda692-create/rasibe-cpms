import { Router } from 'express';
import { z } from 'zod';
import { query } from '../lib/db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { assertCapability } from '../lib/errors.js';

export const settingsRouter = Router();

settingsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const rows = await query(req.actor!,
      `SELECT setting_key, setting_value, description FROM system_setting ORDER BY setting_key`);
    res.json({ items: rows });
  } catch (e) { next(e); }
});

/** Configuration is data, so an administrator changes it without a deployment. */
settingsRouter.put('/:key', requireAdmin, async (req, res, next) => {
  try {
    assertCapability(req.actor!.role, 'manage_settings');
    const key = z.string().min(1).parse(req.params.key);
    const b = z.object({ value: z.string() }).parse(req.body);
    const rows = await query(req.actor!,
      `UPDATE system_setting SET setting_value = $2, updated_at = now(), updated_by = $3
        WHERE setting_key = $1 RETURNING *`,
      [key, b.value, req.actor!.userId]);
    res.json(rows[0]);
  } catch (e) { next(e); }
});
