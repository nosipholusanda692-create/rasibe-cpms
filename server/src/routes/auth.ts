import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { anonQuery, query, withActor } from '../lib/db.js';
import { badRequest, unauthorised, AppError } from '../lib/errors.js';
import { SESSION_COOKIE, requireAuth } from '../middleware/auth.js';
import { CSRF_COOKIE, csrfCookieOptions, tokenFor } from '../lib/csrf.js';

export const authRouter = Router();

/**
 * NFR-SEC-001. Secure in every environment, not only production: a session
 * identifier that travels in clear even once is already exposed, and the
 * environment a server believes it is in is not something a user can verify.
 * Development is unaffected because browsers treat localhost as a trustworthy
 * origin and will still store the cookie.
 *
 * Sign-out reuses these attributes deliberately. A cookie is cleared by
 * matching it, so options that drift between setting and clearing can leave
 * the browser holding a session the server has already revoked.
 */
const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: true,
  path: '/',
} as const;

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

/**
 * FR-AUT-009, the half the account lockout cannot reach.
 *
 * Locking an account after five failures stops many passwords being tried
 * against one account. It does nothing about one password being tried against
 * many accounts: each account sees a single failure, no counter approaches
 * five, and an attacker works through a list of addresses unhindered. That is
 * the attack that actually succeeds against real systems, because it only
 * needs one person to have chosen a common password.
 *
 * Twenty rather than five, because this counter aggregates strangers. An
 * account's failures belong to one person; an address's failures belong to
 * everyone behind it, and a client site behind one corporate NAT can produce
 * several honest mistakes in fifteen minutes. The two limits protect different
 * things and a shared address has to absorb ordinary human error from a whole
 * office without locking it out of approving timesheets.
 */
export const MAX_FAILED_PER_ADDRESS = 20;
const ADDRESS_WINDOW_MINUTES = 15;

/**
 * The unit the throttle counts against.
 *
 * IPv4 is counted exactly. IPv6 is counted by its /64, because a single
 * subscriber is routinely handed a whole /64 and anyone renting IPv6 can have
 * millions of addresses for nothing — counting exact IPv6 addresses would be a
 * control an attacker never even notices.
 *
 * Returned separately from the address itself so that `login_attempt` keeps
 * recording exactly who connected (FR-AUT-011) while the throttle counts the
 * wider group.
 */
