/**
 * FR-PLC-006 — extend a placement, keeping the original end date.
 *
 * The suite builds its own consultant and two placements so it does not depend
 * on what the earlier suites left behind. The consultant has one live placement
 * (A) and a second booked straight after it (B), which is what makes the
 * overlap case real: extending A far enough runs into B.
 *
 * Dates are worked out from today so the suite does not go stale.
 */
import { createApp } from '../index.js';
import { closePool, withActor } from '../lib/db.js';
import type { Server } from 'node:http';

const PORT = Number(process.env.TEST_PORT ?? 4105);
const BASE = `http://127.0.0.1:${PORT}/api`;

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  \u2713 ${name}`); }
  else {
    fail++; failures.push(name);
    console.log(`  \u2717 ${name}`);
    if (detail !== undefined) console.log(`      ${JSON.stringify(detail).slice(0, 240)}`);
  }
}
const section = (t: string) => console.log(`\n${t}`);

/** Dates as YYYY-MM-DD, offset from a base date, in UTC so there is no drift. */
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (from: string, n: number) => {
  const d = new Date(`${from.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};
const addYears = (from: string, n: number) => {
  const d = new Date(`${from.slice(0, 10)}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + n);
  return iso(d);
};
const day = (v: unknown) => String(v ?? '').slice(0, 10);

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

    const adminUser = await admin.signIn('christinah@rasibe.co.za');
    await recruiter.signIn('nosipho@rasibe.co.za');
    await consultant.signIn('thabo.m@example.co.za');
    await clientMgr.signIn('s.naidoo@nedgroupit.co.za');

    // ------------------------------------------------------------------
    section('Set-up — one consultant, a live placement and a booking right after it');
    // ------------------------------------------------------------------
    const today = iso(new Date());
    const startA = addDays(today, -10);
    const endA = addDays(today, 20);
    const startB = addDays(today, 41);
    const endB = addDays(today, 120);

    const person = await recruiter.post('/consultants', {
      fullName: 'Extension Test', email: `extend.${Date.now()}@example.co.za`,
      seniority: 'SENIOR', availability: 'AVAILABLE',
    });
    check('a consultant is created for the test', person.status === 201, person.body);
    const consultantId = person.body.consultant_id;

    const clientId = (await recruiter.get('/clients')).body.items[0].client_id;

    const created = await recruiter.post('/placements', {
      consultantId, clientId, jobTitle: 'Extension test A',
      startDate: startA, endDate: endA, billRate: 900, payRate: 600,
    });
    check('placement A is created', created.status === 201, created.body);
    const idA = created.body.placement_id;

    const approvedA = await admin.post(`/placements/${idA}/approve-rates`, {});
    check('placement A goes live once its rates are approved',
      approvedA.status === 200 && approvedA.body.status === 'ACTIVE', approvedA.body);

    const bookedB = await recruiter.post('/placements', {
      consultantId, clientId, jobTitle: 'Extension test B',
      startDate: startB, endDate: endB, billRate: 900, payRate: 600,
    });
    check('placement B is booked after A', bookedB.status === 201, bookedB.body);
    const idB = bookedB.body.placement_id;

    const readA = async () =>
      (await admin.get(`/placements?consultantId=${consultantId}&pageSize=50`))
        .body.items.find((p: any) => p.placement_id === idA);

    // ------------------------------------------------------------------
    section('Who may extend, and what the form may send');
    // ------------------------------------------------------------------
    const goodBody = { newEndDate: addDays(endA, 10), reason: 'Client asked for another ten days' };

    check('a recruiter cannot extend a placement',
      (await recruiter.post(`/placements/${idA}/extend`, goodBody)).status === 403);
    check('a consultant cannot extend a placement',
      (await consultant.post(`/placements/${idA}/extend`, goodBody)).status === 403);
    check('a client manager cannot extend a placement',
      (await clientMgr.post(`/placements/${idA}/extend`, goodBody)).status === 403);

    const noReason = await admin.post(`/placements/${idA}/extend`, { newEndDate: goodBody.newEndDate });
    check('extending without a reason is refused', noReason.status === 400, noReason.body);
    check('a four-character reason is refused',
      (await admin.post(`/placements/${idA}/extend`, { ...goodBody, reason: 'nope' })).status === 400);
    check('a missing date is refused',
      (await admin.post(`/placements/${idA}/extend`, { reason: goodBody.reason })).status === 400);
    check('a date that does not exist is refused',
      (await admin.post(`/placements/${idA}/extend`, { ...goodBody, newEndDate: '2027-02-30' })).status === 400);
    check('a date in the wrong format is refused',
      (await admin.post(`/placements/${idA}/extend`, { ...goodBody, newEndDate: '31/12/2027' })).status === 400);
    check('an unexpected field is refused',
      (await admin.post(`/placements/${idA}/extend`, { ...goodBody, status: 'ACTIVE' })).status === 400);
    check('an id that is not a UUID is refused',
      (await admin.post('/placements/not-an-id/extend', goodBody)).status === 400);
    check('a placement that does not exist is a 404',
      (await admin.post('/placements/00000000-0000-4000-8000-000000000000/extend', goodBody)).status === 404);

    // ------------------------------------------------------------------
    section('The new date has to make sense');
    // ------------------------------------------------------------------
    const same = await admin.post(`/placements/${idA}/extend`, { ...goodBody, newEndDate: endA });
    check('the same end date is refused', same.status === 400, same.body);
    check('the refusal says which field is wrong',
      Array.isArray(same.body?.details?.newEndDate ?? same.body?.detail?.newEndDate) || JSON.stringify(same.body).includes('newEndDate'),
      same.body);
    check('an earlier end date is refused',
      (await admin.post(`/placements/${idA}/extend`, { ...goodBody, newEndDate: addDays(endA, -3) })).status === 400);
    check('a date years beyond the current one is refused as a probable typo',
      (await admin.post(`/placements/${idA}/extend`, { ...goodBody, newEndDate: addYears(endA, 10) })).status === 400);

    const untouched = await readA();
    check('none of the refused attempts changed the placement',
      day(untouched.end_date) === endA && untouched.extension_count === 0
      && untouched.original_end_date === null,
      { end: untouched.end_date, count: untouched.extension_count, original: untouched.original_end_date });

    // ------------------------------------------------------------------
    section('BR-001 — an extension cannot run into the consultant\'s next booking');
    // ------------------------------------------------------------------
    const collide = await admin.post(`/placements/${idA}/extend`, {
      newEndDate: addDays(startB, 15), reason: 'Client wants three more weeks',
    });
    check('extending into the next booking is refused', collide.status === 409, collide.body);
    check('the refusal names the rule', String(collide.body?.message).includes('BR-001'), collide.body?.message);

    const edge = await admin.post(`/placements/${idA}/extend`, {
      newEndDate: startB, reason: 'Client wants it to end on the day B starts',
    });
    check('ending on the day the next booking starts is refused as well', edge.status === 409, edge.status);

    const afterCollision = await readA();
    check('a refused extension leaves the end date alone',
      day(afterCollision.end_date) === endA && afterCollision.extension_count === 0);

    // ------------------------------------------------------------------
    section('FR-PLC-006 — extend, and keep the original');
    // ------------------------------------------------------------------
    const first = await admin.post(`/placements/${idA}/extend`, {
      newEndDate: addDays(endA, 10), reason: 'Client asked for another ten days',
    });
    check('an administrator can extend a live placement', first.status === 200, first.body);
    check('the end date moves', day(first.body.end_date) === addDays(endA, 10), first.body?.end_date);
    check('the original end date is kept', day(first.body.original_end_date) === endA, first.body?.original_end_date);
    check('the extension is counted', first.body.extension_count === 1, first.body?.extension_count);
    check('the placement stays live', first.body.status === 'ACTIVE', first.body?.status);
    check('it is still the same placement', first.body.placement_id === idA);

    const second = await admin.post(`/placements/${idA}/extend`, {
      newEndDate: addDays(startB, -1), reason: 'Second extension, up to the day before B',
    });
    check('it can be extended again', second.status === 200, second.body);
    check('the original end date is still the first one, not the last',
      day(second.body.original_end_date) === endA, second.body?.original_end_date);
    check('the count goes to two', second.body.extension_count === 2, second.body?.extension_count);
    check('the end date is the latest one', day(second.body.end_date) === addDays(startB, -1));

    const listed = await readA();
    check('the placement list shows the original end date and the count',
      day(listed.original_end_date) === endA && listed.extension_count === 2,
      { original: listed.original_end_date, count: listed.extension_count });
    check('the placement list shows the new end date and days remaining',
      day(listed.end_date) === addDays(startB, -1) && typeof listed.days_remaining === 'number');

    const stillPlaced = await admin.get(`/consultants/${consultantId}`);
    check('the consultant stays on placement', stillPlaced.body.availability === 'ON_PLACEMENT',
      stillPlaced.body?.availability);

    // ------------------------------------------------------------------
    section('NFR-SEC-011 — each extension is in the audit log');
    // ------------------------------------------------------------------
    const log = await admin.get(`/reports/audit?entityTable=placement&entityId=${idA}&limit=50`);
    const entries = (log.body.items ?? []).filter((a: any) => a.action === 'PLACEMENT_EXTENDED');
    check('both extensions are recorded', entries.length === 2, entries.length);
    const newest = entries[0];
    check('the entry carries the reason',
      newest?.reason === 'Second extension, up to the day before B', newest?.reason);
    check('the entry carries who did it', !!newest?.actor_name, newest?.actor_name);
    check('the entry carries the date before and after',
      day(newest?.previous_value?.end_date) === addDays(endA, 10)
      && day(newest?.new_value?.end_date) === addDays(startB, -1),
      { previous: newest?.previous_value, next: newest?.new_value });

    // ------------------------------------------------------------------
    section('Only a live placement can be extended');
    // ------------------------------------------------------------------
    const bookedOnly = await admin.post(`/placements/${idB}/extend`, {
      newEndDate: addDays(endB, 5), reason: 'Booked but not yet approved',
    });
    check('a placement that is not live yet cannot be extended', bookedOnly.status === 409, bookedOnly.body);
    check('the message says why', /live placement/i.test(String(bookedOnly.body?.message)), bookedOnly.body?.message);

    const ended = await admin.post(`/placements/${idA}/terminate`, { reason: 'Ended so the next check can run' });
    check('placement A is ended for the next check', ended.status === 200, ended.body);
    const afterEnd = await admin.post(`/placements/${idA}/extend`, {
      newEndDate: addDays(endA, 400), reason: 'Trying to extend a terminated placement',
    });
    check('a terminated placement cannot be extended', afterEnd.status === 409, afterEnd.body);
    const stillEnded = await readA();
    check('and it stays terminated', stillEnded.status === 'TERMINATED', stillEnded.status);

    // ------------------------------------------------------------------
    section('A placement marked "ending soon" returns to active when pushed out');
    // ------------------------------------------------------------------
    // Nothing in the API marks a placement "ending soon" yet: that is the job of
    // the scheduler that is still to be built. This sets the status the way it
    // will, as the administrator through the database, so the extension rule
    // is tested without depending on what the seed data happens to contain.
    const secondPerson = await recruiter.post('/consultants', {
      fullName: 'Ending Soon Test', email: `soon.${Date.now()}@example.co.za`,
      seniority: 'INTERMEDIATE', availability: 'AVAILABLE',
    });
    check('a second consultant is created', secondPerson.status === 201, secondPerson.body);
    const soonCreated = await recruiter.post('/placements', {
      consultantId: secondPerson.body.consultant_id, clientId, jobTitle: 'Ending soon test',
      startDate: addDays(today, -60), endDate: addDays(today, 10), billRate: 800, payRate: 500,
    });
    check('a placement is created for it', soonCreated.status === 201, soonCreated.body);
    const idC = soonCreated.body.placement_id;
    const liveC = await admin.post(`/placements/${idC}/approve-rates`, {});
    check('a second placement is live', liveC.status === 200 && liveC.body.status === 'ACTIVE', liveC.body);

    const adminActor = { userId: adminUser.userId as string, role: 'ADMINISTRATOR' as const };
    await withActor(adminActor, (c) =>
      c.query(`UPDATE placement SET status = 'ENDING_SOON' WHERE placement_id = $1`, [idC]));

    // The longest alert threshold, read as the extension itself reads it.
    const longest = await withActor(adminActor, async (c) => Number((await c.query(
      `SELECT max(d::int) AS n FROM system_setting s,
              unnest(string_to_array(s.setting_value, ',')) AS d
        WHERE s.setting_key = 'placement_alert_days'`)).rows[0].n ?? 0));
    check('the alert thresholds are readable (default 60,30,14)', longest > 0, longest);

    const inside = await admin.post(`/placements/${idC}/extend`, {
      newEndDate: addDays(today, Math.max(1, longest - 20)), reason: 'A few more weeks to hand over',
    });
    check('an ending-soon placement can be extended', inside.status === 200, inside.body);
    check('a new date still inside the alert window leaves it marked ending soon',
      inside.body.status === 'ENDING_SOON', inside.body?.status);

    const beyond = await admin.post(`/placements/${idC}/extend`, {
      newEndDate: addDays(today, longest + 120), reason: 'Renewed for another four months',
    });
    check('extended again', beyond.status === 200, beyond.body);
    check('pushed beyond every alert threshold it goes back to active',
      beyond.body.status === 'ACTIVE', beyond.body?.status);
    check('its original end date is still the first one',
      day(beyond.body.original_end_date) === addDays(today, 10), beyond.body?.original_end_date);
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

main().catch((e) => { console.error(e); process.exit(1); });
