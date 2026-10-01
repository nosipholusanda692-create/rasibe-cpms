import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { AppError } from './errors.js';

export const CSRF_COOKIE = 'rasibe_csrf';
export const CSRF_HEADER = 'x-csrf-token';

// Reads cannot change anything, so they carry the token outward instead of
// being asked for it.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Without CSRF_SECRET a fresh secret is generated at boot, which invalidates
 * outstanding tokens on restart. The cost is one rejected write and a reload.
 * Set it in any deployment, and in particular wherever more than one instance
 * serves the same users: otherwise instances disagree about every token.
 */
const secret = process.env.CSRF_SECRET || randomBytes(32).toString('hex');

/**
 * The token is derived from the session and never stored.
 *
 * It is recomputed on every request and compared with the header. The cookie
 * carries the value to the client and is never read back as the expected
 * value, which is the difference that matters here: a hostile subdomain counts
 * as the same site and can write a cookie on the parent domain. If the cookie
 * were trusted, such an attacker could set both halves and match itself. It
 * cannot derive this, because that needs the secret and the session identifier,
 * and the session cookie is httpOnly.
 *
 * Before sign in there is no session to bind to, so every anonymous visitor
 * shares one value. That is enough to require a deliberate request, but it does
 * not make sign in itself unforgeable. See docs/CSRF.md.
 */
export function tokenFor(sessionId: string | undefined | null): string {
  return createHmac('sha256', secret).update(sessionId ?? 'anonymous').digest('hex');
}

/** Cookie options. Readable by script on purpose: the client must echo it. */
export const csrfCookieOptions = {
  httpOnly: false,
  sameSite: 'lax',
  secure: true,
  path: '/',
} as const;

function equals(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, and the length of a hex digest
  // is not a secret, so compare it first.
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * An Origin that is present and foreign is refused outright.
 *
 * Browsers attach Origin to cross-origin writes, so this turns away the obvious
 * attempt before the token is even considered. A missing Origin is not treated
 * as a failure: same-origin requests and non-browser clients may omit it, and
 * the token is the control that does not depend on the header existing.
 */
function originIsForeign(req: Request): boolean {
  const origin = req.get('origin');
  if (!origin) return false;

  const configured = process.env.CORS_ORIGIN ?? 'http://localhost:5173';
  const own = `${req.protocol}://${req.get('host') ?? ''}`;
  return origin !== configured && origin !== own;
}

/**
 * NFR-SEC-008. Hands the token out on reads and demands it back on writes.
 *
 * Must run after cookieParser and after loadSession, because the token is bound
 * to the session that loadSession resolves.
 */
export function csrf(req: Request, res: Response, next: NextFunction) {
  const expected = tokenFor(req.sessionId);

  if (SAFE_METHODS.has(req.method)) {
    // The client loads /auth/me before it can reach any form, so a token is in
    // place by the time a write is possible. Only written when it differs, to
    // avoid resending an unchanged cookie on every read.
    if (req.cookies?.[CSRF_COOKIE] !== expected) {
      res.cookie(CSRF_COOKIE, expected, csrfCookieOptions);
    }
    return next();
  }

  if (originIsForeign(req)) {
    return next(new AppError(403, 'That request came from an unexpected address.', 'csrf_failed'));
  }

  const supplied = req.get(CSRF_HEADER) ?? '';
  if (!equals(supplied, expected)) {
    return next(
      new AppError(403, 'Your session needs refreshing. Reload the page and try again.', 'csrf_failed'),
    );
  }

  next();
}
