/**
 * Integration test suite.
 *
 * Starts the API in-process against the real PostgreSQL database and exercises
 * the behaviour the requirements turn on. These are not unit tests with mocks:
 * every assertion below goes through the HTTP layer, the application layer and
 * the database, so a constraint or trigger that stopped working would fail here.
 *
 * Run with:  npm test
 */
import { createApp } from '../index.js';
import { closePool } from '../lib/db.js';
import type { Server } from 'node:http';

const PORT = Number(process.env.TEST_PORT ?? 4100);
const BASE = `http://127.0.0.1:${PORT}/api`;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  \u2717 ${name}`);
    if (detail !== undefined) console.log(`      ${JSON.stringify(detail).slice(0, 300)}`);
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------
// A tiny cookie-aware client, so sessions behave as they do in a browser
// ---------------------------------------------------------------------
class Client {
  cookie = '';
  constructor(public label: string) {}

  async request(method: string, path: string, body?: unknown) {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.cookie ? { Cookie: this.cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json };
  }

  get = (p: string) => this.request('GET', p);
  post = (p: string, b?: unknown) => this.request('POST', p, b);
  put = (p: string, b?: unknown) => this.request('PUT', p, b);
  patch = (p: string, b?: unknown) => this.request('PATCH', p, b);

  async login(email: string) {
    const r = await this.post('/auth/login', { email, password: 'Password123!' });
    if (r.status !== 200) throw new Error(`${this.label} could not sign in: ${JSON.stringify(r.body)}`);
    return r.body;
  }
}

async function main() {
  const app = createApp();
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(PORT, () => resolve(s));
  });

  const admin = new Client('administrator');
  const recruiter = new Client('recruiter');
  const consultant = new Client('consultant');
  const clientMgr = new Client('client manager');

  try {
    // -----------------------------------------------------------------
    section('Authentication (FR-AUT)');
    // -----------------------------------------------------------------
    await admin.login('christinah@rasibe.co.za');
    const a = (await admin.get('/auth/me')).body;
    check('administrator signs in', a.user.role === 'ADMINISTRATOR', a);
    check('administrator lands on the dashboard', a.landing === '/dashboard', a.landing);

    await recruiter.login('nosipho@rasibe.co.za');
    const r = (await recruiter.get('/auth/me')).body;
    check('recruiter signs in', r.user.role === 'RECRUITER');

    await consultant.login('thabo.m@example.co.za');
    const c = (await consultant.get('/auth/me')).body;
    check('consultant signs in', c.user.role === 'CONSULTANT');
    check('consultant lands on their timesheets', c.landing === '/my/timesheets', c.landing);

    await clientMgr.login('s.naidoo@nedgroupit.co.za');
    const cm = (await clientMgr.get('/auth/me')).body;
    check('client manager signs in', cm.user.role === 'CLIENT_MANAGER');

    const bad = await new Client('x').post('/auth/login', {
      email: 'christinah@rasibe.co.za', password: 'not the password',
    });
    check('a wrong password is refused', bad.status === 401, bad.body);
    check('the refusal does not reveal whether the account exists',
      bad.body?.message === 'Email address or password is incorrect', bad.body);

    const anon = await new Client('anon').get('/consultants');
    check('an unauthenticated request is refused', anon.status === 401);

    // -----------------------------------------------------------------
    section('Rate confidentiality (NFR-SEC-003, NFR-SEC-004, BR-006, BR-007)');
    // -----------------------------------------------------------------
    const adminPl = await admin.get('/placements');
    const first = adminPl.body.items[0];
    check('administrator sees the bill rate', first.bill_rate !== undefined);
    check('administrator sees the pay rate', first.pay_rate !== undefined);
    check('administrator sees the margin', first.margin_amount !== undefined);

    const recPl = await recruiter.get('/placements');
    check('recruiter sees both rates', recPl.body.items[0].bill_rate !== undefined
      && recPl.body.items[0].pay_rate !== undefined);
    check('recruiter never sees the margin',
      recPl.body.items[0].margin_amount === undefined, recPl.body.items[0]);

    const conPl = await consultant.get('/placements');
    const mine = conPl.body.items[0];
    check('consultant sees only their own placements',
      conPl.body.items.every((p: any) => p.consultant_id === c.user.consultantId), conPl.body.items.length);
    check('consultant NEVER receives the bill rate', mine.bill_rate === undefined, mine);
    check('consultant NEVER receives the margin', mine.margin_amount === undefined, mine);
    check('consultant does receive their own pay rate', mine.pay_rate !== undefined);

    const cmPl = await clientMgr.get('/placements');
    const theirs = cmPl.body.items[0];
    check('client manager sees only their own company',
      cmPl.body.items.every((p: any) => p.client_id === cm.user.clients[0].clientId));
    check('client manager NEVER receives the pay rate', theirs.pay_rate === undefined, theirs);
    check('client manager NEVER receives the margin', theirs.margin_amount === undefined, theirs);
    check('client manager does receive the bill rate they are charged',
      theirs.bill_rate !== undefined);

    const marginAsRecruiter = await recruiter.get('/reports/margin');
    check('recruiter is refused the margin report', marginAsRecruiter.status === 403);
    const marginAsAdmin = await admin.get('/reports/margin');
    check('administrator may read the margin report', marginAsAdmin.status === 200);

    // -----------------------------------------------------------------
    section('Data isolation (BR-013, NFR-PRI-003)');
    // -----------------------------------------------------------------
    const cmClients = await clientMgr.get('/clients');
    check('client manager sees exactly one client company',
      cmClients.body.items.length === 1, cmClients.body.items.map((x: any) => x.legal_name));

    const cmConsultants = await clientMgr.get('/consultants');
    const profile = cmConsultants.body.items[0];
    check('client manager sees the anonymous professional profile only',
      profile && profile.full_name === undefined && profile.id_number === undefined
      && profile.email === undefined, profile);
    check('the professional profile still carries skills and seniority',
      profile?.seniority !== undefined);

    const adminConsultant = await admin.get(`/consultants/${c.user.consultantId}`);
    check('administrator may see the identity number',
      adminConsultant.body.id_number !== undefined);
    check('administrator may see banking details',
      adminConsultant.body.bank_account_ref !== undefined);

    const recConsultant = await recruiter.get(`/consultants/${c.user.consultantId}`);
    check('recruiter may NOT see banking details',
      recConsultant.body.bank_account_ref === undefined, recConsultant.body);
    check('recruiter may NOT see vetting results',
      recConsultant.body.vetting_status === undefined);

    // -----------------------------------------------------------------
    section('Placements (BR-001, BR-014)');
    // -----------------------------------------------------------------
    const pool_ = await recruiter.get('/consultants?availability=AVAILABLE');
    const free = pool_.body.items[0];
    const clients = await recruiter.get('/clients');
    const clientId = clients.body.items[0].client_id;

    const overlapA = await recruiter.post('/placements', {
      consultantId: free.consultant_id, clientId, jobTitle: 'Test placement A',
      startDate: '2027-01-04', endDate: '2027-06-30', billRate: 900, payRate: 600,
    });
    check('a placement can be created', overlapA.status === 201, overlapA.body);

    const overlapB = await recruiter.post('/placements', {
      consultantId: free.consultant_id, clientId, jobTitle: 'Test placement B',
      startDate: '2027-05-01', endDate: '2027-12-31', billRate: 900, payRate: 600,
    });
    check('an overlapping full-time placement is refused (BR-001)',
      overlapB.status === 409, overlapB.body);
    check('the refusal names the rule',
      String(overlapB.body?.message).includes('BR-001'), overlapB.body?.message);

    const badDates = await recruiter.post('/placements', {
      consultantId: free.consultant_id, clientId, jobTitle: 'Bad dates',
      startDate: '2028-06-01', endDate: '2028-01-01', billRate: 900, payRate: 600,
    });
    check('an end date before the start date is refused (BR-014)', badDates.status === 400);

    const lossMaking = await recruiter.post('/placements', {
      consultantId: free.consultant_id, clientId, jobTitle: 'Loss making',
      startDate: '2029-01-01', endDate: '2029-06-30', billRate: 500, payRate: 800,
    });
    check('a pay rate above the bill rate is refused', lossMaking.status === 400);

    const rateChangeByRecruiter = await recruiter.patch(
      `/placements/${overlapA.body.placement_id}/rates`,
      { billRate: 1000, payRate: 600, reason: 'attempted by a recruiter' });
    check('a recruiter may not change rates (BR-009)',
      rateChangeByRecruiter.status === 403, rateChangeByRecruiter.body);

    // -----------------------------------------------------------------
    section('Submissions and consent (BR-012, BR-022)');
    // -----------------------------------------------------------------
    const requests = await recruiter.get('/requests');
    const openReq = requests.body.items.find((x: any) => x.status !== 'FILLED');

    const newCon = await recruiter.post('/consultants', {
      fullName: 'Consent Test Person', email: `consent.${Date.now()}@example.co.za`,
      seniority: 'SENIOR', availability: 'AVAILABLE',
    });
    check('a consultant can be added to the pool', newCon.status === 201, newCon.body);

    const withoutConsent = await recruiter.post(`/requests/${openReq.request_id}/submissions`, {
      consultantId: newCon.body.consultant_id,
    });
    check('submitting without recorded consent is refused (BR-012)',
      withoutConsent.status === 409, withoutConsent.body);

    await recruiter.post(`/consultants/${newCon.body.consultant_id}/consent`, {
      reason: 'Consent given by telephone',
    });
    const withConsent = await recruiter.post(`/requests/${openReq.request_id}/submissions`, {
      consultantId: newCon.body.consultant_id, proposedBillRate: 900, proposedPayRate: 600,
    });
    check('submitting after consent is accepted', withConsent.status === 201, withConsent.body);

    const duplicate = await recruiter.post(`/requests/${openReq.request_id}/submissions`, {
      consultantId: newCon.body.consultant_id,
    });
    check('a duplicate submission to the same request is refused (BR-022)',
      duplicate.status === 409, duplicate.body);

    // -----------------------------------------------------------------
    section('Timesheets (BR-004, BR-005, BR-008, BR-018)');
    // -----------------------------------------------------------------
    const current = await consultant.get('/timesheets/my/current');
    check('the consultant has a current week', current.body.items.length > 0, current.body);
    const sheet = current.body.items[0];
    const ws = sheet.week_start.slice(0, 10);

    const future = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const futureSave = await consultant.put(`/timesheets/${sheet.timesheet_id}/lines`, {
      lines: [{ workDate: future, normalHours: 8, overtimeHours: 0 }],
    });
    check('hours on a future date are refused (BR-004)', futureSave.status === 400, futureSave.body);

    const days = [0, 1, 2, 3, 4].map((i) => {
      const d = new Date(ws + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + i);
      return d.toISOString().slice(0, 10);
    }).filter((d) => d <= new Date().toISOString().slice(0, 10));

    const save = await consultant.put(`/timesheets/${sheet.timesheet_id}/lines`, {
      lines: days.map((d) => ({ workDate: d, normalHours: 8, overtimeHours: 0 })),
    });
    check('a draft week can be saved', save.status === 200, save.body);
    check('weekly totals are derived from the day lines',
      Number(save.body.total_standard_hours) === days.length * 8, save.body.total_standard_hours);

    const overMax = await consultant.put(`/timesheets/${sheet.timesheet_id}/lines`, {
      lines: [{ workDate: days[0], normalHours: 20, overtimeHours: 0 }],
    });
    check('a day above the configured maximum is refused (BR-016)',
      overMax.status === 400, overMax.body?.message);

    await consultant.put(`/timesheets/${sheet.timesheet_id}/lines`, {
      lines: days.map((d) => ({ workDate: d, normalHours: 8, overtimeHours: 0 })),
    });

    const submitted = await consultant.post(`/timesheets/${sheet.timesheet_id}/submit`);
    check('the week can be submitted', submitted.status === 200, submitted.body);
    check('the rates are snapshotted at submission (BR-008)',
      submitted.body.bill_rate === undefined && submitted.body.pay_rate !== undefined, submitted.body);

    const editAfterSubmit = await consultant.put(`/timesheets/${sheet.timesheet_id}/lines`, {
      lines: days.map((d) => ({ workDate: d, normalHours: 9, overtimeHours: 0 })),
    });
    check('a submitted week can no longer be edited by the consultant (BR-018)',
      editAfterSubmit.status === 409, editAfterSubmit.body);

    const rejectNoReason = await clientMgr.post(`/timesheets/${sheet.timesheet_id}/decision`, {
      decision: 'REJECT',
    });
    check('a rejection without a reason is refused (BR-005)',
      rejectNoReason.status === 400, rejectNoReason.body);

    const consultantApproving = await consultant.post(`/timesheets/${sheet.timesheet_id}/decision`, {
      decision: 'APPROVE',
    });
    check('a consultant may not approve their own week',
      consultantApproving.status === 403, consultantApproving.body);

    const approved = await clientMgr.post(`/timesheets/${sheet.timesheet_id}/decision`, {
      decision: 'APPROVE',
    });
    check('the client manager can approve the week', approved.status === 200, approved.body);
    check('the approved week carries the bill rate for the approver',
      approved.body.bill_rate !== undefined && approved.body.pay_rate === undefined, approved.body);

    // BR-008 in full: change the placement rate, the approved week must not move
    const before = await admin.get(`/timesheets/${sheet.timesheet_id}`);
    await admin.patch(`/placements/${sheet.placement_id}/rates`, {
      billRate: 1500, payRate: 700, reason: 'Renegotiated with the client',
    });
    const after = await admin.get(`/timesheets/${sheet.timesheet_id}`);
    check('a later rate change does NOT alter the approved week (BR-008)',
      after.body.bill_rate === before.body.bill_rate, {
        before: before.body.bill_rate, after: after.body.bill_rate,
      });

    const placementAfter = await admin.get(`/placements?status=PENDING_RATE_APPROVAL`);
    check('a rate change returns the placement for approval (BR-009)',
      placementAfter.body.items.some((p: any) => p.placement_id === sheet.placement_id),
      placementAfter.body.items.length);

    const reapprove = await admin.post(`/placements/${sheet.placement_id}/approve-rates`, {
      reason: 'Re-approved after the rate change',
    });
    check('approving the new rates returns the placement to active',
      reapprove.status === 200 && ['ACTIVE', 'ENDING_SOON'].includes(reapprove.body.status),
      reapprove.body?.status);

    // -----------------------------------------------------------------
    section('Offline synchronisation (FR-MOB-004 to 008, BR-019)');
    // -----------------------------------------------------------------
    const conPlacements = await consultant.get('/placements');
    const activePl = conPlacements.body.items.find((p: any) =>
      ['ACTIVE', 'ENDING_SOON'].includes(p.status));

    const priorWeek = (() => {
      const d = new Date(ws + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - 7);
      return d.toISOString().slice(0, 10);
    })();
    const priorDays = [0, 1, 2].map((i) => {
      const d = new Date(priorWeek + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + i);
      return d.toISOString().slice(0, 10);
    });

    const token = crypto.randomUUID();
    const syncBody = {
      clientUuid: token,
      placementId: activePl.placement_id,
      weekStart: priorWeek,
      rowVersion: 0,
      submit: true,
      lines: priorDays.map((d) => ({ workDate: d, normalHours: 8, overtimeHours: 0 })),
    };

    const sync1 = await consultant.post('/timesheets/sync', syncBody);
    check('an offline week synchronises', sync1.status === 200 && sync1.body.outcome === 'accepted',
      sync1.body);

    const sync2 = await consultant.post('/timesheets/sync', syncBody);
    check('retransmitting the same token creates no duplicate (BR-019, NFR-REL-005)',
      sync2.body.outcome === 'already_accepted', sync2.body);
    check('the duplicate returns the same timesheet',
      sync2.body.timesheet.timesheet_id === sync1.body.timesheet.timesheet_id);

    // the server moves on, then a stale device tries to write
    await clientMgr.post(`/timesheets/${sync1.body.timesheet.timesheet_id}/decision`, {
      decision: 'APPROVE',
    });
    const staleSync = await consultant.post('/timesheets/sync', {
      ...syncBody,
      clientUuid: crypto.randomUUID(),
      rowVersion: 0,
    });
    check('a stale offline submission is refused and the server version kept (BR-019)',
      staleSync.body.outcome === 'conflict', staleSync.body);
    check('the consultant is told the local copy was not discarded',
      String(staleSync.body.message).includes('not been discarded'), staleSync.body.message);

    // -----------------------------------------------------------------
    section('Invoicing (BR-003, BR-010, BR-011, NFR-REL-001)');
    // -----------------------------------------------------------------
    const clientOfPlacement = activePl.client_id;
    const prep = await admin.post('/invoices/prepare', {
      clientId: clientOfPlacement,
      periodStart: priorWeek,
      periodEnd: new Date().toISOString().slice(0, 10),
    });
    check('an invoice can be prepared from approved hours', prep.status === 201, prep.body?.message);
    check('unapproved weeks are reported rather than silently dropped',
      Array.isArray(prep.body.outstanding), prep.body?.outstanding?.length);

    const invId = prep.body.invoice.invoice_id;
    check('a draft invoice carries no number yet (BR-010)',
      prep.body.invoice.invoice_number === null, prep.body.invoice.invoice_number);

    const issueBeforeApprove = await admin.post(`/invoices/${invId}/issue`);
    check('an invoice cannot be issued before approval (BR-010)',
      issueBeforeApprove.status === 409, issueBeforeApprove.body);

    await admin.post(`/invoices/${invId}/approve`);
    const issued = await admin.post(`/invoices/${invId}/issue`);
    check('the invoice can be issued once approved', issued.status === 200, issued.body);
    check('a number is allocated at issue (BR-010)',
      typeof issued.body.invoice_number === 'string'
      && issued.body.invoice_number.startsWith('INV-'), issued.body.invoice_number);

    const invoicedWeeks = await admin.get(`/timesheets?status=INVOICED`);
    check('the included weeks are marked invoiced in the same transaction (NFR-REL-001)',
      invoicedWeeks.body.items.length > 0, invoicedWeeks.body.items.length);

    const reprep = await admin.post('/invoices/prepare', {
      clientId: clientOfPlacement,
      periodStart: priorWeek,
      periodEnd: new Date().toISOString().slice(0, 10),
    });
    check('the same hours cannot be billed a second time (BR-003)',
      reprep.body.invoice === null, reprep.body?.message);

    const recruiterIssuing = await recruiter.post(`/invoices/${invId}/issue`);
    check('a recruiter may not issue an invoice', recruiterIssuing.status === 403);

    const credit = await admin.post(`/invoices/${invId}/credit-note`, {
      reason: 'Hours corrected after issue',
    });
    check('correction is a credit note, not an amendment (BR-011)',
      credit.status === 201 && Number(credit.body.total) < 0, credit.body?.total);

    // -----------------------------------------------------------------
    section('Dashboard, reports and audit');
    // -----------------------------------------------------------------
    const dashAdmin = await admin.get('/dashboard');
    check('the administrator dashboard includes margin', dashAdmin.body.margin !== undefined);
    const dashRec = await recruiter.get('/dashboard');
    check('the recruiter dashboard omits margin', dashRec.body.margin === undefined, dashRec.body);
    check('the dashboard reports outstanding timesheets',
      dashAdmin.body.timesheets?.awaiting_approval !== undefined, dashAdmin.body.timesheets);

    const audit = await admin.get('/reports/audit');
    check('the audit log records actions', audit.body.items.length > 0, audit.body.items.length);
    check('a rate change is recorded in the audit log',
      audit.body.items.some((x: any) => x.action === 'RATE_CHANGED'),
      audit.body.items.map((x: any) => x.action).slice(0, 8));
    check('an approval is distinguishable from an override',
      audit.body.items.some((x: any) => x.action === 'TIMESHEET_APPROVED'));

    const auditAsRecruiter = await recruiter.get('/reports/audit');
    check('a recruiter may not read the audit log', auditAsRecruiter.status === 403);

    const notifications = await consultant.get('/notifications');
    check('the consultant received notifications',
      notifications.body.items.length > 0, notifications.body.items.length);
    check('notifications carry a rendered subject',
      typeof notifications.body.items[0]?.subject === 'string');

    // -----------------------------------------------------------------
    section('Validation and error handling');
    // -----------------------------------------------------------------
    const badBody = await recruiter.post('/consultants', { fullName: 'X' });
    check('invalid input returns a field-level message', badBody.status === 400
      && badBody.body.detail !== undefined, badBody.body);

    const missing = await admin.get('/consultants/00000000-0000-0000-0000-000000000000');
    check('a missing record returns 404', missing.status === 404);

    const badUuid = await admin.get('/consultants/not-a-uuid');
    check('a malformed identifier is rejected, not crashed on', badUuid.status === 400);

    const noRoute = await admin.get('/nonexistent');
    check('an unknown endpoint returns 404', noRoute.status === 404);

    // -----------------------------------------------------------------
    section('Sign out');
    // -----------------------------------------------------------------
    await consultant.post('/auth/logout');
    const afterLogout = await consultant.get('/timesheets/my/current');
    check('the session is revoked on sign out', afterLogout.status === 401);
  } finally {
    server.close();
    await closePool();
  }

  console.log(`\n${'='.repeat(58)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\n  Failures:');
    failures.forEach((f) => console.log(`   - ${f}`));
  }
  console.log('='.repeat(58));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('Test run could not complete:', e);
  process.exit(1);
});