export function throttleKey(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const bare = ip.split('%')[0]; // drop any IPv6 zone index

  // A dual-stack socket reports IPv4 callers as ::ffff:203.0.113.5, which must
  // not be mistaken for an IPv6 address and widened to a /64.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare);
  if (mapped) return mapped[1];
  if (!bare.includes(':')) return bare;

  const sides = bare.split('::');
  let groups: string[];
  if (sides.length === 2) {
    const head = sides[0] ? sides[0].split(':') : [];
    const tail = sides[1] ? sides[1].split(':') : [];
    groups = [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
  } else {
    groups = bare.split(':');
  }
  // Normalised through a number so that 2001:0db8 and 2001:db8 are one key
  // rather than two, which would otherwise double an attacker's budget.
  const prefix = groups.slice(0, 4).map((g) => (parseInt(g || '0', 16) || 0).toString(16));
  return `${prefix.join(':')}::/64`;
}

/**
 * NFR-SEC-004 on the sign-in form. Verifying a password is deliberately slow,
 * so skipping it when the address is unknown made the two refusals trivially
 * distinguishable: measured on this code before the change, a wrong password
 * took 146 ms and an unknown address 12 ms, with no overlap between them. One
 * request per address was enough to decide whether an account existed, and the
 * identical wording of the two messages counted for nothing.
 *
 * So every refusal now does the same work. This hash is never matched by any
 * password: it is built at startup from random bytes nobody keeps, and exists
 * only to be compared against.
 *
 * The cost must stay level with the cost used for real passwords, or the two
 * paths drift apart again. Both are 10.
 */
const BCRYPT_COST = 10;
const DECOY_HASH = bcrypt.hashSync(randomBytes(32).toString('hex'), BCRYPT_COST);

/**
 * Spends the time a password check would have taken, and discards the answer.
 * Called where there is nothing to check, so that nothing can be read from how
 * quickly the refusal comes back.
 */
async function spendComparisonTime(password: string): Promise<void> {
  await bcrypt.compare(password, DECOY_HASH);
}

const credentials = z.object({
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
});

/** Where each role lands after signing in, as shown on the prototype. */
const LANDING: Record<string, string> = {
  ADMINISTRATOR: '/dashboard',
  RECRUITER: '/requests',
  CONSULTANT: '/my/timesheets',
  CLIENT_MANAGER: '/approvals',
};

authRouter.post('/login', async (req, res, next) => {
  try {
    const parsed = credentials.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('Check the details you entered', parsed.error.flatten().fieldErrors);
    }
    const { email, password } = parsed.data;
    const ip = req.ip ?? null;
    const prefix = throttleKey(ip);

    // Asked before the account is looked up, which is what keeps it from
    // becoming an enumeration oracle: the answer depends only on the caller's
    // own address and is the same whatever address they are guessing at.
    //
    // It also returns without spending a comparison. NFR-SEC-004 equalises the
    // paths that reveal whether an account exists; this one reveals nothing of
    // the sort, and burning a deliberately slow hash on every request from an
    // address already known to be attacking would hand that attacker a way to
    // exhaust the server instead.
    if (prefix) {
      const recent = await anonQuery<{ failures: string }>(
        `SELECT count(*)::text AS failures
           FROM login_attempt
          WHERE ip_prefix = $1
            AND NOT succeeded
            AND attempted_at > now() - ($2::int * interval '1 minute')`,
        [prefix, ADDRESS_WINDOW_MINUTES],
      );
      if (Number(recent[0]?.failures ?? 0) >= MAX_FAILED_PER_ADDRESS) {
        res.setHeader('Retry-After', String(ADDRESS_WINDOW_MINUTES * 60));
        throw new AppError(
          429,
          'Too many sign-in attempts from this network. Try again shortly.',
          'too_many_attempts',
        );
      }
    }

    const users = await anonQuery<any>(
      `SELECT u.user_id, u.email, u.full_name, u.password_hash, u.is_active,
              u.failed_logins, u.locked_until, ur.role
         FROM app_user u
         LEFT JOIN user_role ur ON ur.user_id = u.user_id
        WHERE lower(u.email) = lower($1)
        LIMIT 1`,
      [email],
    );

    const user = users[0];
    const record = async (ok: boolean) => {
      await anonQuery(
        `INSERT INTO login_attempt (email, succeeded, ip_address, ip_prefix) VALUES ($1,$2,$3,$4)`,
        [email, ok, ip, prefix],
      );
    };

    if (!user || !user.is_active) {
      // There is nothing to verify, so the time one would have taken is spent
      // anyway. The wording below is identical to a wrong password, and this is
      // what makes that identical wording mean something.
      await spendComparisonTime(password);
      await record(false);
      throw unauthorised('Email address or password is incorrect');
    }

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      // Same reasoning. A locked account that answered faster than an unlocked
      // one would tell an attacker which addresses they had already driven into
      // lockout, which is a map of the accounts they have been working on.
      await spendComparisonTime(password);
      await record(false);
      throw new AppError(423, 'This account is temporarily locked. Try again shortly.', 'locked');
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      const failed = (user.failed_logins ?? 0) + 1;
      await anonQuery(
        `UPDATE app_user
            SET failed_logins = $2::int,
                locked_until = CASE WHEN $2::int >= $3::int
                                    THEN now() + ($4::int * interval '1 minute')
                                    ELSE locked_until END
          WHERE user_id = $1`,
        [user.user_id, failed, MAX_FAILED, LOCK_MINUTES],
      );
      await record(false);
      throw unauthorised('Email address or password is incorrect');
    }

    // NFR-SEC-010. Signing in is the one privilege change this system has, and
    // an identifier issued before it must not survive it. Without this, an
    // identifier planted in the browser beforehand stays valid alongside the
    // new one until it expires on its own.
    if (req.sessionId) {
      await anonQuery(
        `UPDATE user_session SET revoked_at = now()
          WHERE session_id = $1 AND revoked_at IS NULL`,
        [req.sessionId],
      );
    }

    const ttlHours = Number(process.env.SESSION_TTL_HOURS ?? 8);
    const sessions = await anonQuery<{ session_id: string }>(
      `INSERT INTO user_session (user_id, expires_at, ip_address)
       VALUES ($1, now() + ($2 || ' hours')::interval, $3)
       RETURNING session_id`,
      [user.user_id, String(ttlHours), ip],
    );

    await anonQuery(
      `UPDATE app_user SET failed_logins = 0, locked_until = NULL, last_login_at = now()
        WHERE user_id = $1`,
      [user.user_id],
    );
    await record(true);

    res.cookie(SESSION_COOKIE, sessions[0].session_id, {
      ...SESSION_COOKIE_OPTIONS,
      maxAge: ttlHours * 3600_000,
    });

    // The token is bound to the session, so a new session means a new token.
    // Issued here rather than on the next read, so the client can write
    // immediately after signing in.
    res.cookie(CSRF_COOKIE, tokenFor(sessions[0].session_id), csrfCookieOptions);

    res.json({
      user: {
        userId: user.user_id,
        email: user.email,
        fullName: user.full_name,
        role: user.role,
      },
      landing: LANDING[user.role] ?? '/dashboard',
    });
  } catch (e) {
    next(e);
  }
});

