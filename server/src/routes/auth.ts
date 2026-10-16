import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { Request, Response } from 'express';
import { anonQuery, query, withActor } from '../lib/db.js';
import { badRequest, conflict, forbidden, notFound, unauthorised, AppError } from '../lib/errors.js';
import { checkBreached } from '../lib/breached.js';
import { hashPassword, needsRehash, spendDecoyComparison, verifyPassword } from '../lib/passwords.js';
import { fieldErrors } from '../lib/validation.js';
import {
  SESSION_COOKIE,
  adminTwoFactorRequired,
  requireAdmin,
  requireAuth,
} from '../middleware/auth.js';
import { CSRF_COOKIE, csrfCookieOptions, tokenFor } from '../lib/csrf.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import {
  generateRecoveryCodes,
  generateSecret,
  looksLikeRecoveryCode,
  otpauthUri,
  recoveryCodeDigest,
  verifyTotp,
} from '../lib/totp.js';

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
 * Between a correct password and a correct code. Scoped to the auth routes and
 * never readable by script: holding it is half of signing in.
 */
const CHALLENGE_COOKIE = 'rasibe_2fa';
const CHALLENGE_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: true,
  path: '/api/auth',
} as const;
const CHALLENGE_MINUTES = 5;
const CHALLENGE_ATTEMPTS = 5;

const digest = (token: string) => createHash('sha256').update(token).digest();

/** One more failure against the account, locking it at MAX_FAILED. */
async function countFailure(userId: string): Promise<void> {
  await anonQuery(
    `UPDATE app_user
        SET failed_logins = failed_logins + 1,
            locked_until = CASE WHEN failed_logins + 1 >= $2::int
                                THEN now() + ($3::int * interval '1 minute')
                                ELSE locked_until END
      WHERE user_id = $1`,
    [userId, MAX_FAILED, LOCK_MINUTES],
  );
}

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
 * A second cap, on every sign-in request rather than on failures.
 *
 * The failure count below is the control that stops password spraying, and it
 * is the one the suite asserts. This one exists because a scanner cannot see a
 * limit written as a query: `js/missing-rate-limiting` only recognises
 * express-rate-limit and three other packages, so without this middleware it
 * reports the route as unlimited. A hundred requests in the same window is
 * enough for a client site signing in together and far below what a script can
 * send. The suite is exempt, because it deliberately fails dozens of times
 * from one address in order to measure the failure count.
 */
const loginLimiter = rateLimit({
  windowMs: ADDRESS_WINDOW_MINUTES * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
});

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
 * NFR-SEC-004. An unknown address has no hash to check, so a check is spent
 * anyway, against a decoy. The decoy is Argon2id at the same parameters as a
 * real password. See `lib/passwords.ts`.
 */
async function spendComparisonTime(password: string): Promise<void> {
  await spendDecoyComparison(password);
}

const credentials = z.object({
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
}).strict();

/** Where each role lands after signing in, as shown on the prototype. */
const LANDING: Record<string, string> = {
  ADMINISTRATOR: '/dashboard',
  RECRUITER: '/requests',
  CONSULTANT: '/my/timesheets',
  CLIENT_MANAGER: '/approvals',
};

authRouter.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const parsed = credentials.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('Check the details you entered', fieldErrors(parsed.error));
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
              u.failed_logins, u.locked_until, u.totp_enabled_at, ur.role
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

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      await countFailure(user.user_id);
      await record(false);
      throw unauthorised('Email address or password is incorrect');
    }

    // A bcrypt hash, an Argon2id hash without the pepper, or one written at
    // older parameters, is rewritten now because this is the only moment the password itself is
    // known. A wrong password cannot do it: there is nothing to rewrite it to.
    if (needsRehash(user.password_hash)) {
      const upgraded = await hashPassword(password);
      await anonQuery(`UPDATE app_user SET password_hash = $2 WHERE user_id = $1`, [
        user.user_id,
        upgraded,
      ]);
    }

    // The password is right but is only half of it. No session exists yet and
    // the failure count is left alone: it is reset when the code is right too,
    // so a stolen password cannot be used to clear a run of wrong codes.
    if (user.totp_enabled_at) {
      const challenge = randomBytes(32).toString('base64url');
      await anonQuery(
        `INSERT INTO login_challenge (user_id, token_hash, expires_at, ip_address)
         VALUES ($1, $2, now() + ($3::int * interval '1 minute'), $4)`,
        [user.user_id, digest(challenge), CHALLENGE_MINUTES, ip],
      );
      res.cookie(CHALLENGE_COOKIE, challenge, {
        ...CHALLENGE_COOKIE_OPTIONS,
        maxAge: CHALLENGE_MINUTES * 60_000,
      });
      return res.json({ twoFactorRequired: true });
    }

    await startSession(req, res, user, () => record(true));
  } catch (e) {
    next(e);
  }
});

