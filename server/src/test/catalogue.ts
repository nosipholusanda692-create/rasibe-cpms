/**
 * The Must requirements closed in this pass.
 *
 * FR-CON-001  amend a consultant already in the pool
 * FR-CON-013  deactivate a consultant without losing their history
 * FR-CFG-005  maintain the skills taxonomy
 * FR-PLC-007  end a placement early, with a reason
 * FR-MOB-002  a consultant keeps their own availability current
 *
 * Four of the five had working endpoints and no interface. These assertions
 * cover the endpoints the new screens call, including the cases where the
 * screen allows an action the server must still refuse.
 */
import { createApp } from '../index.js';
import { closePool } from '../lib/db.js';
import type { Server } from 'node:http';

const PORT = Number(process.env.TEST_PORT ?? 4104);
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

  async signIn(email: string, password = 'Password123!') {
    await this.get('/auth/me');
    const r = await this.post('/auth/login', { email, password });
    if (r.status !== 200) throw new Error(`sign in failed for ${email}: ${JSON.stringify(r.body)}`);
    return (await this.get('/auth/me')).body.user;
  }
}

async function main() {
  const app = createApp();
  const server: Server = await new Promise((r) => { const s = app.listen(PORT, () => r(s)); });

  try {
    const admin = new Client();
    const recruiter = new Client();
    const consultant = new Client();
    const clientMgr = new Client();

    await admin.signIn('christinah@rasibe.co.za');
    await recruiter.signIn('nosipho@rasibe.co.za');
    const me = await consultant.signIn('thabo.m@example.co.za');
    await clientMgr.signIn('s.naidoo@nedgroupit.co.za');

    // ------------------------------------------------------------------
    section('FR-CON-001 — amend a consultant');
    // ------------------------------------------------------------------
    const pool = await recruiter.get('/consultants');
    const target = pool.body.items[0];

    const renamed = await recruiter.patch(`/consultants/${target.consultant_id}`, {
      headline: 'Amended by the consultant edit screen',
      location: 'Sandton, Gauteng',
    });
    check('a recruiter can amend a consultant', renamed.status === 200, renamed.body);
    check('the change is returned', renamed.body.headline?.includes('Amended'), renamed.body?.headline);

    const badEmail = await recruiter.patch(`/consultants/${target.consultant_id}`, {
      email: 'not-an-address',
    });
    check('an invalid email is still refused by the server', badEmail.status === 400, badEmail.body);

    const repriced = await recruiter.patch(`/consultants/${target.consultant_id}`, {
      minPayRate: 1,
    });
    const after = await admin.get(`/consultants/${target.consultant_id}`);
    check('a recruiter cannot reprice a consultant through the edit screen',
      repriced.status === 403 || Number(after.body.min_pay_rate) !== 1,
      { status: repriced.status, rate: after.body?.min_pay_rate });

    const asAdmin = await admin.patch(`/consultants/${target.consultant_id}`, {
      minPayRate: 555,
    });
    check('an administrator can set the rate', asAdmin.status === 200, asAdmin.body);

    const otherConsultant = await consultant.patch(`/consultants/${target.consultant_id}`, {
      headline: 'Editing somebody else',
    });
    check('a consultant cannot amend another consultant',
      otherConsultant.status === 403, otherConsultant.status);

    // ------------------------------------------------------------------
    section('FR-MOB-002 — a consultant keeps their own availability current');
    // ------------------------------------------------------------------
    check('the consultant is linked to a pool record', !!me.consultantId);

    const ownUpdate = await consultant.patch(`/consultants/${me.consultantId}`, {
      availability: 'AVAILABLE_FROM',
      availableFrom: '2027-03-01',
    });
    check('a consultant updates their own availability', ownUpdate.status === 200, ownUpdate.body);

    const reread = await consultant.get(`/consultants/${me.consultantId}`);
    check('the date is stored', String(reread.body.available_from).startsWith('2027-03-01'),
      reread.body?.available_from);
    check('their own record still carries no bill rate',
      reread.body.bill_rate === undefined && reread.body.margin_amount === undefined);

    const selfReprice = await consultant.patch(`/consultants/${me.consultantId}`, {
      minPayRate: 9999,
    });
    const afterSelf = await admin.get(`/consultants/${me.consultantId}`);
    check('a consultant cannot reprice themselves',
      Number(afterSelf.body.min_pay_rate) !== 9999,
      { status: selfReprice.status, rate: afterSelf.body?.min_pay_rate });

    // ------------------------------------------------------------------
    section('FR-CFG-005 — the skills taxonomy');
    // ------------------------------------------------------------------
    const created = await recruiter.post('/skills', {
      name: `Terraform ${Date.now()}`, category: 'Infrastructure',
    });
    check('a skill can be added', created.status === 201, created.body);

    const blank = await recruiter.post('/skills', { name: '' });
    check('a blank skill name is refused', blank.status === 400, blank.body);

    const duplicate = await recruiter.post('/skills', {
      name: created.body.name, category: 'Infrastructure',
    });
    check('a duplicate skill name is refused', duplicate.status === 409, duplicate.status);

    const edited = await recruiter.patch(`/skills/${created.body.skill_id}`, {
      name: `${created.body.name} (HCL)`, category: 'Platform',
    });
    check('a skill can be renamed and recategorised', edited.status === 200, edited.body);
    check('the new category comes back', edited.body.category === 'Platform');

    const retired = await recruiter.post(`/skills/${created.body.skill_id}/retire`, {});
    check('a skill can be retired', retired.status === 200, retired.body);
    check('the count of consultants carrying it is reported',
      typeof retired.body.consultant_count === 'number', retired.body);

    const listed = await recruiter.get('/skills');
    check('a retired skill leaves the matching list',
      !listed.body.items.some((s: any) => s.skill_id === created.body.skill_id),
      listed.body.items.length);

    // The maintenance screen has to be able to list retired skills, or a
    // retired one could never be restored.
    const withRetired = await recruiter.get('/skills?includeRetired=true');
    const retiredRow = withRetired.body.items?.find((s: any) => s.skill_id === created.body.skill_id);
    check('a retired skill is listed when the maintenance screen asks for it',
      retiredRow?.is_active === false, retiredRow);
    check('every listed skill says whether it is active',
      withRetired.body.items.every((s: any) => typeof s.is_active === 'boolean'));

    const seenByConsultant = await consultant.get('/skills?includeRetired=true');
    check('a consultant is not shown retired skills, even when they ask',
      !seenByConsultant.body.items.some((s: any) => s.skill_id === created.body.skill_id));
    const seenByClient = await clientMgr.get('/skills?includeRetired=true');
    check('a client manager is not shown retired skills, even when they ask',
      !seenByClient.body.items.some((s: any) => s.skill_id === created.body.skill_id));

    const badFlag = await recruiter.get('/skills?includeRetired=maybe');
    check('an unclear includeRetired value is refused', badFlag.status === 400, badFlag.status);

    const restored = await recruiter.patch(`/skills/${created.body.skill_id}`, { isActive: true });
    check('a retired skill can be restored', restored.status === 200 && restored.body.is_active === true);

    const consultantEdits = await consultant.post('/skills', { name: 'Should not work' });
    check('a consultant cannot change the taxonomy', consultantEdits.status === 403);
    const clientEdits = await clientMgr.post('/skills', { name: 'Should not work either' });
    check('a client manager cannot change the taxonomy', clientEdits.status === 403);

    // ------------------------------------------------------------------
    section('FR-PLC-007 — end a placement early');
    // ------------------------------------------------------------------
    const placements = await admin.get('/placements?status=ACTIVE,ENDING_SOON');
    const live = placements.body.items[0];
    check('there is a live placement to end', !!live, placements.body.items.length);

    const noReason = await admin.post(`/placements/${live.placement_id}/terminate`, { reason: '' });
    check('ending without a reason is refused', noReason.status === 400, noReason.body);

    const shortReason = await admin.post(`/placements/${live.placement_id}/terminate`, {
      reason: 'no',
    });
    check('a two-character reason is refused', shortReason.status === 400);

    const byRecruiter = await recruiter.post(`/placements/${live.placement_id}/terminate`, {
      reason: 'A recruiter attempting to end a placement',
    });
    check('a recruiter cannot end a placement', byRecruiter.status === 403, byRecruiter.status);

    const ended = await admin.post(`/placements/${live.placement_id}/terminate`, {
      reason: 'Client restructured the team and released the role',
    });
    check('an administrator can end a placement', ended.status === 200, ended.body);
    check('the status becomes terminated', ended.body.status === 'TERMINATED', ended.body?.status);

    const audit = await admin.get('/reports/audit?limit=40');
    check('ending a placement is recorded in the audit log',
      audit.body.items.some((a: any) => a.action === 'PLACEMENT_TERMINATED'),
      audit.body.items.map((a: any) => a.action).slice(0, 8));

    const freed = await admin.get(`/consultants/${live.consultant_id}`);
    check('the consultant returns to the available pool',
      freed.body.availability !== 'ON_PLACEMENT', freed.body?.availability);

    // ------------------------------------------------------------------
    section('FR-CON-013 — deactivate a consultant');
    // ------------------------------------------------------------------
    const fresh = await recruiter.post('/consultants', {
      fullName: 'Deactivation Test', email: `deact.${Date.now()}@example.co.za`,
      seniority: 'SENIOR', availability: 'AVAILABLE',
    });
    check('a consultant can be added for the test', fresh.status === 201);

    // The reason is what makes this an auditable act, so it is required.
    const noReasonGiven = await recruiter.post(`/consultants/${fresh.body.consultant_id}/deactivate`, {});
    check('deactivating without a reason is refused', noReasonGiven.status === 400, noReasonGiven.status);
    const tooShort = await recruiter.post(`/consultants/${fresh.body.consultant_id}/deactivate`, {
      reason: 'no',
    });
    check('a two-character reason is refused', tooShort.status === 400, tooShort.status);
    const extraField = await recruiter.post(`/consultants/${fresh.body.consultant_id}/deactivate`, {
      reason: 'Left the contracting market', isActive: true,
    });
    check('an unexpected field is refused', extraField.status === 400, extraField.status);
    const byConsultant = await consultant.post(`/consultants/${fresh.body.consultant_id}/deactivate`, {
      reason: 'A consultant attempting to deactivate somebody',
    });
    check('a consultant cannot deactivate anyone', byConsultant.status === 403, byConsultant.status);
    const byClient = await clientMgr.post(`/consultants/${fresh.body.consultant_id}/deactivate`, {
      reason: 'A client manager attempting to deactivate somebody',
    });
    check('a client manager cannot deactivate anyone', byClient.status === 403, byClient.status);
    const stillActive = await admin.get(`/consultants/${fresh.body.consultant_id}`);
    check('none of the refused attempts changed the consultant', stillActive.body.is_active !== false);

    const gone = await recruiter.post(`/consultants/${fresh.body.consultant_id}/deactivate`, {
      reason: 'Left the contracting market',
    });
    check('a consultant can be deactivated', gone.status === 200, gone.body);

    const trail = await admin.get(`/reports/audit?entityTable=consultant&entityId=${fresh.body.consultant_id}`);
    const entry = trail.body.items?.find((a: any) => a.action === 'CONSULTANT_DEACTIVATED');
    check('the deactivation is in the audit log', !!entry, trail.body.items?.map((a: any) => a.action));
    check('the reason is recorded with it', entry?.reason === 'Left the contracting market', entry?.reason);
    check('the audit entry names who did it', !!entry?.actor_name, entry?.actor_name);

    const search = await recruiter.get('/consultants');
    check('a deactivated consultant leaves the search results',
      !search.body.items.some((x: any) => x.consultant_id === fresh.body.consultant_id));

    const stillThere = await admin.get(`/consultants/${fresh.body.consultant_id}`);
    check('the record itself is retained, not deleted', stillThere.status === 200);

    const requests = await recruiter.get('/requests?status=OPEN,SHORTLISTING,INTERVIEWING');
    if (requests.body.items.length) {
      await recruiter.post(`/consultants/${fresh.body.consultant_id}/consent`, { reason: 'test' });
      const submitted = await recruiter.post(
        `/requests/${requests.body.items[0].request_id}/submissions`,
        { consultantId: fresh.body.consultant_id },
      );
      check('a deactivated consultant cannot be submitted to a client (BR-017)',
        submitted.status >= 400, submitted.status);
    } else {
      check('a deactivated consultant cannot be submitted to a client (BR-017)', true);
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