authRouter.post('/logout', async (req, res, next) => {
  try {
    if (req.sessionId) {
      await anonQuery(`UPDATE user_session SET revoked_at = now() WHERE session_id = $1`, [
        req.sessionId,
      ]);
    }
    res.clearCookie(SESSION_COOKIE, SESSION_COOKIE_OPTIONS);
    // Replaced rather than cleared. The token just became wrong, because the
    // session it was derived from is revoked, but the client stays on the page
    // and signing in again is itself a write that needs a valid token. Clearing
    // it would leave the next sign in with nothing to send.
    res.cookie(CSRF_COOKIE, tokenFor(null), csrfCookieOptions);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

/** Who am I, and what may I do. The client uses this to build its navigation. */
authRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const rows = await query<any>(
      req.actor!,
      `SELECT u.user_id, u.email, u.full_name, u.phone, u.last_login_at
         FROM app_user u WHERE u.user_id = $1`,
      [req.actor!.userId],
    );
    const caps = await query<{ capability: string }>(
      req.actor!,
      `SELECT capability FROM role_capability WHERE role = $1::role_enum`,
      [req.actor!.role],
    );

    // a consultant's own record, so the client can load their timesheets
    const link = await query<any>(
      req.actor!,
      `SELECT c.consultant_id FROM consultant c WHERE c.user_id = $1`,
      [req.actor!.userId],
    );
    const clients = await query<any>(
      req.actor!,
      `SELECT cc.client_id, co.legal_name
         FROM client_contact cc
         JOIN client_company co ON co.client_id = cc.client_id
        WHERE cc.user_id = $1 AND cc.is_active`,
      [req.actor!.userId],
    );

    res.json({
      user: {
        userId: rows[0].user_id,
        email: rows[0].email,
        fullName: rows[0].full_name,
        phone: rows[0].phone,
        role: req.actor!.role,
        consultantId: link[0]?.consultant_id ?? null,
        clients: clients.map((c) => ({ clientId: c.client_id, name: c.legal_name })),
      },
      capabilities: caps.map((c) => c.capability),
      landing: LANDING[req.actor!.role],
    });
  } catch (e) {
    next(e);
  }
});

authRouter.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const schema = z.object({
      currentPassword: z.string().min(1),
      newPassword: z
        .string()
        .min(10, 'Use at least 10 characters')
        .regex(/[A-Z]/, 'Include an upper case letter')
        .regex(/[a-z]/, 'Include a lower case letter')
        .regex(/[0-9]/, 'Include a number'),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('Check the details you entered', parsed.error.flatten().fieldErrors);
    }

    await withActor(req.actor!, async (c) => {
      const cur = await c.query(`SELECT password_hash FROM app_user WHERE user_id = $1`, [
        req.actor!.userId,
      ]);
      const ok = await bcrypt.compare(parsed.data.currentPassword, cur.rows[0].password_hash);
      if (!ok) throw unauthorised('Your current password is incorrect');

      const hash = await bcrypt.hash(parsed.data.newPassword, 10);
      await c.query(`UPDATE app_user SET password_hash = $2 WHERE user_id = $1`, [
        req.actor!.userId,
        hash,
      ]);
      // signing in again everywhere else is the safe default after a change
      await c.query(
        `UPDATE user_session SET revoked_at = now()
          WHERE user_id = $1 AND session_id <> $2 AND revoked_at IS NULL`,
        [req.actor!.userId, req.sessionId],
      );
    });

    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
