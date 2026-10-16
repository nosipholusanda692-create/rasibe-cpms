import { Router } from 'express';
import { z } from 'zod';
import { query } from '../lib/db.js';
import { requireAuth } from '../middleware/auth.js';
import { queryBool } from '../lib/validation.js';

export const notificationsRouter = Router();

notificationsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const q = z.object({ unreadOnly: queryBool(false) }).parse(req.query);
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

/**
 * The unread count for the bell (FR-NOT-005).
 *
 * Polled by the web client, so it is deliberately one cheap count rather than
 * the list itself. The list is fetched only when the panel is opened.
 */
notificationsRouter.get('/unread-count', requireAuth, async (req, res, next) => {
  try {
    const rows = await query<{ n: number }>(
      req.actor!,
      `SELECT count(*)::int AS n FROM notification
        WHERE recipient_user_id = $1 AND read_at IS NULL`,
      [req.actor!.userId],
    );
    res.json({ unread: rows[0]?.n ?? 0 });
  } catch (e) { next(e); }
});

/** Marks everything read at once, for the person who has read them elsewhere. */
notificationsRouter.post('/read-all', requireAuth, async (req, res, next) => {
  try {
    const rows = await query<{ n: number }>(
      req.actor!,
      `WITH updated AS (
         UPDATE notification SET read_at = now()
          WHERE recipient_user_id = $1 AND read_at IS NULL
        RETURNING 1)
       SELECT count(*)::int AS n FROM updated`,
      [req.actor!.userId],
    );
    res.json({ marked: rows[0]?.n ?? 0 });
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
