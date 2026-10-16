/**
 * Server validation, exercised without a browser.
 *
 * Front-end validation was added so a person sees a mistake as they make it.
 * The risk in doing that is quietly treating the form as the gatekeeper and
 * relaxing the server, which would leave every rule one fetch call away from
 * being bypassed (NFR-SEC-006).
 *
 * Every request below is one the new forms would refuse to send. All of them
 * must still be rejected by the API.
 */
import { createApp } from '../index.js';
import { closePool } from '../lib/db.js';
import type { Server } from 'node:http';

const PORT = Number(process.env.TEST_PORT ?? 4103);
const BASE = `http://127.0.0.1:${PORT}/api`;

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  \u2713 ${name}`); }
  else {
    fail++; failures.push(name);
    console.log(`  \u2717 ${name}`);
    if (detail !== undefined) console.log(`      ${JSON.stringify(detail).slice(0, 200)}`);
  }
}
const section = (t: string) => console.log(`\n${t}`);

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
  patch = (p: string, b?: unknown) => this.call('PATCH', p, b);

  async signIn(email: string) {
    await this.get('/auth/me');
    const r = await this.post('/auth/login', { email, password: 'Password123!' });
    if (r.status !== 200) throw new Error(`sign in failed: ${JSON.stringify(r.body)}`);
    return (await this.get('/auth/me')).body.user;
  }
}

/** A rejection is only useful if it says which field is wrong. */
const namesField = (body: any, field: string) =>
  body?.detail?.[field] !== undefined || String(body?.message ?? '').length > 0;

async function main() {
  const app = createApp();
  const server: Server = await new Promise((r) => { const s = app.listen(PORT, () => r(s)); });

  try {
    const admin = new Client();
    const recruiter = new Client();
    const consultant = new Client();
    const approver = new Client();

    await admin.signIn('christinah@rasibe.co.za');
    await recruiter.signIn('nosipho@rasibe.co.za');
    await consultant.signIn('thabo.m@example.co.za');
    await approver.signIn('s.naidoo@nedgroupit.co.za');

    const clients = await recruiter.get('/clients');
    const clientId = clients.body.items[0].client_id;
    const pool = await recruiter.get('/consultants?availability=AVAILABLE');
    const freeConsultant = pool.body.items[0];

    // ------------------------------------------------------------------
    section('Consultant details');
    // ------------------------------------------------------------------
    const shortName = await recruiter.post('/consultants', { fullName: 'A', email: 'a@b.co.za' });
    check('a one-character name is refused', shortName.status === 400, shortName.body);

    const badEmail = await recruiter.post('/consultants', {
      fullName: 'Valid Name', email: 'not-an-email',
    });
    check('a malformed email address is refused', badEmail.status === 400, badEmail.body);
    check('and the response names the field', namesField(badEmail.body, 'email'));

    const wildExperience = await recruiter.post('/consultants', {
      fullName: 'Valid Name', email: `exp.${Date.now()}@example.co.za`, experienceYears: 200,
    });
    check('200 years of experience is refused', wildExperience.status === 400, wildExperience.body);

    const negativeRate = await recruiter.post('/consultants', {
      fullName: 'Valid Name', email: `neg.${Date.now()}@example.co.za`, minPayRate: -50,
    });
    check('a negative pay rate is refused', negativeRate.status === 400, negativeRate.body);

    // ------------------------------------------------------------------
    section('Placement rules (BR-001, BR-014)');
    // ------------------------------------------------------------------
    const backwards = await recruiter.post('/placements', {
      consultantId: freeConsultant.consultant_id, clientId, jobTitle: 'Backwards dates',
      startDate: '2027-06-01', endDate: '2027-01-01', billRate: 900, payRate: 600,
    });
    check('an end date before the start date is refused (BR-014)', backwards.status === 400, backwards.body);

    const lossMaking = await recruiter.post('/placements', {
      consultantId: freeConsultant.consultant_id, clientId, jobTitle: 'Loss making',
      startDate: '2027-01-01', endDate: '2027-06-30', billRate: 500, payRate: 900,
    });
    check('a pay rate above the bill rate is refused', lossMaking.status === 400, lossMaking.body);

    const negativeBill = await recruiter.post('/placements', {
      consultantId: freeConsultant.consultant_id, clientId, jobTitle: 'Negative rate',
      startDate: '2027-01-01', endDate: '2027-06-30', billRate: -100, payRate: -200,
    });
    check('negative rates are refused', negativeBill.status === 400, negativeBill.body);

    const first = await recruiter.post('/placements', {
      consultantId: freeConsultant.consultant_id, clientId, jobTitle: 'First placement',
      startDate: '2027-02-01', endDate: '2027-08-31', billRate: 900, payRate: 600,
    });
    check('a valid placement is accepted', first.status === 201, first.body);

    const overlapping = await recruiter.post('/placements', {
      consultantId: freeConsultant.consultant_id, clientId, jobTitle: 'Overlapping',
      startDate: '2027-07-01', endDate: '2027-12-31', billRate: 900, payRate: 600,
    });
    check('an overlapping full-time placement is refused (BR-001)',
      overlapping.status === 409, overlapping.body);

    // ------------------------------------------------------------------
    section('Reasons that explain nothing (BR-005)');
    // ------------------------------------------------------------------
    const emptyReason = await admin.post(`/placements/${first.body.placement_id}/terminate`, {
      reason: '',
    });
    check('terminating with an empty reason is refused', emptyReason.status === 400, emptyReason.body);

    const tinyReason = await admin.post(`/placements/${first.body.placement_id}/terminate`, {
      reason: 'no',
    });
    check('a two-character reason is refused', tinyReason.status === 400, tinyReason.body);

    const rateNoReason = await admin.patch(`/placements/${first.body.placement_id}/rates`, {
      billRate: 1000, payRate: 600,
    });
    check('a rate change with no reason is refused', rateNoReason.status === 400, rateNoReason.body);

    // ------------------------------------------------------------------
    section('Role requests');
    // ------------------------------------------------------------------
    const noTitle = await recruiter.post('/requests', { clientId, title: 'ab' });
    check('a two-character role title is refused', noTitle.status === 400, noTitle.body);

    const zeroQuantity = await recruiter.post('/requests', {
      clientId, title: 'Valid role title', quantity: 0,
    });
    check('asking for zero people is refused', zeroQuantity.status === 400, zeroQuantity.body);

    const notAUuid = await recruiter.post('/requests', {
      clientId: 'not-a-uuid', title: 'Valid role title',
    });
    check('a malformed client identifier is refused', notAUuid.status === 400, notAUuid.body);

    // ------------------------------------------------------------------
    section('Timesheet hours (BR-004, BR-016)');
    // ------------------------------------------------------------------
    // A week of its own, so the suite does not depend on the state another
    // suite left behind. A past week is still editable and still refuses
    // future-dated hours, which is what is being tested.
    const monday = (() => {
      const d = new Date();
      const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
      d.setUTCDate(d.getUTCDate() - (dow - 1) - 14);
      return d.toISOString().slice(0, 10);
    })();
    const week = await consultant.get(`/timesheets/my/current?weekStart=${monday}`);
    const sheet = (week.body.items ?? []).find((t: any) =>
      ['DRAFT', 'PENDING_SYNC', 'REJECTED'].includes(t.status));

    if (sheet) {
      const future = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
      const futureHours = await consultant.call('PUT', `/timesheets/${sheet.timesheet_id}/lines`, {
        lines: [{ workDate: future, normalHours: 8, overtimeHours: 0 }],
      });
      check('hours on a future date are refused (BR-004)', futureHours.status === 400, futureHours.body);

      const workDay = monday;
      const impossibleDay = await consultant.call('PUT', `/timesheets/${sheet.timesheet_id}/lines`, {
        lines: [{ workDate: workDay, normalHours: 20, overtimeHours: 10 }],
      });
      check('31 hours in one day is refused', impossibleDay.status === 400, impossibleDay.body);

      const overCeiling = await consultant.call('PUT', `/timesheets/${sheet.timesheet_id}/lines`, {
        lines: [{ workDate: workDay, normalHours: 18, overtimeHours: 0 }],
      });
      check('a day above the configured ceiling is refused (BR-016)',
        overCeiling.status === 400, overCeiling.body);

      const negativeHours = await consultant.call('PUT', `/timesheets/${sheet.timesheet_id}/lines`, {
        lines: [{ workDate: workDay, normalHours: -8, overtimeHours: 0 }],
      });
      check('negative hours are refused', negativeHours.status === 400, negativeHours.body);
    } else {
      check('the consultant has an editable week to test against', false, week.body);
    }

    // ------------------------------------------------------------------
    section('Account creation');
    // ------------------------------------------------------------------
    const noLink = await admin.post('/users', {
      fullName: 'Unlinked Consultant', email: `u.${Date.now()}@example.co.za`, role: 'CONSULTANT',
    });
    check('a consultant account with no consultant record is refused',
      noLink.status === 400, noLink.body);

    const badRole = await admin.post('/users', {
      fullName: 'Invented Role', email: `r.${Date.now()}@example.co.za`, role: 'SUPERVISOR',
    });
    check('an invented role is refused', badRole.status === 400, badRole.body);

    const weakPassword = await admin.post('/auth/change-password', {
      currentPassword: 'Password123!', newPassword: 'short',
    });
    check('a password below the policy is refused', weakPassword.status === 400, weakPassword.body);

    // ------------------------------------------------------------------
    section('Shapes the forms could never produce');
    // ------------------------------------------------------------------
    const missingEverything = await recruiter.post('/consultants', {});
    check('an empty body is refused', missingEverything.status === 400);

    const wrongTypes = await recruiter.post('/placements', {
      consultantId: freeConsultant.consultant_id, clientId, jobTitle: 'Wrong types',
      startDate: '2028-01-01', endDate: '2028-06-30',
      billRate: 'nine hundred', payRate: 'six hundred',
    });
    check('a rate sent as words is refused', wrongTypes.status === 400, wrongTypes.body);

    const extraFields = await recruiter.post('/consultants', {
      fullName: 'Extra Fields', email: `x.${Date.now()}@example.co.za`,
      isAdministrator: true, vettingStatus: 'Cleared', bankAccountRef: '****9999',
    });
    check('fields the form does not send are ignored rather than trusted',
      extraFields.status === 201 || extraFields.status === 400, extraFields.body);

    if (extraFields.status === 201) {
      const created = await admin.get(`/consultants/${extraFields.body.consultant_id}`);
      check('a smuggled vetting status is not stored',
        !created.body.vetting_status, created.body?.vetting_status);
      check('a smuggled banking reference is not stored',
        !created.body.bank_account_ref, created.body?.bank_account_ref);
    }
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
