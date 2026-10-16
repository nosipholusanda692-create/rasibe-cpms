/**
 * Two-factor authentication tests.
 *
 * The code generator against the RFC 6238 test vectors, then enrolment, the
 * second sign-in step, recovery codes, the lockout, turning it off, the
 * administrator reset and the REQUIRE_ADMIN_2FA setting, all through HTTP and
 * the real database. See docs/TWO-FACTOR.md.
 *
 * Uses its own synthetic accounts, so the seeded ones are left as they were.
 * Run against a freshly seeded database.
 */
import { createApp } from '../index.js';
import { anonQuery, closePool } from '../lib/db.js';
import { hashPassword } from '../lib/passwords.js';
import {
  base32Decode, base32Encode, generateRecoveryCodes, hotp, otpauthUri, STEP_SECONDS, totpAt,
  verifyTotp,
} from '../lib/totp.js';
import type { Server } from 'node:http';

const PORT = Number(process.env.TEST_PORT ?? 4103);
const BASE = `http://127.0.0.1:${PORT}/api`;
const PASSWORD = 'Password123!';

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
  cookies = new Map<string, string>();
  setCookies: string[] = [];
  headersSeen: Headers | null = null;

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.cookies.size) h.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const t = this.cookies.get('rasibe_csrf');
    if (t) h['X-CSRF-Token'] = t;
    return h;
  }

  private absorb(res: Response) {
    this.setCookies = res.headers.getSetCookie();
    this.headersSeen = res.headers;
    for (const line of this.setCookies) {
      const [pair] = line.split(';');
      const i = pair.indexOf('=');
      if (i <= 0) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async call(method: string, path: string, body?: unknown) {
    if (method !== 'GET' && !this.cookies.has('rasibe_csrf')) await this.call('GET', '/auth/me');
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
  signIn = (email: string, password = PASSWORD) => this.post('/auth/login', { email, password });
}

const unique = (p: string) => `${p}.${Date.now()}.${Math.floor(Math.random() * 1e4)}@example.co.za`;

async function createUser(email: string, fullName: string, role: string): Promise<string> {
  const rows = await anonQuery<{ user_id: string }>(
    `WITH u AS (
       INSERT INTO app_user (email, full_name, password_hash) VALUES ($1, $2, $3)
       RETURNING user_id),
     r AS (INSERT INTO user_role (user_id, role) SELECT user_id, $4::role_enum FROM u)
     SELECT user_id FROM u`,
    [email, fullName, await hashPassword(PASSWORD), role],
  );
  return rows[0].user_id;
}

/** Lets a second code be used inside the same 30 seconds as the first. */
const forgetLastStep = (userId: string) =>
  anonQuery(`UPDATE app_user SET totp_last_step = NULL WHERE user_id = $1`, [userId]);

const clearAttempts = () => anonQuery(`DELETE FROM login_attempt`);

async function enrol(client: Client): Promise<{ secret: string; codes: string[] }> {
  const setup = await client.post('/auth/2fa/setup', { currentPassword: PASSWORD });
  const secret = setup.body?.secret as string;
  const enabled = await client.post('/auth/2fa/enable', { code: totpAt(secret, Date.now()) });
  if (enabled.status !== 200) throw new Error(`enrolment failed: ${JSON.stringify(enabled.body)}`);
  return { secret, codes: enabled.body.recoveryCodes };
}

async function auditCount(action: string, entityId: string): Promise<number> {
  const rows = await anonQuery<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_entry WHERE action = $1::audit_action_enum AND entity_id = $2`,
    [action, entityId],
  );
  return rows[0].n;
}

async function main() {
  const app = createApp();
  const server: Server = await new Promise((r) => { const s = app.listen(PORT, () => r(s)); });
  const savedRequire = process.env.REQUIRE_ADMIN_2FA;
  delete process.env.REQUIRE_ADMIN_2FA;

  try {
    await clearAttempts();

    // ------------------------------------------------------------------
    section('The code itself (RFC 6238)');
    // ------------------------------------------------------------------
    // Appendix B of the RFC: SHA-1, the ASCII seed below, eight digits.
    const rfcKey = Buffer.from('12345678901234567890');
    const vectors: Array<[number, string]> = [
      [59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
      [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130'],
    ];
    for (const [seconds, expected] of vectors) {
      const got = hotp(rfcKey, Math.floor(seconds / STEP_SECONDS), 8);
      check(`RFC 6238 vector at ${seconds} seconds`, got === expected, { got, expected });
    }
    check('base32 round-trips the secret',
      base32Decode(base32Encode(rfcKey)).equals(rfcKey), base32Encode(rfcKey));
    check('the secret encodes as the apps expect',
      base32Encode(rfcKey) === 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', base32Encode(rfcKey));

    const secret = base32Encode(rfcKey);
    const t = 1_700_000_000_000;
    const stepNow = Math.floor(t / 1000 / STEP_SECONDS);
    check('the current code is accepted', verifyTotp(secret, totpAt(secret, t), null, t) === stepNow);
    check('the previous code is accepted, for a phone clock that is behind',
      verifyTotp(secret, totpAt(secret, t - 30_000), null, t) === stepNow - 1);
    check('a code two steps old is refused',
      verifyTotp(secret, totpAt(secret, t - 60_000), null, t) === null);
    check('a code from a step already used is refused',
      verifyTotp(secret, totpAt(secret, t), stepNow, t) === null);
    check('anything but six digits is refused',
      verifyTotp(secret, 'abcdef', null, t) === null && verifyTotp(secret, '12345', null, t) === null);

    const uri = otpauthUri(secret, 'fixture@example.co.za');
    check('the set-up link names the account, issuer and algorithm',
      uri.startsWith('otpauth://totp/Rasibe%20CPMS:fixture%40example.co.za?')
        && uri.includes(`secret=${secret}`) && uri.includes('issuer=Rasibe%20CPMS')
        && uri.includes('algorithm=SHA1') && uri.includes('digits=6') && uri.includes('period=30'),
      uri);

    const sample = generateRecoveryCodes();
    check('ten recovery codes, all different',
      sample.length === 10 && new Set(sample).size === 10, sample.length);
    check('recovery codes are two groups of five',
      sample.every((c) => /^[a-z2-7]{5}-[a-z2-7]{5}$/.test(c)), sample[0]);

    // ------------------------------------------------------------------
    section('Enrolment');
    // ------------------------------------------------------------------
    const email = unique('twofactor.recruiter');
    const userId = await createUser(email, 'Fixture TwoFactor', 'RECRUITER');
    const user = new Client();
    const plain = await user.signIn(email);
    check('without two-factor, a password still signs in directly',
      plain.status === 200 && !!plain.body.user && !plain.body.twoFactorRequired, plain.body);
    check('/auth/me reports two-factor as off',
      (await user.get('/auth/me')).body.twoFactor?.enabled === false);

    const elsewhere = new Client();
    await elsewhere.signIn(email);

    const wrongPassword = await user.post('/auth/2fa/setup', { currentPassword: 'not the password' });
    check('set-up needs the current password', wrongPassword.status === 401, wrongPassword.status);

    const setup = await user.post('/auth/2fa/setup', { currentPassword: PASSWORD });
    const userSecret = setup.body?.secret as string;
    check('set-up returns the secret and the link for the QR code',
      setup.status === 200 && /^[A-Z2-7]{32}$/.test(userSecret ?? '')
        && setup.body.otpauthUri?.includes(userSecret), setup.body);
    check('the secret is not cached',
      user.headersSeen?.get('cache-control') === 'no-store', user.headersSeen?.get('cache-control'));

    const pending = await anonQuery<any>(
      `SELECT totp_pending_secret, totp_secret, totp_enabled_at FROM app_user WHERE user_id = $1`,
      [userId],
    );
    check('the pending secret is stored encrypted',
      pending[0].totp_pending_secret?.startsWith('v1:')
        && !pending[0].totp_pending_secret.includes(userSecret), pending[0].totp_pending_secret?.slice(0, 8));
    check('two-factor is not on until a code proves the app has the secret',
      pending[0].totp_enabled_at === null && pending[0].totp_secret === null);

    const wrongCode = await user.post('/auth/2fa/enable', { code: '000000' });
    check('a wrong code does not turn it on', wrongCode.status === 400, wrongCode.body);

    const enabled = await user.post('/auth/2fa/enable', { code: totpAt(userSecret, Date.now()) });
    const codes: string[] = enabled.body?.recoveryCodes ?? [];
    check('the right code turns it on and returns ten recovery codes',
      enabled.status === 200 && codes.length === 10, enabled.body);

    const stored = await anonQuery<any>(
      `SELECT totp_secret, totp_pending_secret, totp_enabled_at, totp_last_step FROM app_user WHERE user_id = $1`,
      [userId],
    );
    check('the secret is stored encrypted and the pending copy is gone',
      stored[0].totp_secret?.startsWith('v1:') && stored[0].totp_pending_secret === null
        && stored[0].totp_enabled_at !== null);
    check('the code used to enrol is recorded as spent', stored[0].totp_last_step !== null);

    const hashes = await anonQuery<{ code_hash: Buffer }>(
      `SELECT code_hash FROM recovery_code WHERE user_id = $1`, [userId],
    );
    check('ten recovery codes are stored', hashes.length === 10, hashes.length);
    check('recovery codes are not stored as they were shown',
      hashes.every((h) => !codes.some((c) => h.code_hash.toString('utf8').includes(c.replace('-', '')))));
    check('enrolment is audited', (await auditCount('TWO_FACTOR_ENABLED', userId)) === 1);
    check('/auth/me reports two-factor as on',
      (await user.get('/auth/me')).body.twoFactor?.enabled === true);
    check('a second set-up is refused while it is on',
      (await user.post('/auth/2fa/setup', { currentPassword: PASSWORD })).status === 409);
    check('a session signed in with the password alone is ended',
      (await elsewhere.get('/auth/me')).status === 401);

    // ------------------------------------------------------------------
    section('Signing in with a code');
    // ------------------------------------------------------------------
    const second = new Client();
    const step1 = await second.signIn(email);
    check('a correct password asks for the code instead of signing in',
      step1.status === 200 && step1.body.twoFactorRequired === true && !step1.body.user, step1.body);
    check('no session is issued after the password alone', !second.cookies.has('rasibe_session'));
    const challengeLine = second.setCookies.find((l) => l.startsWith('rasibe_2fa=')) ?? '';
    check('the challenge cookie is HttpOnly, Secure and scoped to sign-in',
      /HttpOnly/i.test(challengeLine) && /Secure/i.test(challengeLine) && /Path=\/api\/auth/i.test(challengeLine),
      challengeLine);
    check('half signed in is not signed in', (await second.get('/auth/me')).status === 401);

    const challenge = second.cookies.get('rasibe_2fa') ?? '';
    const challengeRows = await anonQuery<{ token_hash: Buffer }>(
      `SELECT token_hash FROM login_challenge WHERE user_id = $1 ORDER BY issued_at DESC LIMIT 1`,
      [userId],
    );
    check('only a hash of the challenge is stored',
      challengeRows.length === 1 && !challengeRows[0].token_hash.toString('utf8').includes(challenge));

    const badCode = await second.post('/auth/login/verify', { code: '000000' });
    check('a wrong code is refused', badCode.status === 401 && badCode.body?.error === 'two_factor_invalid',
      badCode.body);

    await forgetLastStep(userId);
    const goodCode = totpAt(userSecret, Date.now());
    const verified = await second.post('/auth/login/verify', { code: goodCode });
    check('the right code signs in', verified.status === 200 && verified.body.user?.userId === userId,
      verified.body);
    check('the session is issued only now', second.cookies.has('rasibe_session'));
    check('the signed-in session works', (await second.get('/auth/me')).status === 200);
    check('the challenge cookie is cleared', !second.cookies.has('rasibe_2fa'));

    const failedRows = await anonQuery<any>(`SELECT failed_logins FROM app_user WHERE user_id = $1`, [userId]);
    check('the wrong code before it is forgiven once both factors are right',
      failedRows[0].failed_logins === 0, failedRows[0]);

    const reuse = new Client();
    reuse.cookies.set('rasibe_2fa', challenge);
    const reused = await reuse.post('/auth/login/verify', { code: goodCode });
    check('a challenge is spent once', reused.status === 401 && reused.body?.error === 'two_factor_expired',
      reused.body);

    const replay = new Client();
    await replay.signIn(email);
    const replayed = await replay.post('/auth/login/verify', { code: goodCode });
    check('a code that has been used cannot be used again', replayed.status === 401, replayed.body);

    const noChallenge = await new Client().post('/auth/login/verify', { code: goodCode });
    check('the code step cannot be reached without the password step',
      noChallenge.status === 401 && noChallenge.body?.error === 'two_factor_expired', noChallenge.body);
    await anonQuery(`UPDATE app_user SET failed_logins = 0 WHERE user_id = $1`, [userId]);

    // ------------------------------------------------------------------
    section('Recovery codes');
    // ------------------------------------------------------------------
    const lost = new Client();
    await lost.signIn(email);
    const typed = codes[0].toUpperCase().replace('-', ' ');
    const recovered = await lost.post('/auth/login/verify', { code: typed });
    check('a recovery code signs in, however it is typed',
      recovered.status === 200 && !!recovered.body.user, recovered.body);
    check('the response says how many are left', recovered.body?.recoveryCodesRemaining === 9,
      recovered.body?.recoveryCodesRemaining);
    check('using one is audited', (await auditCount('RECOVERY_CODE_USED', userId)) === 1);

    const again = new Client();
    await again.signIn(email);
    const spent = await again.post('/auth/login/verify', { code: codes[0] });
    check('a recovery code works once', spent.status === 401, spent.body);
    await anonQuery(`UPDATE app_user SET failed_logins = 0 WHERE user_id = $1`, [userId]);

    // ------------------------------------------------------------------
    section('Wrong codes count toward the lockout');
    // ------------------------------------------------------------------
    const guesser = new Client();
    await guesser.signIn(email);
    const guesses: number[] = [];
    for (let i = 0; i < 5; i++) {
      guesses.push((await guesser.post('/auth/login/verify', { code: String(100000 + i) })).status);
    }
    check('five wrong codes are refused', guesses.every((s) => s === 401), guesses);
    const afterGuesses = await guesser.post('/auth/login/verify', { code: totpAt(userSecret, Date.now()) });
    check('the challenge is dead after five wrong codes, even for the right one',
      afterGuesses.status === 401 && afterGuesses.body?.error === 'two_factor_expired', afterGuesses.body);
    const lockedOut = await new Client().signIn(email);
    check('and the account is locked, as for five wrong passwords', lockedOut.status === 423, lockedOut.status);
    await anonQuery(`UPDATE app_user SET failed_logins = 0, locked_until = NULL WHERE user_id = $1`, [userId]);
    await clearAttempts();

    // ------------------------------------------------------------------
    section('Turning it off');
    // ------------------------------------------------------------------
    await forgetLastStep(userId);
    check('turning it off needs a code',
      (await second.post('/auth/2fa/disable', { currentPassword: PASSWORD })).status === 400);
    check('turning it off needs the password',
      (await second.post('/auth/2fa/disable', {
        currentPassword: 'not the password', code: totpAt(userSecret, Date.now()),
      })).status === 401);
    check('a wrong code does not turn it off',
      (await second.post('/auth/2fa/disable', { currentPassword: PASSWORD, code: '000000' })).status === 400);
    const off = await second.post('/auth/2fa/disable', {
      currentPassword: PASSWORD, code: totpAt(userSecret, Date.now()),
    });
    check('the password and a code turn it off', off.status === 200, off.body);
    const cleared = await anonQuery<any>(
      `SELECT totp_secret, totp_enabled_at,
              (SELECT count(*)::int FROM recovery_code WHERE user_id = $1) AS codes
         FROM app_user WHERE user_id = $1`,
      [userId],
    );
    check('the secret and the recovery codes are removed',
      cleared[0].totp_secret === null && cleared[0].totp_enabled_at === null && cleared[0].codes === 0,
      cleared[0]);
    check('turning it off is audited', (await auditCount('TWO_FACTOR_DISABLED', userId)) === 1);
    const direct = await new Client().signIn(email);
    check('the password alone signs in again', direct.status === 200 && !!direct.body.user, direct.body);

    // ------------------------------------------------------------------
    section('Administrator reset, for a lost phone');
    // ------------------------------------------------------------------
    const adminEmail = unique('twofactor.admin');
    const adminId = await createUser(adminEmail, 'Fixture TwoFactor Admin', 'ADMINISTRATOR');
    const admin = new Client();
    await admin.signIn(adminEmail);

    const victim = new Client();
    await victim.signIn(email);
    await enrol(victim);

    const recruiter = new Client();
    await recruiter.signIn('nosipho@rasibe.co.za');
    check('a recruiter cannot reset anybody',
      (await recruiter.post(`/auth/2fa/reset/${userId}`, { reason: 'Lost phone, confirmed by phone call' }))
        .status === 403);
    check('a reason is required',
      (await admin.post(`/auth/2fa/reset/${userId}`, {})).status === 400);
    check('an administrator cannot reset their own',
      (await admin.post(`/auth/2fa/reset/${adminId}`, { reason: 'Trying to reset myself here' })).status === 403);
    check('an unknown account is not found',
      (await admin.post('/auth/2fa/reset/00000000-0000-0000-0000-000000000000', {
        reason: 'Lost phone, confirmed by phone call',
      })).status === 404);

    const reset = await admin.post(`/auth/2fa/reset/${userId}`, { reason: 'Lost phone, confirmed by phone call' });
    check('an administrator resets someone else', reset.status === 200, reset.body);
    const afterReset = await anonQuery<any>(
      `SELECT totp_secret, (SELECT count(*)::int FROM recovery_code WHERE user_id = $1) AS codes
         FROM app_user WHERE user_id = $1`,
      [userId],
    );
    check('the reset removes the secret and the recovery codes',
      afterReset[0].totp_secret === null && afterReset[0].codes === 0, afterReset[0]);
    check('the person is signed out everywhere', (await victim.get('/auth/me')).status === 401);
    const resetAudit = await anonQuery<any>(
      `SELECT actor_user_id, reason FROM audit_entry
        WHERE action = 'TWO_FACTOR_RESET' AND entity_id = $1`,
      [userId],
    );
    check('the reset is audited with who did it and why',
      resetAudit.length === 1 && resetAudit[0].actor_user_id === adminId
        && resetAudit[0].reason === 'Lost phone, confirmed by phone call', resetAudit);
    check('resetting an account without two-factor is refused',
      (await admin.post(`/auth/2fa/reset/${userId}`, { reason: 'Lost phone, confirmed by phone call' }))
        .status === 409);
    check('they can sign in with the password and enrol again',
      (await new Client().signIn(email)).body?.user?.userId === userId);

    // ------------------------------------------------------------------
    section('Requiring it for administrators (REQUIRE_ADMIN_2FA)');
    // ------------------------------------------------------------------
    check('off by default: an administrator without it works as before',
      (await admin.get('/users')).status === 200);

    process.env.REQUIRE_ADMIN_2FA = 'true';
    const held = await admin.get('/users');
    check('when on, an administrator without it is held at enrolment',
      held.status === 403 && held.body?.error === 'two_factor_enrolment_required', held.body);
    const me = await admin.get('/auth/me');
    check('/auth/me still answers, and says enrolment is required',
      me.status === 200 && me.body.twoFactor?.required === true && me.body.twoFactor?.enabled === false,
      me.body?.twoFactor);
    check('other roles are not affected', (await recruiter.get('/consultants')).status === 200);

    const adminFactor = await enrol(admin);
    check('the administrator can enrol while held', adminFactor.codes.length === 10);
    // Enrolling revoked every other session, but not this one.
    check('and is then let through', (await admin.get('/users')).status === 200);
    await forgetLastStep(adminId);
    const keep = await admin.post('/auth/2fa/disable', {
      currentPassword: PASSWORD, code: totpAt(adminFactor.secret, Date.now()),
    });
    check('an administrator cannot turn it off while it is required', keep.status === 403, keep.body);
  } finally {
    if (savedRequire === undefined) delete process.env.REQUIRE_ADMIN_2FA;
    else process.env.REQUIRE_ADMIN_2FA = savedRequire;
    await clearAttempts();
    server.close();
    await closePool();
  }

  console.log(`\n${'='.repeat(58)}`);
  console.log(`  ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('\n  Failures:');
    failures.forEach((f) => console.log(`   - ${f}`));
  }
  console.log('='.repeat(58));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('Test run could not complete:', e); process.exit(1); });