/**
 * Issues the session once every factor has been checked. Shared by both
 * sign-in steps so a session is created one way only.
 */
async function startSession(
  req: Request,
  res: Response,
  user: { user_id: string; email: string; full_name: string; role: string },
  recordSuccess: () => Promise<void>,
  extra: Record<string, unknown> = {},
): Promise<void> {
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
    [user.user_id, String(ttlHours), req.ip ?? null],
  );

  await anonQuery(
    `UPDATE app_user SET failed_logins = 0, locked_until = NULL, last_login_at = now()
      WHERE user_id = $1`,
    [user.user_id],
  );
  await recordSuccess();

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
    ...extra,
  });
}

type Exec = (sql: string, params: unknown[]) => Promise<any[]>;

/**
 * Checks and spends a second factor: an authenticator code or a recovery code.
 *
 * Spending is a conditional UPDATE, so two requests racing with the same code
 * cannot both succeed: the second finds the step already taken or the recovery
 * code already used.
 */
async function spendSecondFactor(
  exec: Exec,
  userId: string,
  secretCipher: string | null,
  lastStep: string | number | null,
  code: string,
): Promise<'totp' | 'recovery' | null> {
  if (looksLikeRecoveryCode(code)) {
    const used = await exec(
      `UPDATE recovery_code SET used_at = now()
        WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
        RETURNING code_id`,
      [userId, recoveryCodeDigest(code)],
    );
    return used.length ? 'recovery' : null;
  }

  const secret = decrypt(secretCipher);
  if (!secret) return null;
  const step = verifyTotp(secret, code, lastStep === null ? null : Number(lastStep));
  if (step === null) return null;

  const claimed = await exec(
    `UPDATE app_user SET totp_last_step = $2
      WHERE user_id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)
      RETURNING user_id`,
    [userId, step],
  );
  return claimed.length ? 'totp' : null;
}

const anonExec: Exec = (sql, params) => anonQuery(sql, params);

const secondFactor = z.object({
  code: z.string().trim().min(6, 'Enter the code from your authenticator app').max(20),
}).strict();

