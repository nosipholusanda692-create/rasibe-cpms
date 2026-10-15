import type { Request, Response, NextFunction } from 'express';
import { anonQuery, type Actor, type Role } from '../lib/db.js';
import { AppError, unauthorised, forbidden } from '../lib/errors.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      actor?: Actor;
      sessionId?: string;
      twoFactorEnabled?: boolean;
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
    const rows = await anonQuery<{
      user_id: string;
      role: Role;
      is_active: boolean;
      two_factor: boolean;
    }>(
      `SELECT s.user_id, ur.role, u.is_active, u.totp_enabled_at IS NOT NULL AS two_factor
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
      req.twoFactorEnabled = rows[0].two_factor;
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

/** What an administrator without two-factor can still reach: enough to enrol. */
const ENROLMENT_PATHS = new Set([
  '/api/auth/me',
  '/api/auth/logout',
  '/api/auth/2fa/setup',
  '/api/auth/2fa/enable',
]);

export function adminTwoFactorRequired(): boolean {
  return process.env.REQUIRE_ADMIN_2FA === 'true';
}

/**
 * With REQUIRE_ADMIN_2FA=true, an administrator who has not enrolled is held at
 * enrolment. Off by default, so nobody is shut out before the client has
 * screens to enrol with. See docs/TWO-FACTOR.md.
 */
export function requireAdminTwoFactor(req: Request, _res: Response, next: NextFunction) {
  if (
    adminTwoFactorRequired() &&
    req.actor?.role === 'ADMINISTRATOR' &&
    !req.twoFactorEnabled &&
    !ENROLMENT_PATHS.has(req.path)
  ) {
    return next(
      new AppError(
        403,
        'Set up two-factor authentication before continuing.',
        'two_factor_enrolment_required',
      ),
    );
  }
  next();
}
