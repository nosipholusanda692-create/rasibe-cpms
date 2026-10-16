import { Router } from 'express';
import { z } from 'zod';
import { query, withActor } from '../lib/db.js';
import { requireAdmin } from '../middleware/auth.js';
import { assertCapability, notFound } from '../lib/errors.js';
import { checkSetting } from '../lib/settings-rules.js';
import { audit } from '../services/notify.js';

export const settingsRouter = Router();

/**
 * Administrators only. The list includes the company's banking details and tax
 * registration, which no other role needs. The Settings screen is already an
 * administrator screen; this makes the API agree with it (NFR-SEC-002).
 */
settingsRouter.get('/', requireAdmin, async (req, res, next) => {
  try {
    const rows = await query(req.actor!,
      `SELECT setting_key, setting_value, description FROM system_setting ORDER BY setting_key`);
    res.json({ items: rows });
  } catch (e) { next(e); }
});

/**
 * Configuration is data, so an administrator changes it without a deployment.
 *
 * A change to the VAT rate or the banking details printed on invoices is
 * financially significant, so it is audited with the value it replaced
 * (NFR-SEC-011). Saving the value a setting already has records nothing.
 */
settingsRouter.put('/:key', requireAdmin, async (req, res, next) => {
  try {
    assertCapability(req.actor!.role, 'manage_settings');
    const key = z.string().min(1).max(80).parse(req.params.key);
    // Bounded before the rules run, so a megabyte "value" is refused cheaply.
    const b = z.object({ value: z.string().max(1000) }).strict().parse(req.body);
    const value = checkSetting(key, b.value);

    const row = await withActor(req.actor!, async (c) => {
      const cur = await c.query(
        `SELECT setting_value FROM system_setting WHERE setting_key = $1 FOR UPDATE`, [key]);
      if (!cur.rows.length) throw notFound('That setting does not exist.');

      const updated = await c.query(
        `UPDATE system_setting SET setting_value = $2, updated_at = now(), updated_by = $3
          WHERE setting_key = $1 RETURNING *`,
        [key, value, req.actor!.userId]);

      const before = cur.rows[0].setting_value as string;
      if (before !== value) {
        await audit(c, {
          actorUserId: req.actor!.userId,
          action: 'SETTING_CHANGED',
          entityTable: 'system_setting',
          previous: { setting: key, value: before },
          next: { setting: key, value },
          reason: `Setting ${key} changed`,
        });
      }
      return updated.rows[0];
    });
    res.json(row);
  } catch (e) { next(e); }
});