/** The second sign-in step, after `/login` answered `twoFactorRequired`. */
authRouter.post('/login/verify', loginLimiter, async (req, res, next) => {
  try {
    const parsed = secondFactor.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('Check the code you entered', fieldErrors(parsed.error));
    }

    const expired = () => {
      res.clearCookie(CHALLENGE_COOKIE, CHALLENGE_COOKIE_OPTIONS);
      return new AppError(
        401,
        'That sign-in has expired. Enter your password again.',
        'two_factor_expired',
      );
    };

    const challenge = req.cookies?.[CHALLENGE_COOKIE];
    if (!challenge) throw expired();

    const rows = await anonQuery<any>(
      `SELECT ch.challenge_id, u.user_id, u.email, u.full_name, u.is_active,
              u.locked_until, u.totp_secret, u.totp_last_step, ur.role
         FROM login_challenge ch
         JOIN app_user u ON u.user_id = ch.user_id
         LEFT JOIN user_role ur ON ur.user_id = u.user_id
        WHERE ch.token_hash = $1
          AND ch.consumed_at IS NULL
          AND ch.expires_at > now()
          AND ch.attempts < $2
        LIMIT 1`,
      [digest(challenge), CHALLENGE_ATTEMPTS],
    );
    const user = rows[0];
    if (!user || !user.is_active || !user.totp_secret) throw expired();

    const ip = req.ip ?? null;
    const record = async (ok: boolean) => {
      await anonQuery(
        `INSERT INTO login_attempt (email, succeeded, ip_address, ip_prefix) VALUES ($1,$2,$3,$4)`,
        [user.email, ok, ip, throttleKey(ip)],
      );
    };

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      await anonQuery(`UPDATE login_challenge SET consumed_at = now() WHERE challenge_id = $1`, [
        user.challenge_id,
      ]);
      res.clearCookie(CHALLENGE_COOKIE, CHALLENGE_COOKIE_OPTIONS);
      throw new AppError(423, 'This account is temporarily locked. Try again shortly.', 'locked');
    }

    const used = await spendSecondFactor(
      anonExec,
      user.user_id,
      user.totp_secret,
      user.totp_last_step,
      parsed.data.code,
    );

    if (!used) {
      await anonQuery(`UPDATE login_challenge SET attempts = attempts + 1 WHERE challenge_id = $1`, [
        user.challenge_id,
      ]);
      await countFailure(user.user_id);
      await record(false);
      throw new AppError(401, 'That code is not right. Try again.', 'two_factor_invalid');
    }

    const consumed = await anonQuery(
      `UPDATE login_challenge SET consumed_at = now()
        WHERE challenge_id = $1 AND consumed_at IS NULL
        RETURNING challenge_id`,
      [user.challenge_id],
    );
    if (!consumed.length) throw expired();
    res.clearCookie(CHALLENGE_COOKIE, CHALLENGE_COOKIE_OPTIONS);

    let extra: Record<string, unknown> = {};
    if (used === 'recovery') {
      const left = await anonQuery<{ n: number }>(
        `SELECT count(*)::int AS n FROM recovery_code WHERE user_id = $1 AND used_at IS NULL`,
        [user.user_id],
      );
      await anonQuery(
        `INSERT INTO audit_entry (actor_user_id, action, entity_table, entity_id, reason)
         VALUES ($1,'RECOVERY_CODE_USED','app_user',$1,$2)`,
        [user.user_id, `Signed in with a recovery code; ${left[0].n} left`],
      );
      extra = { recoveryCodesRemaining: left[0].n };
    }

    await startSession(req, res, user, () => record(true), extra);
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
      `SELECT u.user_id, u.email, u.full_name, u.phone, u.last_login_at, u.totp_enabled_at
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
      twoFactor: {
        enabled: rows[0].totp_enabled_at !== null,
        // True when this person must enrol before anything else will answer.
        required: req.actor!.role === 'ADMINISTRATOR' && adminTwoFactorRequired(),
      },
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
    }).strict();
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('Check the details you entered', fieldErrors(parsed.error));
    }

    // Checked before the transaction opens, so a slow lookup does not hold a
    // database connection while it waits.
    const breach = await checkBreached(parsed.data.newPassword);
    if (breach === 'breached') {
      throw badRequest('Check the details you entered', {
        newPassword: ['This password has appeared in a data breach. Choose a different one.'],
      });
    }
    if (breach === 'unknown') {
      console.warn('[warn] breached-password check unavailable; password change allowed');
    }

    await withActor(req.actor!, async (c) => {
      const cur = await c.query(`SELECT password_hash FROM app_user WHERE user_id = $1`, [
        req.actor!.userId,
      ]);
      const ok = await verifyPassword(parsed.data.currentPassword, cur.rows[0].password_hash);
      if (!ok) throw unauthorised('Your current password is incorrect');

      const hash = await hashPassword(parsed.data.newPassword);
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

// =====================================================================
// Invitations and password resets
//
// FR-AUT-005 and FR-AUT-010. Both run before a session exists, so both go
// through the SECURITY DEFINER functions added in migration 002 rather than
// touching app_user directly.
//
// The token is never stored. What is held is a SHA-256 of it, so a reader of
// account_token cannot set anybody's password.
// =====================================================================
const RESET_HOURS = 1;

/** The password rule, kept in one place so both flows and the change form agree. */
export const passwordRule = z
  .string()
  .min(10, 'Use at least 10 characters')
  .regex(/[A-Z]/, 'Include an upper case letter')
  .regex(/[a-z]/, 'Include a lower case letter')
  .regex(/[0-9]/, 'Include a number');

/**
 * Who an invitation or reset link belongs to.
 *
 * The set-password page calls this so it can greet the person and show which
 * address it is for. An unknown, used or expired token is simply not valid;
 * the caller is not told which, because the three are not usefully different.
 */
authRouter.get('/token/:purpose', async (req, res, next) => {
  try {
    const purpose = z.enum(['invite', 'reset']).parse(req.params.purpose);
    const token = z.string().min(10).safeParse(req.query.token);
    if (!token.success) throw badRequest('That link is not valid.');

    const rows = await anonQuery<any>(
      'SELECT * FROM account_token_subject($1,$2::account_token_purpose_enum)',
      [digest(token.data), purpose === 'invite' ? 'INVITE' : 'RESET'],
    );

    if (!rows.length) {
      throw new AppError(
        410,
        purpose === 'invite'
          ? 'This invitation has already been used or has expired. Ask an administrator to send a new one.'
          : 'This reset link has already been used or has expired. Request a new one.',
        'token_expired',
      );
    }

    res.json({ valid: true, fullName: rows[0].full_name, email: rows[0].email });
  } catch (e) { next(e); }
});

/** Sets the password behind an invitation or a reset link, and spends the token. */
authRouter.post('/token/:purpose', async (req, res, next) => {
  try {
    const purpose = z.enum(['invite', 'reset']).parse(req.params.purpose);
    const parsed = z
      .object({ token: z.string().min(10), password: passwordRule }).strict()
      .safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('Check the password you entered', fieldErrors(parsed.error));
    }

    // The same breach check the change-password form applies (NFR-SEC-002).
    const breach = await checkBreached(parsed.data.password);
    if (breach === 'breached') {
      throw badRequest('Check the password you entered', {
        password: ['This password has appeared in a data breach. Choose a different one.'],
      });
    }
    if (breach === 'unknown') {
      console.warn('[warn] breached-password check unavailable; password set allowed');
    }

    const hashed = await hashPassword(parsed.data.password);
    const rows = await anonQuery<{ redeem_account_token: string | null }>(
      'SELECT redeem_account_token($1,$2::account_token_purpose_enum,$3) AS redeem_account_token',
      [digest(parsed.data.token), purpose === 'invite' ? 'INVITE' : 'RESET', hashed],
    );

    const userId = rows[0]?.redeem_account_token;
    if (!userId) {
      throw new AppError(
        410,
        'That link has already been used or has expired.',
        'token_expired',
      );
    }

    await anonQuery(
      `INSERT INTO audit_entry (actor_user_id, action, entity_table, entity_id, reason)
       VALUES ($1,'PASSWORD_SET','app_user',$1,$2)`,
      [userId, purpose === 'invite' ? 'Password set from invitation' : 'Password set from reset link'],
    );

    res.json({ ok: true });
  } catch (e) { next(e); }
});

/**
 * FR-AUT-005. Requests a reset link.
 *
 * Answers identically whether or not the address is registered, so the form
 * cannot be used to discover who has an account.
 */
authRouter.post('/forgot-password', async (req, res, next) => {
  try {
    const parsed = z.object({ email: z.string().email() }).strict().safeParse(req.body);
    const answer = {
      ok: true,
      message: 'If that address has an account, a reset link is on its way. It is valid for one hour.',
    };
    if (!parsed.success) return res.json(answer);

    const rows = await anonQuery<any>('SELECT * FROM account_for_reset($1)', [parsed.data.email]);
    if (!rows.length) return res.json(answer);

    const plain = randomBytes(32).toString('base64url');
    await anonQuery(
      'SELECT issue_account_token($1,$2::account_token_purpose_enum,$3,$4,$5,$6)',
      [rows[0].user_id, 'RESET', digest(plain), RESET_HOURS, null, req.ip ?? null],
    );

    const base = process.env.PUBLIC_WEB_URL ?? process.env.CORS_ORIGIN ?? 'http://localhost:5173';
    const link = `${base}/reset-password?token=${plain}`;

    await anonQuery(
      `INSERT INTO notification (event, channel, recipient_user_id, recipient_email, subject, body)
       VALUES ('PASSWORD_RESET','EMAIL',$1,$2,$3,$4)`,
      [
        rows[0].user_id,
        rows[0].email,
        'Reset your Rasibe password',
        `Hello ${rows[0].full_name}, use this link to set a new password. It expires in one hour: ${link}`,
      ],
    );

    await anonQuery(
      `INSERT INTO audit_entry (actor_user_id, action, entity_table, entity_id, reason)
       VALUES ($1,'PASSWORD_RESET_REQUESTED','app_user',$1,$2)`,
      [rows[0].user_id, 'Reset requested'],
    );

    res.json({
      ...answer,
      // Development only: no mail is delivered, so the link would be unreachable.
      resetLink: process.env.NODE_ENV === 'production' ? undefined : link,
    });
  } catch (e) { next(e); }
});

// =====================================================================
// Two-factor authentication
//
// Enrolment is two steps so that a mistyped or unscanned secret cannot lock
// anybody out: set-up stores a pending secret, and only a code proving the app
// holds it turns two-factor on. See docs/TWO-FACTOR.md.
// =====================================================================

const currentPassword = z.object({ currentPassword: z.string().min(1, 'Enter your password') }).strict();

async function confirmPassword(c: { query: Exec }, userId: string, password: string) {
  const rows = await c.query(
    `SELECT email, password_hash, totp_enabled_at, totp_pending_secret, totp_secret, totp_last_step
       FROM app_user WHERE user_id = $1 FOR UPDATE`,
    [userId],
  );
  if (!rows.length || !(await verifyPassword(password, rows[0].password_hash))) {
    throw unauthorised('Your current password is incorrect');
  }
  return rows[0];
}

const clientExec = (c: { query: (sql: string, params: unknown[]) => Promise<{ rows: any[] }> }) => ({
  query: (async (sql, params) => (await c.query(sql, params)).rows) as Exec,
});

/** Starts enrolment. The secret is shown once, here, and stored encrypted. */
authRouter.post('/2fa/setup', requireAuth, async (req, res, next) => {
  try {
    const parsed = currentPassword.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('Check the details you entered', fieldErrors(parsed.error));
    }

    const secret = generateSecret();
    const email = await withActor(req.actor!, async (c) => {
      const db = clientExec(c);
      const user = await confirmPassword(db, req.actor!.userId, parsed.data.currentPassword);
      if (user.totp_enabled_at) throw conflict('Two-factor authentication is already on.');
      await db.query(`UPDATE app_user SET totp_pending_secret = $2 WHERE user_id = $1`, [
        req.actor!.userId,
        encrypt(secret),
      ]);
      return user.email as string;
    });

    res.set('Cache-Control', 'no-store');
    res.json({ secret, otpauthUri: otpauthUri(secret, email) });
  } catch (e) {
    next(e);
  }
});

/** Finishes enrolment and hands out the recovery codes, once. */
authRouter.post('/2fa/enable', requireAuth, async (req, res, next) => {
  try {
    const parsed = secondFactor.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('Check the code you entered', fieldErrors(parsed.error));
    }

    const codes = generateRecoveryCodes();
    await withActor(req.actor!, async (c) => {
      const db = clientExec(c);
      const rows = await db.query(
        `SELECT totp_pending_secret, totp_enabled_at FROM app_user WHERE user_id = $1 FOR UPDATE`,
        [req.actor!.userId],
      );
      if (rows[0].totp_enabled_at) throw conflict('Two-factor authentication is already on.');

      const pending = decrypt(rows[0].totp_pending_secret);
      if (!pending) throw badRequest('Start the set-up again: there is no code waiting to be confirmed.');

      const step = verifyTotp(pending, parsed.data.code, null);
      if (step === null) {
        throw badRequest('Check the code you entered', {
          code: ['That code is not right. Check the time on your phone and try again.'],
        });
      }

      await db.query(
        `UPDATE app_user
            SET totp_secret = totp_pending_secret, totp_pending_secret = NULL,
                totp_enabled_at = now(), totp_last_step = $2
          WHERE user_id = $1`,
        [req.actor!.userId, step],
      );
      await db.query(`DELETE FROM recovery_code WHERE user_id = $1`, [req.actor!.userId]);
      for (const code of codes) {
        await db.query(`INSERT INTO recovery_code (user_id, code_hash) VALUES ($1, $2)`, [
          req.actor!.userId,
          recoveryCodeDigest(code),
        ]);
      }
      // Any other session was signed in with the password alone.
      await db.query(
        `UPDATE user_session SET revoked_at = now()
          WHERE user_id = $1 AND session_id <> $2 AND revoked_at IS NULL`,
        [req.actor!.userId, req.sessionId],
      );
      await db.query(
        `INSERT INTO audit_entry (actor_user_id, action, entity_table, entity_id, reason)
         VALUES ($1,'TWO_FACTOR_ENABLED','app_user',$1,'Two-factor authentication turned on')`,
        [req.actor!.userId],
      );
    });

    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, recoveryCodes: codes });
  } catch (e) {
    next(e);
  }
});

/** Turns two-factor off. Needs the password and a current code, not just a session. */
authRouter.post('/2fa/disable', requireAuth, async (req, res, next) => {
  try {
    const parsed = currentPassword.merge(secondFactor).safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('Check the details you entered', fieldErrors(parsed.error));
    }
    if (req.actor!.role === 'ADMINISTRATOR' && adminTwoFactorRequired()) {
      throw forbidden('Administrators must keep two-factor authentication on.');
    }

    await withActor(req.actor!, async (c) => {
      const db = clientExec(c);
      const user = await confirmPassword(db, req.actor!.userId, parsed.data.currentPassword);
      if (!user.totp_enabled_at) throw conflict('Two-factor authentication is not on.');

      const used = await spendSecondFactor(
        db.query,
        req.actor!.userId,
        user.totp_secret,
        user.totp_last_step,
        parsed.data.code,
      );
      if (!used) {
        throw badRequest('Check the details you entered', { code: ['That code is not right.'] });
      }

      await clearTwoFactor(db.query, req.actor!.userId);
      await db.query(
        `INSERT INTO audit_entry (actor_user_id, action, entity_table, entity_id, reason)
         VALUES ($1,'TWO_FACTOR_DISABLED','app_user',$1,'Two-factor authentication turned off')`,
        [req.actor!.userId],
      );
    });

    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

async function clearTwoFactor(exec: Exec, userId: string): Promise<void> {
  await exec(
    `UPDATE app_user
        SET totp_secret = NULL, totp_pending_secret = NULL,
            totp_enabled_at = NULL, totp_last_step = NULL
      WHERE user_id = $1`,
    [userId],
  );
  await exec(`DELETE FROM recovery_code WHERE user_id = $1`, [userId]);
  await exec(
    `UPDATE login_challenge SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL`,
    [userId],
  );
}

/**
 * For a lost phone. An administrator clears someone else's two-factor so they
 * can sign in with their password and enrol again.
 *
 * Never one's own: an administrator who could reset their own would make the
 * second factor optional for exactly the accounts it matters most on. The
 * reason is required and kept in the audit trail.
 */
authRouter.post('/2fa/reset/:userId', requireAdmin, async (req, res, next) => {
  try {
    const userId = z.string().uuid().safeParse(req.params.userId);
    if (!userId.success) throw notFound('No such user');
    const parsed = z
      .object({
        reason: z.string().trim().min(10, 'Say why, in at least 10 characters').max(500),
      }).strict()
      .safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('Check the details you entered', fieldErrors(parsed.error));
    }
    if (userId.data === req.actor!.userId) {
      throw forbidden('You cannot reset your own two-factor authentication. Ask another administrator.');
    }

    await withActor(req.actor!, async (c) => {
      const db = clientExec(c);
      const rows = await db.query(
        `SELECT totp_enabled_at FROM app_user WHERE user_id = $1 FOR UPDATE`,
        [userId.data],
      );
      if (!rows.length) throw notFound('No such user');
      if (!rows[0].totp_enabled_at) throw conflict('Two-factor authentication is not on for this account.');

      await clearTwoFactor(db.query, userId.data);
      await db.query(
        `UPDATE user_session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId.data],
      );
      await db.query(
        `INSERT INTO audit_entry (actor_user_id, action, entity_table, entity_id, reason)
         VALUES ($1,'TWO_FACTOR_RESET','app_user',$2,$3)`,
        [req.actor!.userId, userId.data, parsed.data.reason],
      );
    });

    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
