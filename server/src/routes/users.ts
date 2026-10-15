import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { query, withActor } from '../lib/db.js';
import { badRequest, notFound, conflict, assertCapability } from '../lib/errors.js';
import { requireAdmin } from '../middleware/auth.js';
import { ROLES, queryBool, searchText } from '../lib/validation.js';
import { audit, queueNotification } from '../services/notify.js';

export const usersRouter = Router();

const INVITE_HOURS = 72;

/**
 * Tokens are generated here and never stored.
 *
 * What goes in the database is the SHA-256 of the value, so a reader of
 * account_token cannot sign in as anybody. The plain value exists only in the
 * notification the person receives.
 */
function newToken(): { plain: string; hash: Buffer } {
  const plain = randomBytes(32).toString('base64url');
  return { plain, hash: createHash('sha256').update(plain).digest() };
}

function inviteLink(req: any, token: string, purpose: 'invite' | 'reset'): string {
  const base = process.env.PUBLIC_WEB_URL
    ?? process.env.CORS_ORIGIN
    ?? `${req.protocol}://${req.get('host')}`;
  return `${base}/${purpose === 'invite' ? 'accept-invitation' : 'reset-password'}?token=${token}`;
}

// ---------------------------------------------------------------------
// FR-AUT-001 — the administrator's view of who has access
// ---------------------------------------------------------------------
usersRouter.get('/', requireAdmin, async (req, res, next) => {
  try {
    assertCapability(req.actor!.role, 'manage_users');
    const q = z.object({
      search: searchText.optional(),
      role: z.enum(ROLES).optional(),
      includeInactive: queryBool(true),
    }).parse(req.query);

    const params: unknown[] = [];
    const where: string[] = ['1=1'];
    if (q.search) {
      params.push(q.search);
      where.push(`(u.full_name ILIKE '%'||$${params.length}||'%' OR u.email ILIKE '%'||$${params.length}||'%')`);
    }
    if (q.role) { params.push(q.role); where.push(`ur.role = $${params.length}::role_enum`); }
    if (!q.includeInactive) where.push('u.is_active');

    const rows = await query<any>(
      req.actor!,
      `SELECT u.user_id, u.full_name, u.email, u.phone, u.is_active,
              u.last_login_at, u.created_at, u.locked_until,
              ur.role,
              (u.password_hash = '!') AS awaiting_first_sign_in,
              (u.totp_enabled_at IS NOT NULL) AS two_factor_enabled,
              c.consultant_id,
              cc.client_id, cl.legal_name AS client_name,
              (SELECT max(t.expires_at) FROM account_token t
                WHERE t.user_id = u.user_id AND t.purpose = 'INVITE'
                  AND t.consumed_at IS NULL AND t.expires_at > now()) AS invite_expires_at
         FROM app_user u
         LEFT JOIN user_role ur ON ur.user_id = u.user_id
         LEFT JOIN consultant c ON c.user_id = u.user_id
         LEFT JOIN client_contact cc ON cc.user_id = u.user_id AND cc.is_active
         LEFT JOIN client_company cl ON cl.client_id = cc.client_id
        WHERE ${where.join(' AND ')}
        ORDER BY u.is_active DESC, u.full_name`,
      params,
    );
    res.json({ items: rows });
  } catch (e) { next(e); }
});

/** Candidates an account can be linked to, so the administrator is not typing identifiers. */
usersRouter.get('/linkable', requireAdmin, async (req, res, next) => {
  try {
    const consultants = await query<any>(
      req.actor!,
      `SELECT c.consultant_id, c.full_name, c.email, c.headline
         FROM consultant c
        WHERE c.is_active AND NOT c.is_anonymised AND c.user_id IS NULL
        ORDER BY c.full_name`,
    );
    const contacts = await query<any>(
      req.actor!,
      `SELECT cc.contact_id, cc.first_name, cc.last_name, cc.email, cc.job_title,
              cl.client_id, cl.legal_name AS client_name
         FROM client_contact cc
         JOIN client_company cl ON cl.client_id = cc.client_id
        WHERE cc.is_active AND cc.user_id IS NULL
        ORDER BY cl.legal_name, cc.last_name`,
    );
    res.json({ consultants, contacts });
  } catch (e) { next(e); }
});

