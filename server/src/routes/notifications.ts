import { Router } from 'express';
import { z } from 'zod';
import { query } from '../lib/db.js';
import { requireAuth } from '../middleware/auth.js';

export const notificationsRouter = Router();

notificationsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const q = z.object({ unreadOnly: z.coerce.boolean().optional() }).parse(req.query);
    const rows = await query(
      req.actor!,
      `SELECT notification_id, event, subject, body, related_table, related_id,
              scheduled_for, sent_at, read_at
         FROM notification
        WHERE recipient_user_id = $1
          AND ($2::boolean IS NOT TRUE OR read_at IS NULL)
        ORDER BY scheduled_for DESC LIMIT 100`,
      [req.actor!.userId, q.unreadOnly ?? false],
    );
    res.json({ items: rows });
  } catch (e) { next(e); }
});

notificationsRouter.post('/:id/read', requireAuth, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const rows = await query(
      req.actor!,
      `UPDATE notification SET read_at = now()
        WHERE notification_id = $1 AND recipient_user_id = $2 RETURNING notification_id, read_at`,
      [id, req.actor!.userId],
    );
    res.json(rows[0] ?? { ok: true });
  } catch (e) { next(e); }
});
