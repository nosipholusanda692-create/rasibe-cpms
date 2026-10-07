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
import { anonQuery, closePool, withActor, type Actor } from '../lib/db.js';
import { TLS_CIPHERS } from '../lib/https.js';
import http, { type Server } from 'node:http';

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
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

class Client {
  cookies = new Map<string, string>();
  constructor(public label: string) {}

  async request(method: string, path: string, body?: unknown) {
    // A browser reads before it can write, and that read is how the CSRF token
    // arrives. Doing the same here keeps a fresh client's first write honest
    // rather than special-casing the token into existence.
    if (!SAFE_METHODS.has(method) && !this.cookies.has('rasibe_csrf')) {
      await this.request('GET', '/auth/me');
    }

    const csrf = this.cookies.get('rasibe_csrf');
    const res = await fetch(BASE + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.cookies.size ? { Cookie: this.cookieHeader() } : {}),
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.absorb(res);
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json };
  }

  private cookieHeader() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  /** getSetCookie keeps the headers separate; get() would join them into one. */
  private absorb(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const pair = line.split(';')[0];
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1);
      // Clearing a cookie sends an empty value with a past expiry.
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
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

/**
 * A request with a chosen Host header.
 *
 * `fetch` will not send one — undici treats Host as forbidden and sets it from
 * the URL — and forging it is the whole point of the redirect checks below, so
 * those go through node:http instead.
 */
