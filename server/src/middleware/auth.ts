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
      /** The cookie named a session that had just ended through inactivity. */
      sessionIdle?: boolean;
    }
  }
}

export const SESSION_COOKIE = 'rasibe_session';

/**
 * Minutes without a request before a session ends, whatever its absolute
 * expiry. Read per request so a changed setting applies without a restart.
 */
export function idleMinutes(): number {
  const n = Number(process.env.SESSION_IDLE_MINUTES ?? 30);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

/** How stale last_seen_at may get before it is written again. */
const TOUCH_SECONDS = 60;

/**
 * Resolves the session cookie to an actor.
 *
 * The role is read from the database on every request rather than carried in
 * the cookie, so revoking a role takes effect immediately and a tampered
 * cookie cannot elevate anybody.
 *
 * A session left unused for idleMinutes() is revoked here rather than merely
 * ignored, so raising the setting later cannot bring it back. Use moves
 * last_seen_at forward, at most once a minute so that every request is not
 * also a write.
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
      idle: boolean;
      stale: boolean;
    }>(
      `SELECT s.user_id, ur.role, u.is_active, u.totp_enabled_at IS NOT NULL AS two_factor,
              s.last_seen_at <= now() - ($2::int * interval '1 minute') AS idle,
              s.last_seen_at <= now() - ($3::int * interval '1 second') AS stale
         FROM user_session s
         JOIN app_user u ON u.user_id = s.user_id
         JOIN user_role ur ON ur.user_id = s.user_id
        WHERE s.session_id = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
        LIMIT 1`,
      [sid, idleMinutes(), TOUCH_SECONDS],
    );
    const row = rows[0];
    if (row?.idle) {
      await anonQuery(
        `UPDATE user_session SET revoked_at = now() WHERE session_id = $1 AND revoked_at IS NULL`,
        [sid],
      );
      req.sessionIdle = true;
    } else if (row?.is_active) {
      if (row.stale) {
        await anonQuery(`UPDATE user_session SET last_seen_at = now() WHERE session_id = $1`, [sid]);
      }
      req.actor = { userId: row.user_id, role: row.role };
      req.sessionId = sid;
      req.twoFactorEnabled = row.two_factor;
    }
  } catch {
    // an unreadable session is simply no session
  }
  next();
}

/** Says why, so the client can tell "signed out for inactivity" from "never signed in". */
function notSignedIn(req: Request) {
  return req.sessionIdle
    ? new AppError(
        401,
        `You were signed out after ${idleMinutes()} minutes without activity. Sign in again.`,
        'session_idle',
      )
    : unauthorised();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.actor) return next(notSignedIn(req));
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.actor) return next(notSignedIn(req));
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