const createBody = z.object({
  fullName: z.string().min(2, 'Enter the full name'),
  email: z.string().email('Enter a valid email address'),
  phone: z.string().optional(),
  role: z.enum(['ADMINISTRATOR', 'RECRUITER', 'CONSULTANT', 'CLIENT_MANAGER']),
  // A consultant account is linked to a pool record; a client manager to a contact.
  consultantId: z.string().uuid().optional(),
  contactId: z.string().uuid().optional(),
});

/**
 * FR-AUT-001 and FR-AUT-010.
 *
 * No password is set here. The account is created with a hash that cannot
 * match anything, and an invitation is issued. The person chooses their own
 * password, so nobody else ever knows it — not even the administrator who
 * created the account.
 */
usersRouter.post('/', requireAdmin, async (req, res, next) => {
  try {
    assertCapability(req.actor!.role, 'manage_users');
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('Check the details you entered', parsed.error.flatten().fieldErrors);
    }
    const b = parsed.data;

    if (b.role === 'CONSULTANT' && !b.consultantId) {
      throw badRequest(
        'Choose the consultant this account belongs to. A consultant must already be in the pool before they are given access.',
        { consultantId: ['Select a consultant'] },
      );
    }
    if (b.role === 'CLIENT_MANAGER' && !b.contactId) {
      throw badRequest(
        'Choose the client contact this account belongs to, so the account is tied to one client company.',
        { contactId: ['Select a contact'] },
      );
    }

    const { plain, hash } = newToken();

    const out = await withActor(req.actor!, async (c) => {
      const existing = await c.query('SELECT 1 FROM app_user WHERE lower(email) = lower($1)', [b.email]);
      if (existing.rows.length) throw conflict('That email address already has an account.');

      // '!' is not a valid hash in any scheme, so it can never verify. The
      // account exists but cannot be signed into until the invitation is used.
      const u = await c.query(
        `INSERT INTO app_user (full_name, email, phone, password_hash, is_active)
         VALUES ($1,$2,$3,'!',true)
         RETURNING user_id, full_name, email, phone, is_active, created_at`,
        [b.fullName, b.email, b.phone ?? null],
      );
      const userId = u.rows[0].user_id;

      await c.query(
        'INSERT INTO user_role (user_id, role) VALUES ($1,$2::role_enum)',
        [userId, b.role],
      );

      if (b.consultantId) {
        const linked = await c.query(
          'UPDATE consultant SET user_id = $2 WHERE consultant_id = $1 AND user_id IS NULL RETURNING consultant_id',
          [b.consultantId, userId],
        );
        if (!linked.rows.length) throw conflict('That consultant already has an account.');
      }
      if (b.contactId) {
        const linked = await c.query(
          'UPDATE client_contact SET user_id = $2 WHERE contact_id = $1 AND user_id IS NULL RETURNING contact_id',
          [b.contactId, userId],
        );
        if (!linked.rows.length) throw conflict('That contact already has an account.');
      }

      await c.query('SELECT issue_account_token($1,$2::account_token_purpose_enum,$3,$4,$5,$6)', [
        userId, 'INVITE', hash, INVITE_HOURS, req.actor!.userId, req.ip ?? null,
      ]);

      await queueNotification(c, {
        event: 'ACCOUNT_CREATED',
        recipientUserId: userId,
        recipientEmail: b.email,
        vars: {
          name: b.fullName,
          link: inviteLink(req, plain, 'invite'),
          hours: String(INVITE_HOURS),
        },
      });

      await audit(c, {
        actorUserId: req.actor!.userId,
        action: 'USER_CREATED',
        entityTable: 'app_user',
        entityId: userId,
        next: { email: b.email, role: b.role },
        reason: 'Account created and invitation issued',
      });

      return u.rows[0];
    });

    res.status(201).json({
      user: out,
      // Returned only in development, where no mail is delivered and the
      // administrator would otherwise have no way to pass the link on.
      inviteLink: process.env.NODE_ENV === 'production' ? undefined : inviteLink(req, plain, 'invite'),
    });
  } catch (e) { next(e); }
});