function rawGet(port: number, path: string, hostHeader: string) {
  return new Promise<{ status: number; location: string }>((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { Host: hostHeader } },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, location: String(res.headers.location ?? '') });
      },
    );
    req.on('error', reject);
    req.end();
  });
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

    // NFR-PRI-006: a rejected request must not be reported as a server fault,
    // because a 5xx is what gets logged.
    const tooLarge = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.co.za', password: 'x', filler: 'x'.repeat(150_000) }),
    });
    const tooLargeBody = await tooLarge.json().catch(() => null);
    check('a body above the limit returns 413, not 500', tooLarge.status === 413, tooLarge.status);
    check('the oversized request is answered with a usable message',
      typeof tooLargeBody?.message === 'string' && tooLargeBody.message.length > 0, tooLargeBody);

    const malformed = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not json',
    });
    check('a malformed body returns 400, not 500', malformed.status === 400, malformed.status);

    // -----------------------------------------------------------------
    section('Transport security (NFR-SEC-001)');
    // -----------------------------------------------------------------
    // The suite runs over plain HTTP, as CI does. What is asserted here is the
    // configuration that protects a hosted deployment: the headers a browser
    // acts on once it is reached over TLS, and the cookie attributes that no
    // longer depend on NODE_ENV.
    const health = await fetch(`${BASE}/health`, { redirect: 'manual' });
    const hsts = health.headers.get('strict-transport-security') ?? '';
    check('HSTS is sent', hsts.length > 0, hsts);
    check('HSTS lasts a year and covers subdomains',
      /max-age=31536000/.test(hsts) && /includeSubDomains/i.test(hsts), hsts);

    // The redirect must stay inactive unless it is asked for, or this suite and
    // every local client would be bounced to a port with nothing listening.
    check('plain HTTP is served directly while FORCE_HTTPS is unset',
      health.status === 200, health.status);

    // Read the Set-Cookie header directly, which the client above does not keep.
    // The health read opened this section, so it also carries the CSRF token a
    // write now has to present.
    const anonToken = health.headers.getSetCookie()
      .find((c) => c.startsWith('rasibe_csrf='))?.split(';')[0].split('=')[1] ?? '';

    const loginRaw = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': anonToken },
      body: JSON.stringify({ email: 'christinah@rasibe.co.za', password: 'Password123!' }),
    });
    const sessionCookie = loginRaw.headers.get('set-cookie') ?? '';
    check('the session cookie is Secure in every environment',
      /;\s*Secure/i.test(sessionCookie), sessionCookie);
    check('the session cookie is HttpOnly', /HttpOnly/i.test(sessionCookie), sessionCookie);
    check('the session cookie is SameSite=Lax', /SameSite=Lax/i.test(sessionCookie), sessionCookie);

    // -----------------------------------------------------------------
    section('Security response headers (NFR-SEC-012)');
    // -----------------------------------------------------------------
    // helmet has always sent these. Until now only HSTS was asserted, so a
    // change to the helmet options could have dropped the rest without a
    // single check going red.
    const h = (name: string) => health.headers.get(name) ?? '';

    check('a content security policy is sent',
      h('content-security-policy').length > 0, h('content-security-policy'));
    // Both framing controls, because they disagree in a way that matters: a
    // browser that understands frame-ancestors ignores X-Frame-Options, so
    // the CSP directive is the one that actually decides.
    check('framing is refused outright by X-Frame-Options',
      h('x-frame-options').toUpperCase() === 'DENY', h('x-frame-options'));
    check('framing is refused outright by the content security policy',
      /frame-ancestors\s+'none'/.test(h('content-security-policy')),
      h('content-security-policy'));
    check('content type sniffing is refused',
      h('x-content-type-options') === 'nosniff', h('x-content-type-options'));
    check('the referrer is never sent onward',
      h('referrer-policy') === 'no-referrer', h('referrer-policy'));
    check('the browsing context is isolated from cross-origin openers',
      h('cross-origin-opener-policy') === 'same-origin', h('cross-origin-opener-policy'));
    check('legacy cross-domain policy files are refused',
      h('x-permitted-cross-domain-policies') === 'none',
      h('x-permitted-cross-domain-policies'));

    // NFR-SEC-012 is about not describing the inside of the system. The
    // version of the framework is part of that description: it tells an
    // attacker which published advisories are worth trying.
    check('the server does not name the framework it runs on',
      h('x-powered-by') === '' && h('server') === '',
      { xPoweredBy: h('x-powered-by'), server: h('server') });

    // A handshake is not exercised here — the suite speaks plain HTTP — so
    // this asserts the policy rather than the negotiation. It still catches
    // the change that matters: a suite added later without forward secrecy.
    check('every offered TLS cipher provides forward secrecy',
      TLS_CIPHERS.length > 0 && TLS_CIPHERS.every((c) => c.startsWith('ECDHE-')),
      TLS_CIPHERS);

    // -----------------------------------------------------------------
    section('Cross-site request forgery (NFR-SEC-008)');
    // -----------------------------------------------------------------
    // A read hands out the token. Everything below is a write attempted the way
    // another site would have to attempt it: with our cookies, which a browser
    // attaches automatically, but without the header, which it cannot read.
    const readForToken = await fetch(`${BASE}/auth/me`);
    const issuedToken = readForToken.headers.getSetCookie()
      .find((c) => c.startsWith('rasibe_csrf='));
    check('a read issues a CSRF token', issuedToken !== undefined, issuedToken);
    check('the token cookie is readable by script, unlike the session',
      issuedToken !== undefined && !/HttpOnly/i.test(issuedToken), issuedToken);

    const sessionCookieValue = admin.cookies.get('rasibe_session') ?? '';
    const adminToken = admin.cookies.get('rasibe_csrf') ?? '';

    const forged = await fetch(`${BASE}/skills`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `rasibe_session=${sessionCookieValue}`,
      },
      body: JSON.stringify({ name: 'Forged skill' }),
    });
    const refusal = await forged.json().catch(() => null);
    // The administrator may create skills, so a 403 here can only be the token.
    // Checking the code as well stops this passing for an authorisation reason.
    check('a write without the token is refused',
      forged.status === 403 && refusal?.error === 'csrf_failed', { status: forged.status, refusal });
    check('the refusal carries a message the user can act on',
      typeof refusal?.message === 'string' && refusal.message.length > 0, refusal);

    // Cookie tossing: a hostile subdomain is same-site and can write a cookie on
    // the parent domain, so it could set both halves to a value of its choosing.
    // The server recomputes the expected token from the session and never reads
    // the cookie back, so matching halves prove nothing.
    const tossed = await fetch(`${BASE}/skills`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `rasibe_session=${sessionCookieValue}; rasibe_csrf=chosen-by-the-attacker`,
        'X-CSRF-Token': 'chosen-by-the-attacker',
      },
      body: JSON.stringify({ name: 'Tossed skill' }),
    });
    check('a token the attacker chose for both halves is refused',
      tossed.status === 403, tossed.status);
    check('the tossed cookie is rejected as a token failure, not something else',
      (await tossed.json().catch(() => null))?.error === 'csrf_failed');

    const foreignOrigin = await fetch(`${BASE}/skills`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://not-rasibe.example',
        Cookie: `rasibe_session=${sessionCookieValue}`,
        'X-CSRF-Token': adminToken,
      },
      body: JSON.stringify({ name: 'Foreign skill' }),
    });
    check('a write from a foreign origin is refused even with a valid token',
      foreignOrigin.status === 403, foreignOrigin.status);

    const reads = await fetch(`${BASE}/consultants`, {
      headers: { Cookie: `rasibe_session=${sessionCookieValue}` },
    });
    check('a read is not blocked by the absence of a token', reads.status === 200, reads.status);

    // -----------------------------------------------------------------
    section('Session rotation on a privilege change (NFR-SEC-010)');
    // -----------------------------------------------------------------
    const fixated = new Client('fixation');
    await fixated.get('/auth/me');
    await fixated.login('nosipho@rasibe.co.za');
    const beforeSecond = fixated.cookies.get('rasibe_session') ?? '';
    const tokenBefore = fixated.cookies.get('rasibe_csrf') ?? '';

    await fixated.login('nosipho@rasibe.co.za');
    const afterSecond = fixated.cookies.get('rasibe_session') ?? '';
    check('signing in issues a new session identifier',
      beforeSecond !== '' && afterSecond !== '' && beforeSecond !== afterSecond);
    check('the CSRF token changes with the session',
      tokenBefore !== (fixated.cookies.get('rasibe_csrf') ?? ''));

    // The identifier held before signing in must be dead, not merely replaced.
    const replayed = await fetch(`${BASE}/auth/me`, {
      headers: { Cookie: `rasibe_session=${beforeSecond}` },
    });
    check('the session held before signing in is revoked, not just replaced',
      replayed.status === 401, replayed.status);

    // -----------------------------------------------------------------
    section('Sign out');
    // -----------------------------------------------------------------
    await consultant.post('/auth/logout');
    const afterLogout = await consultant.get('/timesheets/my/current');
    check('the session is revoked on sign out', afterLogout.status === 401);

    // Signing out must leave a usable token behind. A browser stays on the page
    // rather than reloading, so nothing else would fetch one, and signing in is
    // itself a write. Clearing the cookie here passed every test above and
    // still broke the sign in that follows.
    const signOutClient = new Client('after sign out');
    await signOutClient.login('thabo.m@example.co.za');
    await signOutClient.post('/auth/logout');
    const tokenAfterLogout = signOutClient.cookies.get('rasibe_csrf');
    check('signing out leaves a token the next sign in can use',
      tokenAfterLogout !== undefined && tokenAfterLogout.length > 0, tokenAfterLogout);

    const signInAgain = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': tokenAfterLogout ?? '',
      },
      body: JSON.stringify({ email: 'thabo.m@example.co.za', password: 'Password123!' }),
    });
    check('signing in straight after signing out is accepted',
      signInAgain.status === 200, signInAgain.status);

    // -----------------------------------------------------------------
    section('Encryption at rest (NFR-SEC-005)');
    // -----------------------------------------------------------------
    // Last, because it creates consultants. Anything earlier that picks the
    // first row of a list would otherwise start seeing these instead.
    const me = (await admin.get('/auth/me')).body;
    const adminActor: Actor = { userId: me.user.userId, role: 'ADMINISTRATOR' };

    // Read the table directly. Going through the API would only prove the API
    // is consistent with itself; the claim is about what a stolen copy of the
    // database would contain.
    const stored = await withActor(adminActor, async (db) =>
      (await db.query(
        `SELECT id_number, bank_name, bank_account_ref, vetting_status, id_number_bidx
           FROM consultant WHERE consultant_id = $1`,
        [c.user.consultantId],
      )).rows[0],
    );

    check('the identity number is ciphertext in the database',
      typeof stored.id_number === 'string' && stored.id_number.startsWith('v1:'),
      stored.id_number);
    check('banking details are ciphertext in the database',
      typeof stored.bank_account_ref === 'string' && stored.bank_account_ref.startsWith('v1:'),
      stored.bank_account_ref);
    check('the vetting outcome is ciphertext in the database',
      typeof stored.vetting_status === 'string' && stored.vetting_status.startsWith('v1:'),
      stored.vetting_status);
    check('the identity number is not recoverable from the stored value',
      !String(stored.id_number).includes('9107045000000'));

    // The backfill is a migration, and a migration that half ran is worse than
    // one that did not. Nothing in clear may survive it.
    const leftovers = await withActor(adminActor, async (db) =>
      (await db.query(
        `SELECT count(*)::int AS n FROM consultant
          WHERE (id_number IS NOT NULL AND id_number NOT LIKE 'v1:%')
             OR (bank_name IS NOT NULL AND bank_name NOT LIKE 'v1:%')
             OR (bank_account_ref IS NOT NULL AND bank_account_ref NOT LIKE 'v1:%')
             OR (vetting_status IS NOT NULL AND vetting_status NOT LIKE 'v1:%')`,
      )).rows[0].n,
    );
    check('no restricted value is left in clear anywhere in the table',
      leftovers === 0, leftovers);

    const readBack = await admin.get(`/consultants/${c.user.consultantId}`);
    check('the administrator still reads the identity number as text',
      readBack.body.id_number === '9107045000000', readBack.body.id_number);
    check('the blind index is never sent to the client',
      readBack.body.id_number_bidx === undefined);

    // Uniqueness has to survive the move onto the fingerprint, or two records
    // for one person become possible and nothing would notice.
    const firstNew = await admin.post('/consultants', {
      fullName: 'Fixture One', email: 'fixture.one@example.co.za', idNumber: '9001015800085',
    });
    check('a consultant with an identity number can be created',
      firstNew.status === 201, firstNew.body);

    const duplicateId = await admin.post('/consultants', {
      fullName: 'Fixture Two', email: 'fixture.two@example.co.za', idNumber: '9001015800085',
    });
    check('a duplicate identity number is still refused',
      duplicateId.status === 409, duplicateId.status);
    check('the refusal names the identity number rather than leaking the column',
      typeof duplicateId.body.message === 'string'
      && duplicateId.body.message.includes('identity number'), duplicateId.body.message);

    // Normalisation matters: the same number typed with spaces is the same
    // person, and the fingerprint has to agree even though the text differs.
    const spaced = await admin.post('/consultants', {
      fullName: 'Fixture Three', email: 'fixture.three@example.co.za',
      idNumber: '900101 5800 085',
    });
    check('the same identity number spaced differently still collides',
      spaced.status === 409, spaced.status);

    const createdId = firstNew.body.consultant_id;
    const storedNew = await withActor(adminActor, async (db) =>
      (await db.query(`SELECT id_number, id_number_bidx FROM consultant WHERE consultant_id = $1`,
        [createdId])).rows[0],
    );
    check('a value written through the API is encrypted, not stored as typed',
      storedNew.id_number.startsWith('v1:') && !storedNew.id_number.includes('9001015800085'));
    check('the blind index is recorded alongside it',
      typeof storedNew.id_number_bidx === 'string' && storedNew.id_number_bidx.length === 64);

    // Editing has its own path through the route, and it has to keep the pair
    // in step. A stale fingerprint would let the old number be reused.
    const edited = await admin.patch(`/consultants/${createdId}`, { idNumber: '9202025800086' });
    check('an identity number can be changed', edited.status === 200, edited.body);
    check('the change is readable as text', edited.body.id_number === '9202025800086');

    const afterEdit = await withActor(adminActor, async (db) =>
      (await db.query(`SELECT id_number_bidx FROM consultant WHERE consultant_id = $1`,
        [createdId])).rows[0].id_number_bidx,
    );
    check('the blind index moved with the value',
      afterEdit !== storedNew.id_number_bidx);

    const reuseOld = await admin.post('/consultants', {
      fullName: 'Fixture Four', email: 'fixture.four@example.co.za', idNumber: '9001015800085',
    });
    check('the identity number that was edited away can be used again',
      reuseOld.status === 201, reuseOld.status);

    // -----------------------------------------------------------------
    section('Sign-in timing (NFR-SEC-004)');
    // -----------------------------------------------------------------
    // Wording alone does not hide whether an account exists. Before this was
    // fixed, a wrong password took 146 ms and an unknown address 12 ms on the
    // same machine, with no overlap: one request per address was enough.
    const SPARE = 'l.vanwyk@example.co.za';

    const clearLock = (email: string) =>
      anonQuery(
        `UPDATE app_user SET failed_logins = 0, locked_until = NULL WHERE lower(email) = lower($1)`,
        [email],
      );

    const timer = new Client('timing');
    await timer.get('/auth/me'); // take the CSRF token now, outside anything timed

    async function timeRefusal(email: string): Promise<number> {
      // Without this the sixth attempt onwards takes the locked branch and the
      // measurement quietly becomes an average of two different paths.
      await clearLock(email);
      const started = performance.now();
      await timer.post('/auth/login', { email, password: 'DefinitelyNotThePassword!' });
      return performance.now() - started;
    }

    async function medianRefusal(email: string, rounds = 11): Promise<number> {
      await timeRefusal(email); // discard a warm-up
      const samples: number[] = [];
      for (let i = 0; i < rounds; i++) samples.push(await timeRefusal(email));
      samples.sort((a, b) => a - b);
      return samples[Math.floor(samples.length / 2)];
    }

    const knownMs = await medianRefusal(SPARE);
    const unknownMs = await medianRefusal('nobody.at.all@example.co.za');

    // Compared as a proportion rather than in milliseconds, so the check means
    // the same thing on a slow shared runner as on a developer laptop: both
    // paths scale with the cost of the hash, so their ratio does not.
    const drift = Math.abs(knownMs - unknownMs) / Math.max(knownMs, unknownMs);
    check('an unknown address is refused in the same time as a wrong password',
      drift < 0.35, { knownMs: knownMs.toFixed(1), unknownMs: unknownMs.toFixed(1),
                      drift: drift.toFixed(3) });
    check('the refusal for an unknown address is not a fast path',
      unknownMs > 20, unknownMs.toFixed(1));

    const unknownRefusal = await timer.post('/auth/login', {
      email: 'nobody.at.all@example.co.za', password: 'DefinitelyNotThePassword!',
    });
    await clearLock(SPARE);
    const wrongRefusal = await timer.post('/auth/login', {
      email: SPARE, password: 'DefinitelyNotThePassword!',
    });
    check('both refusals carry the same status',
      unknownRefusal.status === 401 && wrongRefusal.status === 401,
      [unknownRefusal.status, wrongRefusal.status]);
    check('both refusals carry the same wording',
      unknownRefusal.body?.message === wrongRefusal.body?.message,
      [unknownRefusal.body?.message, wrongRefusal.body?.message]);
    check('both refusals carry the same error code',
      unknownRefusal.body?.error === wrongRefusal.body?.error,
      [unknownRefusal.body?.error, wrongRefusal.body?.error]);

    // A locked account skipped the password check too, so it answered faster
    // than an unlocked one. That told an attacker which addresses they had
    // already driven into lockout.
    await clearLock(SPARE);
    for (let i = 0; i < 5; i++) {
      await timer.post('/auth/login', { email: SPARE, password: 'DefinitelyNotThePassword!' });
    }
    const lockedStarted = performance.now();
    const locked = await timer.post('/auth/login', {
      email: SPARE, password: 'DefinitelyNotThePassword!',
    });
    const lockedMs = performance.now() - lockedStarted;
    check('five failures lock the account (FR-AUT-009)', locked.status === 423, locked.status);
    // Measured against the path that genuinely verifies a password, not
    // against the unknown-address path: if that one regressed to a fast path,
    // comparing to it would let this check pass while both were broken.
    check('a locked account is not refused faster than a password check',
      lockedMs > knownMs * 0.6, { lockedMs: lockedMs.toFixed(1), knownMs: knownMs.toFixed(1) });

    await clearLock(SPARE);
    const afterUnlock = await timer.post('/auth/login', { email: SPARE, password: 'Password123!' });
    check('the account signs in again once the lock is cleared',
      afterUnlock.status === 200, afterUnlock.status);

    // -----------------------------------------------------------------
    section('HTTPS redirect destination (NFR-SEC-001)');
    // -----------------------------------------------------------------
    // The suite drives plain HTTP with FORCE_HTTPS off, so the redirect is
    // unreachable from the main app. A second one is built with it on.
    const savedForce = process.env.FORCE_HTTPS;
    const savedHost = process.env.PUBLIC_HOST;
    const REAL_HOST = 'cpms.rasibe.co.za';
    const FORGED = 'attacker.example';
    let redirectServer: Server | null = null;
    try {
      process.env.FORCE_HTTPS = 'true';
      process.env.PUBLIC_HOST = REAL_HOST;
      const redirectPort = PORT + 1;
      const redirectApp = createApp();
      redirectServer = await new Promise<Server>((resolve) => {
        const s = redirectApp.listen(redirectPort, () => resolve(s));
      });

      const plain = await rawGet(redirectPort, '/api/health', REAL_HOST);
      check('an unencrypted request is redirected (308)', plain.status === 308, plain);
      check('the redirect points at the configured host',
        plain.location === `https://${REAL_HOST}/api/health`, plain.location);

      // The vulnerability itself. The redirect used to be built from the Host
      // header, which the caller supplies, so a request could choose where the
      // response sent the browser — and a 308 takes the method and body along.
      const forged = await rawGet(redirectPort, '/api/health', FORGED);
      check('a forged Host header does not change the destination (CWE-601)',
        forged.location === `https://${REAL_HOST}/api/health`, forged.location);
      check('the forged host appears nowhere in the redirect',
        !forged.location.includes(FORGED), forged.location);

      const withQuery = await rawGet(redirectPort, '/api/consultants?seniority=SENIOR', FORGED);
      check('the path and query survive the redirect',
        withQuery.location === `https://${REAL_HOST}/api/consultants?seniority=SENIOR`,
        withQuery.location);
    } finally {
      redirectServer?.close();
    }

    // Startup refuses rather than falling back to the request, because a
    // fallback would reintroduce exactly what the fix removes.
    process.env.FORCE_HTTPS = 'true';
    delete process.env.PUBLIC_HOST;
    let refusedMissing = false;
    try { createApp(); } catch { refusedMissing = true; }
    check('startup refuses when FORCE_HTTPS is set without a canonical host', refusedMissing);

    process.env.PUBLIC_HOST = 'https://attacker.example/';
    let refusedShape = false;
    try { createApp(); } catch { refusedShape = true; }
    check('a canonical host carrying a scheme or path is refused', refusedShape);

    process.env.PUBLIC_HOST = `${REAL_HOST}:8443`;
    let acceptedPort = true;
    try { createApp(); } catch { acceptedPort = false; }
    check('a canonical host with a port is accepted', acceptedPort);

    if (savedForce === undefined) delete process.env.FORCE_HTTPS;
    else process.env.FORCE_HTTPS = savedForce;
    if (savedHost === undefined) delete process.env.PUBLIC_HOST;
    else process.env.PUBLIC_HOST = savedHost;
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
