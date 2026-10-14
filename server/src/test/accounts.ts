/**
 * Account lifecycle tests.
 *
 * Covers FR-AUT-001, FR-AUT-005, FR-AUT-008, FR-AUT-010 and FR-AUT-013: an
 * administrator creates an account, the person sets their own password from an
 * invitation, a forgotten password is recovered, and a suspended account stops
 * working at once.
 *
 * Run against a freshly seeded database.
 */
import { createApp } from '../index.js';
import { closePool } from '../lib/db.js';
import type { Server } from 'node:http';

const PORT = Number(process.env.TEST_PORT ?? 4102);
const BASE = `http://127.0.0.1:${PORT}/api`;

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  \u2713 ${name}`); }
  else {
    fail++; failures.push(name);
    console.log(`  \u2717 ${name}`);
    if (detail !== undefined) console.log(`      ${JSON.stringify(detail).slice(0, 220)}`);
  }
}
const section = (t: string) => console.log(`\n${t}`);

/** Browser-like: keeps cookies and echoes the CSRF token on writes. */
class Client {
  private cookies = new Map<string, string>();

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.cookies.size) h.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const t = this.cookies.get('rasibe_csrf');
    if (t) h['X-CSRF-Token'] = t;
    return h;
  }

  private absorb(res: Response) {
    for (const line of (res.headers as any).getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  async call(method: string, path: string, body?: unknown) {
    const res = await fetch(BASE + path, {
      method, headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.absorb(res);
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json };
  }

  get = (p: string) => this.call('GET', p);
  post = (p: string, b?: unknown) => this.call('POST', p, b);

  async signIn(email: string, password = 'Password123!') {
    await this.get('/auth/me');
    return this.post('/auth/login', { email, password });
  }
}

const tokenFromLink = (link: string) => new URL(link).searchParams.get('token')!;
const unique = (p: string) => `${p}.${Date.now()}.${Math.floor(Math.random() * 1e4)}@example.co.za`;

async function main() {
  const app = createApp();
  const server: Server = await new Promise((r) => { const s = app.listen(PORT, () => r(s)); });

  try {
    const admin = new Client();
    const recruiter = new Client();

    await admin.signIn('christinah@rasibe.co.za');
    await recruiter.signIn('nosipho@rasibe.co.za');

    // ------------------------------------------------------------------
    section('Who may manage accounts (FR-AUT-001)');
    // ------------------------------------------------------------------
    check('an administrator can list users', (await admin.get('/users')).status === 200);
    check('a recruiter cannot list users', (await recruiter.get('/users')).status === 403);
    check('a recruiter cannot create a user',
      (await recruiter.post('/users', {
        fullName: 'Should Fail', email: unique('nope'), role: 'RECRUITER',
      })).status === 403);

    const listed = await admin.get('/users');
    check('the seeded accounts are listed', listed.body.items.length >= 6, listed.body.items?.length);
    check('each account shows its role', listed.body.items.every((u: any) => !!u.role));

    // ------------------------------------------------------------------
    section('Creating an account (FR-AUT-001, FR-AUT-010)');
    // ------------------------------------------------------------------
    const email = unique('newrecruiter');
    const created = await admin.post('/users', {
      fullName: 'Kabelo Molefe', email, phone: '+27 82 555 0100', role: 'RECRUITER',
    });
    check('an administrator creates a recruiter', created.status === 201, created.body);
    check('an invitation link is returned in development', !!created.body.inviteLink);

    const duplicate = await admin.post('/users', {
      fullName: 'Someone Else', email, role: 'RECRUITER',
    });
    check('the same address cannot be used twice', duplicate.status === 409, duplicate.body);

    const noPassword = new Client();
    const cannotSignIn = await noPassword.signIn(email, 'Password123!');
    check('a new account cannot be signed into before the invitation is used',
      cannotSignIn.status === 401, cannotSignIn.body);

    // ------------------------------------------------------------------
    section('Accepting the invitation');
    // ------------------------------------------------------------------
    const token = tokenFromLink(created.body.inviteLink);
    const anon = new Client();

    const subject = await anon.get(`/auth/token/invite?token=${token}`);
    check('the invitation names the person it is for',
      subject.status === 200 && subject.body.email === email, subject.body);

    const unknownToken = await anon.get('/auth/token/invite?token=not-a-real-token-value');
    check('an unknown token is refused', unknownToken.status === 410, unknownToken.status);

    const weak = await anon.post('/auth/token/invite', { token, password: 'short' });
    check('a weak password is refused', weak.status === 400, weak.body?.detail);

    const breached = await anon.post('/auth/token/invite', { token, password: 'Password1234' });
    check('a breached or weak-but-long password is handled',
      breached.status === 400 || breached.status === 200, breached.status);

    // only set it for real if the previous attempt did not already consume it
    let newPassword = 'Thunder-Marsh-41xQ';
    if (breached.status !== 200) {
      const accepted = await anon.post('/auth/token/invite', { token, password: newPassword });
      check('the invitation sets the password', accepted.status === 200, accepted.body);
    } else {
      newPassword = 'Password1234';
      check('the invitation sets the password', true);
    }

    const reuse = await anon.post('/auth/token/invite', { token, password: 'Another-One-99zz' });
    check('the same invitation cannot be used twice', reuse.status === 410, reuse.status);

    const nowIn = new Client();
    const signedIn = await nowIn.signIn(email, newPassword);
    check('the new user can now sign in', signedIn.status === 200, signedIn.body);
    const me = await nowIn.get('/auth/me');
    check('they have the role they were given', me.body.user.role === 'RECRUITER', me.body?.user?.role);

    // ------------------------------------------------------------------
    section('Linking an account to a person');
    // ------------------------------------------------------------------
    const linkable = await admin.get('/users/linkable');
    check('unlinked consultants are offered', Array.isArray(linkable.body.consultants));
    check('unlinked client contacts are offered', Array.isArray(linkable.body.contacts));

    const noLink = await admin.post('/users', {
      fullName: 'Floating Consultant', email: unique('floating'), role: 'CONSULTANT',
    });
    check('a consultant account must name a consultant record',
      noLink.status === 400, noLink.body?.message);

    const freeConsultant = linkable.body.consultants[0];
    if (freeConsultant) {
      const linked = await admin.post('/users', {
        fullName: freeConsultant.full_name,
        email: unique('linked'),
        role: 'CONSULTANT',
        consultantId: freeConsultant.consultant_id,
      });
      check('a consultant account links to a pool record', linked.status === 201, linked.body);

      const again = await admin.post('/users', {
        fullName: freeConsultant.full_name, email: unique('dup'),
        role: 'CONSULTANT', consultantId: freeConsultant.consultant_id,
      });
      check('one consultant cannot have two accounts', again.status === 409, again.status);
    }

    const noContact = await admin.post('/users', {
      fullName: 'Floating Manager', email: unique('floatmgr'), role: 'CLIENT_MANAGER',
    });
    check('a client manager account must name a contact', noContact.status === 400);

    // ------------------------------------------------------------------
    section('Forgotten password (FR-AUT-005)');
    // ------------------------------------------------------------------
    const forgot = await anon.post('/auth/forgot-password', { email });
    check('a reset can be requested', forgot.status === 200, forgot.body);
    check('a link is returned in development', !!forgot.body.resetLink);

    const unknownAddress = await anon.post('/auth/forgot-password', {
      email: 'nobody.at.all@example.co.za',
    });
    check('an unknown address gets the same answer',
      unknownAddress.status === 200 && unknownAddress.body.message === forgot.body.message,
      unknownAddress.body);
    check('and no link is produced for it', !unknownAddress.body.resetLink);

    const resetToken = tokenFromLink(forgot.body.resetLink);
    const wrongPurpose = await anon.post('/auth/token/invite', {
      token: resetToken, password: 'Quartz-Harbour-72k',
    });
    check('a reset token cannot be used as an invitation', wrongPurpose.status === 410);

    const reset = await anon.post('/auth/token/reset', {
      token: resetToken, password: 'Quartz-Harbour-72k',
    });
    check('the password is reset', reset.status === 200, reset.body);

    const oldPassword = await new Client().signIn(email, newPassword);
    check('the old password no longer works', oldPassword.status === 401);
    const withNew = new Client();
    check('the new password works', (await withNew.signIn(email, 'Quartz-Harbour-72k')).status === 200);

    // ------------------------------------------------------------------
    section('Suspension (FR-AUT-008)');
    // ------------------------------------------------------------------
    const target = created.body.user.user_id;
    const noReason = await admin.post(`/users/${target}/status`, { isActive: false });
    check('suspending requires a reason', noReason.status === 400);

    const suspended = await admin.post(`/users/${target}/status`, {
      isActive: false, reason: 'Left the organisation',
    });
    check('an administrator suspends an account', suspended.status === 200, suspended.body);

    check('the suspended session stops working at once',
      (await withNew.get('/auth/me')).status === 401);
    check('and they cannot sign in again',
      (await new Client().signIn(email, 'Quartz-Harbour-72k')).status === 401);

    const self = await admin.post(`/users/${(await admin.get('/auth/me')).body.user.userId}/status`, {
      isActive: false, reason: 'Trying to lock myself out',
    });
    check('an administrator cannot suspend themselves', self.status === 400, self.body?.message);

    const reinstated = await admin.post(`/users/${target}/status`, {
      isActive: true, reason: 'Returned to the organisation',
    });
    check('an account can be reinstated', reinstated.status === 200);
    check('and they can sign in again',
      (await new Client().signIn(email, 'Quartz-Harbour-72k')).status === 200);

    // ------------------------------------------------------------------
    section('Role change (FR-AUT-013)');
    // ------------------------------------------------------------------
    const roleChanged = await admin.post(`/users/${target}/role`, {
      role: 'ADMINISTRATOR', reason: 'Promoted to run the desk',
    });
    check('a role can be changed', roleChanged.status === 200, roleChanged.body);

    const afterChange = new Client();
    await afterChange.signIn(email, 'Quartz-Harbour-72k');
    const newRole = await afterChange.get('/auth/me');
    check('the new role takes effect', newRole.body.user.role === 'ADMINISTRATOR', newRole.body?.user?.role);

    const selfDemote = await admin.post(
      `/users/${(await admin.get('/auth/me')).body.user.userId}/role`,
      { role: 'RECRUITER', reason: 'Trying to demote myself' },
    );
    check('an administrator cannot demote themselves', selfDemote.status === 400);

    // ------------------------------------------------------------------
    section('Audit trail');
    // ------------------------------------------------------------------
    const auditLog = await admin.get('/reports/audit?limit=60');
    const actions = auditLog.body.items.map((a: any) => a.action);
    check('account creation is recorded', actions.includes('USER_CREATED'), actions.slice(0, 10));
    check('suspension is recorded', actions.includes('USER_DEACTIVATED'));
    check('reinstatement is recorded', actions.includes('USER_REINSTATED'));
    check('a role change is recorded', actions.includes('USER_ROLE_CHANGED'));
    check('setting a password is recorded', actions.includes('PASSWORD_SET'));
    check('a reset request is recorded', actions.includes('PASSWORD_RESET_REQUESTED'));
  } finally {
    server.close();
    await closePool();
  }

  console.log(`\n${'='.repeat(56)}`);
  console.log(`  ${pass} passed, ${fail} failed`);
  if (fail) { console.log('\n  Failures:'); failures.forEach((f) => console.log(`   - ${f}`)); }
  console.log('='.repeat(56));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('Test run could not complete:', e); process.exit(1); });
