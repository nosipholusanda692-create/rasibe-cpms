import type { Request, Response, NextFunction } from 'express';
import { anonQuery, type Actor, type Role } from '../lib/db.js';
import { unauthorised, forbidden } from '../lib/errors.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      actor?: Actor;
      sessionId?: string;
    }
  }
}

export const SESSION_COOKIE = 'rasibe_session';

/**
 * Resolves the session cookie to an actor.
 *
 * The role is read from the database on every request rather than carried in
 * the cookie, so revoking a role takes effect immediately and a tampered
 * cookie cannot elevate anybody.
 */
export async function loadSession(req: Request, _res: Response, next: NextFunction) {
  const sid = req.cookies?.[SESSION_COOKIE];
  if (!sid) return next();

  try {
    const rows = await anonQuery<{ user_id: string; role: Role; is_active: boolean }>(
      `SELECT s.user_id, ur.role, u.is_active
         FROM user_session s
         JOIN app_user u ON u.user_id = s.user_id
         JOIN user_role ur ON ur.user_id = s.user_id
        WHERE s.session_id = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
        LIMIT 1`,
      [sid],
    );
    if (rows.length && rows[0].is_active) {
      req.actor = { userId: rows[0].user_id, role: rows[0].role };
      req.sessionId = sid;
    }
  } catch {
    // an unreadable session is simply no session
  }
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.actor) return next(unauthorised());
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.actor) return next(unauthorised());
    if (!roles.includes(req.actor.role)) return next(forbidden());
    next();
  };
}

export const requireInternal = requireRole('ADMINISTRATOR', 'RECRUITER');
export const requireAdmin = requireRole('ADMINISTRATOR');