/** Reissues an invitation. Any previous link stops working. */
usersRouter.post('/:id/invite', requireAdmin, async (req, res, next) => {
  try {
    assertCapability(req.actor!.role, 'manage_users');
    const id = z.string().uuid().parse(req.params.id);
    const { plain, hash } = newToken();

    const out = await withActor(req.actor!, async (c) => {
      const u = await c.query('SELECT user_id, full_name, email FROM app_user WHERE user_id = $1', [id]);
      if (!u.rows.length) throw notFound('User not found');

      await c.query('SELECT issue_account_token($1,$2::account_token_purpose_enum,$3,$4,$5,$6)', [
        id, 'INVITE', hash, INVITE_HOURS, req.actor!.userId, req.ip ?? null,
      ]);

      await queueNotification(c, {
        event: 'ACCOUNT_CREATED',
        recipientUserId: id,
        recipientEmail: u.rows[0].email,
        vars: {
          name: u.rows[0].full_name,
          link: inviteLink(req, plain, 'invite'),
          hours: String(INVITE_HOURS),
        },
      });

      await audit(c, {
        actorUserId: req.actor!.userId,
        action: 'USER_INVITED',
        entityTable: 'app_user',
        entityId: id,
        reason: req.body?.reason ?? 'Invitation reissued',
      });
      return u.rows[0];
    });

    res.json({
      ok: true,
      email: out.email,
      inviteLink: process.env.NODE_ENV === 'production' ? undefined : inviteLink(req, plain, 'invite'),
    });
  } catch (e) { next(e); }
});

/** FR-AUT-008 — suspend and reinstate. */
usersRouter.post('/:id/status', requireAdmin, async (req, res, next) => {
  try {
    assertCapability(req.actor!.role, 'manage_users');
    const id = z.string().uuid().parse(req.params.id);
    const b = z.object({
      isActive: z.boolean(),
      reason: z.string().min(5, 'Give a reason of at least five characters'),
    }).parse(req.body);

    if (id === req.actor!.userId && !b.isActive) {
      throw badRequest('You cannot suspend your own account.');
    }

    const out = await withActor(req.actor!, async (c) => {
      const r = await c.query(
        'UPDATE app_user SET is_active = $2 WHERE user_id = $1 RETURNING user_id, full_name, is_active',
        [id, b.isActive],
      );
      if (!r.rows.length) throw notFound('User not found');

      if (!b.isActive) {
        // Suspension takes effect at once rather than at the next sign-in.
        await c.query(
          'UPDATE user_session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
          [id],
        );
      }

      await audit(c, {
        actorUserId: req.actor!.userId,
        action: b.isActive ? 'USER_REINSTATED' : 'USER_DEACTIVATED',
        entityTable: 'app_user',
        entityId: id,
        reason: b.reason,
      });
      return r.rows[0];
    });

    res.json(out);
  } catch (e) { next(e); }
});

/** FR-AUT-007 — change the role on an existing account. */
usersRouter.post('/:id/role', requireAdmin, async (req, res, next) => {
  try {
    assertCapability(req.actor!.role, 'manage_users');
    const id = z.string().uuid().parse(req.params.id);
    const b = z.object({
      role: z.enum(['ADMINISTRATOR', 'RECRUITER', 'CONSULTANT', 'CLIENT_MANAGER']),
      reason: z.string().min(5, 'Give a reason of at least five characters'),
    }).parse(req.body);

    if (id === req.actor!.userId && b.role !== 'ADMINISTRATOR') {
      throw badRequest('You cannot remove your own administrator role. Ask another administrator.');
    }

    const out = await withActor(req.actor!, async (c) => {
      const prev = await c.query('SELECT role FROM user_role WHERE user_id = $1', [id]);
      if (!prev.rows.length) throw notFound('User not found');

      await c.query('DELETE FROM user_role WHERE user_id = $1', [id]);
      await c.query('INSERT INTO user_role (user_id, role) VALUES ($1,$2::role_enum)', [id, b.role]);
      // The role is read from the database on every request, so a change takes
      // effect immediately. Ending the sessions makes that visible rather than
      // leaving someone with a navigation that no longer matches their access.
      await c.query(
        'UPDATE user_session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
        [id],
      );

      await audit(c, {
        actorUserId: req.actor!.userId,
        action: 'USER_ROLE_CHANGED',
        entityTable: 'app_user',
        entityId: id,
        previous: { role: prev.rows[0].role },
        next: { role: b.role },
        reason: b.reason,
      });
      return { userId: id, role: b.role };
    });

    res.json(out);
  } catch (e) { next(e); }
});
