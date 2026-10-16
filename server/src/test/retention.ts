/**
 * NFR-PRI-004 / BR-021  retention of unplaced candidates
 * NFR-PRI-005           anonymisation on request
 *
 * The suite builds its own consultants, each one a different side of the rule,
 * and backdates them with the database as the administrator so a year has
 * "passed". It checks the outcome in the database itself, not just in what the
 * API says: that personal data is really gone, that the invoice is kept with its
 * amounts untouched and the name taken out of its words, and that the login
 * account no longer works.
 *
 * It changes the retention setting and puts it back, even if a check fails.
 */
import { createApp } from '../index.js';
import { closePool, withActor } from '../lib/db.js';
import type { Server } from 'node:http';

const PORT = Number(process.env.TEST_PORT ?? 4106);
const BASE = `http://127.0.0.1:${PORT}/api`;

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  \u2713 ${name}`); }
  else {
    fail++; failures.push(name);
    console.log(`  \u2717 ${name}`);
    if (detail !== undefined) console.log(`      ${JSON.stringify(detail).slice(0, 260)}`);
  }
}
const section = (t: string) => console.log(`\n${t}`);

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
const mondayOf = (from: string) => {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
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
  put = (p: string, b?: unknown) => this.call('PUT', p, b);

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

  const admin = new Client();
  const recruiter = new Client();
  const consultant = new Client();
  const clientMgr = new Client();
  let adminActor!: { userId: string; role: 'ADMINISTRATOR' };
  let originalMonths = '12';
  const sql = <T = any>(q: string, p: unknown[] = []) =>
    withActor(adminActor, async (c) => (await c.query(q, p)).rows as T[]);

  try {
    const adminUser = await admin.signIn('christinah@rasibe.co.za');
    adminActor = { userId: adminUser.userId, role: 'ADMINISTRATOR' };
    await recruiter.signIn('nosipho@rasibe.co.za');
    await consultant.signIn('thabo.m@example.co.za');
    await clientMgr.signIn('s.naidoo@nedgroupit.co.za');

    originalMonths = (await sql(`SELECT setting_value FROM system_setting WHERE setting_key = 'candidate_retention_months'`))[0].setting_value;

    // ------------------------------------------------------------------
    section('Set-up — five consultants, each a different side of the rule');
    // ------------------------------------------------------------------
    const stamp = Date.now();
    const today = iso(new Date());
    const clientId = (await recruiter.get('/clients')).body.items[0].client_id;

    const make = async (label: string) => {
      const r = await recruiter.post('/consultants', {
        fullName: `Retention ${label} ${stamp}`, email: `ret.${label}.${stamp}@example.co.za`,
        mobile: '+27 82 555 0100', location: 'Fakeville', headline: `Headline for ${label}`,
        seniority: 'SENIOR', availability: 'AVAILABLE',
      });
      check(`${label}: created`, r.status === 201, r.body);
      return { id: r.body.consultant_id as string, name: `Retention ${label} ${stamp}`, email: `ret.${label}.${stamp}@example.co.za` };
    };
    const due = await make('due');
    const kept = await make('consented');
    const recent = await make('recent');
    const placed = await make('placed');
    const inFlight = await make('inflight');

    // A year and a month ago, except the recent one.
    await sql(`UPDATE consultant SET created_at = now() - interval '13 months'
                WHERE consultant_id = ANY($1::uuid[])`, [[due.id, kept.id, placed.id, inFlight.id]]);

    // Personal data on the two that will be anonymised, set the way the API would hold it.
    await sql(`UPDATE consultant SET id_number = 'synthetic-ciphertext', id_number_bidx = md5(consultant_id::text) || md5(consultant_id::text || 'x'),
                      date_of_birth = '1990-01-01', nationality = 'Fakeland', right_to_work = 'Citizen',
                      vetting_status = 'Cleared', bank_name = 'Fake Bank', bank_account_ref = 'synthetic-ref',
                      min_pay_rate = 500, preferred_pay_rate = 650, source = 'Referral'
                WHERE consultant_id = ANY($1::uuid[])`, [[due.id, placed.id]]);

    // The "due" one also has a certification, a document, a queued email and a sign-in account.
    await sql(`INSERT INTO certification (consultant_id, name) VALUES ($1, 'Fake Certification')`, [due.id]);
    await sql(`INSERT INTO document (consultant_id, doc_type, file_name, storage_key)
               VALUES ($1, 'CV', 'cv.pdf', 'test/' || gen_random_uuid()::text)`, [due.id]);
    const acct = (await sql(
      `INSERT INTO app_user (email, full_name, password_hash)
       VALUES ($1, $2, 'not-a-real-hash') RETURNING user_id`, [`login.${stamp}@example.co.za`, due.name]))[0];
    await sql(`UPDATE consultant SET user_id = $2 WHERE consultant_id = $1`, [due.id, acct.user_id]);
    await sql(`INSERT INTO user_session (user_id, expires_at) VALUES ($1, now() + interval '1 hour')`, [acct.user_id]);
    await sql(`INSERT INTO notification (event, recipient_email, subject, body)
               VALUES ('ACCOUNT_CREATED', $1, 'Welcome', 'A welcome message')`, [due.email]);

    // "kept" has agreed to be held longer; "placed" has worked; "inflight" is with a client.
    // placed: a live placement, an approved timesheet, an invoice carrying the name.
    const startP = addDays(today, -10);
    const pl = await recruiter.post('/placements', {
      consultantId: placed.id, clientId, jobTitle: 'Retention placement',
      startDate: startP, endDate: addDays(today, 20), billRate: 900, payRate: 600,
    });
    check('placed: placement created', pl.status === 201, pl.body);
    const approvedPl = await admin.post(`/placements/${pl.body.placement_id}/approve-rates`, {});
    check('placed: placement is live', approvedPl.body?.status === 'ACTIVE', approvedPl.body);

    const monday = mondayOf(today);
    const invoice = await withActor(adminActor, async (c) => {
      const ts = (await c.query(
        `INSERT INTO timesheet (placement_id, week_start, week_end, total_standard_hours)
         VALUES ($1, $2::date, $2::date + 6, 40) RETURNING timesheet_id`, [pl.body.placement_id, monday])).rows[0];
      await c.query(`UPDATE timesheet SET status = 'SUBMITTED' WHERE timesheet_id = $1`, [ts.timesheet_id]);
      await c.query(`UPDATE timesheet SET status = 'APPROVED', approved_at = now() WHERE timesheet_id = $1`, [ts.timesheet_id]);
      const inv = (await c.query(
        `INSERT INTO invoice (client_id, period_start, period_end, subtotal, total)
         VALUES ($1, $2::date, $2::date + 6, 36000, 36000) RETURNING invoice_id`, [clientId, monday])).rows[0];
      await c.query(
        `INSERT INTO invoice_line (invoice_id, timesheet_id, description, quantity, unit_rate, line_total)
         VALUES ($1, $2, $3, 40, 900, 36000)`,
        [inv.invoice_id, ts.timesheet_id, `${placed.name} — Retention placement — week of ${monday}`]);
      return { id: inv.invoice_id as string };
    });
    check('placed: an invoice line carries the consultant\'s name', !!invoice.id);

    // inflight: submitted to a client who has not decided.
    const openRequests = (await recruiter.get('/requests?status=OPEN,SHORTLISTING,INTERVIEWING')).body.items;
    let inFlightSet = false;
    if (openRequests.length) {
      await recruiter.post(`/consultants/${inFlight.id}/consent`, { reason: 'Test consent to share' });
      const sub = await recruiter.post(`/requests/${openRequests[0].request_id}/submissions`, { consultantId: inFlight.id });
      inFlightSet = sub.status === 201;
      check('inflight: submitted to a client', inFlightSet, sub.body);
    } else {
      console.log('  - skipped: no open request to submit to; the in-flight case is not covered here');
    }

    // ------------------------------------------------------------------
    section('Who may see and run retention');
    // ------------------------------------------------------------------
    for (const [who, c] of [['a recruiter', recruiter], ['a consultant', consultant], ['a client manager', clientMgr]] as const) {
      check(`${who} cannot see who is due`, (await c.get('/retention')).status === 403);
      check(`${who} cannot run retention`, (await c.post('/retention/run', {})).status === 403);
      check(`${who} cannot anonymise a consultant`,
        (await c.post(`/retention/consultants/${recent.id}/anonymise`, { reason: 'Attempted by the wrong role' })).status === 403);
    }

    // ------------------------------------------------------------------
    section('BR-021 — who is due');
    // ------------------------------------------------------------------
    const preview = await admin.get('/retention');
    check('the preview works', preview.status === 200, preview.body);
    check('it reports the configured period', preview.body.months === Number(originalMonths), preview.body?.months);
    const dueIds = (preview.body.items ?? []).map((i: any) => i.consultant_id);
    check('an unplaced candidate past the period is due', dueIds.includes(due.id), dueIds.length);
    check('a recent candidate is not due', !dueIds.includes(recent.id));
    check('somebody who has been placed is not due', !dueIds.includes(placed.id));
    if (inFlightSet) check('somebody a client is still considering is not due', !dueIds.includes(inFlight.id));

    // ------------------------------------------------------------------
    section('BR-021 — consent to be kept longer');
    // ------------------------------------------------------------------
    const consentBody = { retainUntil: addDays(today, 200), reason: 'Consultant agreed by email to be kept for six more months' };
    check('a consultant cannot record consent for themselves here',
      (await consultant.post(`/retention/consultants/${kept.id}/consent`, consentBody)).status === 403);
    check('a client manager cannot record consent',
      (await clientMgr.post(`/retention/consultants/${kept.id}/consent`, consentBody)).status === 403);
    check('no reason is refused',
      (await recruiter.post(`/retention/consultants/${kept.id}/consent`, { retainUntil: consentBody.retainUntil })).status === 400);
    check('a four-character reason is refused',
      (await recruiter.post(`/retention/consultants/${kept.id}/consent`, { ...consentBody, reason: 'okay' })).status === 400);
    const past = await recruiter.post(`/retention/consultants/${kept.id}/consent`, { ...consentBody, retainUntil: addDays(today, -1) });
    check('a date in the past is refused', past.status === 400, past.body);
    check('the refusal names the field', JSON.stringify(past.body).includes('retainUntil'), past.body);
    check('a date more than ten years ahead is refused',
      (await recruiter.post(`/retention/consultants/${kept.id}/consent`, { ...consentBody, retainUntil: addYears(today, 11) })).status === 400);
    check('a date that does not exist is refused',
      (await recruiter.post(`/retention/consultants/${kept.id}/consent`, { ...consentBody, retainUntil: '2027-02-30' })).status === 400);
    check('an unexpected field is refused',
      (await recruiter.post(`/retention/consultants/${kept.id}/consent`, { ...consentBody, isActive: true })).status === 400);
    check('an unknown consultant is a 404',
      (await recruiter.post('/retention/consultants/00000000-0000-4000-8000-000000000000/consent', consentBody)).status === 404);

    const dueBefore = (await admin.get('/retention')).body.items.map((i: any) => i.consultant_id);
    check('before consent, the candidate is due', dueBefore.includes(kept.id), dueBefore.length);

    const consented = await recruiter.post(`/retention/consultants/${kept.id}/consent`, consentBody);
    check('a recruiter can record consent to be kept longer', consented.status === 200, consented.body);
    const afterConsent = (await admin.get('/retention')).body.items.map((i: any) => i.consultant_id);
    check('after consent, the candidate is no longer due', !afterConsent.includes(kept.id));

    const withdrawn = await recruiter.post(`/retention/consultants/${recent.id}/consent`, {
      retainUntil: null, reason: 'Nothing recorded yet; checking that withdrawing is accepted',
    });
    check('consent can be withdrawn by sending no date', withdrawn.status === 200, withdrawn.body);

    const consentLog = await admin.get(`/reports/audit?entityTable=consultant&entityId=${kept.id}&limit=20`);
    const consentEntry = (consentLog.body.items ?? []).find((a: any) => a.action === 'RETENTION_CONSENT_RECORDED');
    check('the consent is in the audit log with who and how',
      !!consentEntry && !!consentEntry.actor_name && String(consentEntry.reason).includes('by email'), consentEntry);

    // ------------------------------------------------------------------
    section('FR-CFG — the period is a setting, and a change applies to people already in the pool');
    // ------------------------------------------------------------------
    const longer = await admin.put('/settings/candidate_retention_months', { value: '24' });
    check('the period can be set to 24 months', longer.status === 200, longer.body);
    const underLonger = (await admin.get('/retention')).body;
    check('the preview reports the new period', underLonger.months === 24, underLonger.months);
    check('a candidate 13 months old is not due under 24 months',
      !underLonger.items.some((i: any) => i.consultant_id === due.id));

    const underNew = await recruiter.post('/consultants', {
      fullName: `Retention setting ${stamp}`, email: `ret.setting.${stamp}@example.co.za`,
      seniority: 'SENIOR', availability: 'AVAILABLE',
    });
    const newRow = (await sql(
      `SELECT (retention_expires_on - created_at::date) AS days FROM consultant WHERE consultant_id = $1`,
      [underNew.body.consultant_id]))[0];
    check('a new consultant gets the configured period, not a fixed 12 months',
      Number(newRow.days) > 700 && Number(newRow.days) < 740, newRow);

    const restored = await admin.put('/settings/candidate_retention_months', { value: originalMonths });
    check('the period is put back', restored.status === 200, restored.body);
    check('and the candidate is due again',
      (await admin.get('/retention')).body.items.some((i: any) => i.consultant_id === due.id));

    // ------------------------------------------------------------------
    section('Running retention');
    // ------------------------------------------------------------------
    check('an unexpected field is refused',
      (await admin.post('/retention/run', { everyone: true })).status === 400);

    const expected = (await admin.get('/retention')).body.due;
    const dry = await admin.post('/retention/run', { dryRun: true });
    check('a dry run reports what would happen', dry.status === 200 && dry.body.due === expected && dry.body.anonymised === 0, dry.body);
    check('and changes nothing',
      (await sql(`SELECT is_anonymised FROM consultant WHERE consultant_id = $1`, [due.id]))[0].is_anonymised === false);

    const run = await admin.post('/retention/run', {});
    check('an administrator can run retention', run.status === 200, run.body);
    check('it anonymised everyone who was due, and nobody failed',
      run.body.anonymised === expected && run.body.failed === 0, { expected, run: run.body });

    const second = await admin.post('/retention/run', {});
    check('running again finds nothing more to do', second.status === 200 && second.body.anonymised === 0 && second.body.due === 0, second.body);

    // ------------------------------------------------------------------
    section('NFR-PRI-005 — what anonymising removes');
    // ------------------------------------------------------------------
    const gone = (await sql(`SELECT * FROM consultant WHERE consultant_id = $1`, [due.id]))[0];
    check('the record is marked anonymised and inactive', gone.is_anonymised === true && gone.is_active === false);
    check('the name is gone', gone.full_name === 'Anonymised consultant', gone.full_name);
    check('the email is replaced, not just blanked', /^anonymised-[0-9a-f-]+@anonymised\.invalid$/.test(gone.email), gone.email);
    check('identity number, birth date and the blind index are gone',
      gone.id_number === null && gone.id_number_bidx === null && gone.date_of_birth === null);
    check('contact details, headline and source are gone',
      gone.mobile === null && gone.location === null && gone.headline === null && gone.source === null
      && gone.nationality === null && gone.right_to_work === null && gone.preferred_name === null);
    check('banking, vetting and rates are gone',
      gone.bank_name === null && gone.bank_account_ref === null && gone.vetting_status === null
      && gone.min_pay_rate === null && gone.preferred_pay_rate === null);
    check('seniority is kept, because it describes a kind of consultant', gone.seniority === 'SENIOR', gone.seniority);

    check('certifications are removed',
      (await sql(`SELECT count(*)::int AS n FROM certification WHERE consultant_id = $1`, [due.id]))[0].n === 0);
    check('documents are removed',
      (await sql(`SELECT count(*)::int AS n FROM document WHERE consultant_id = $1`, [due.id]))[0].n === 0);
    check('queued emails to them are removed',
      (await sql(`SELECT count(*)::int AS n FROM notification WHERE lower(recipient_email) = lower($1)`, [due.email]))[0].n === 0);

    const closed = (await sql(`SELECT * FROM app_user WHERE user_id = $1`, [acct.user_id]))[0];
    check('their sign-in account is closed', closed.is_active === false);
    check('and scrubbed of name and email',
      closed.full_name === 'Anonymised user' && closed.email.endsWith('@anonymised.invalid') && closed.phone === null);
    check('and its password can no longer match anything', closed.password_hash === '!');
    check('and its sessions are ended',
      (await sql(`SELECT count(*)::int AS n FROM user_session WHERE user_id = $1 AND revoked_at IS NULL`, [acct.user_id]))[0].n === 0);

    // Their name is now "Anonymised consultant", so searching for that finds them
    // if, and only if, the pool were still listing anonymised records.
    const search = await recruiter.get('/consultants?search=Anonymised&pageSize=100');
    check('they no longer appear in the pool',
      search.status === 200 && !search.body.items.some((x: any) => x.consultant_id === due.id),
      { status: search.status, found: search.body?.items?.length });

    const log = await admin.get(`/reports/audit?entityTable=consultant&entityId=${due.id}&limit=20`);
    const entry = (log.body.items ?? []).find((a: any) => a.action === 'CONSULTANT_ANONYMISED');
    check('it is in the audit log, with the reason', !!entry && String(entry.reason).includes('BR-021'), entry);
    check('and the entry holds no personal values',
      !JSON.stringify(entry ?? {}).includes(due.name) && !JSON.stringify(entry ?? {}).includes(due.email));

    // ------------------------------------------------------------------
    section('Who is left alone');
    // ------------------------------------------------------------------
    const rows = await sql(`SELECT consultant_id, is_anonymised FROM consultant WHERE consultant_id = ANY($1::uuid[])`,
      [[kept.id, recent.id, placed.id, ...(inFlightSet ? [inFlight.id] : [])]]);
    check('consented, recent, placed and in-flight consultants were not touched',
      rows.length === (inFlightSet ? 4 : 3) && rows.every((r: any) => r.is_anonymised === false), rows);

    // ------------------------------------------------------------------
    section('NFR-PRI-005 — anonymise on request, and keep the financial record');
    // ------------------------------------------------------------------
    const noReason = await admin.post(`/retention/consultants/${recent.id}/anonymise`, {});
    check('a request without a reason is refused', noReason.status === 400, noReason.body);
    check('a four-character reason is refused',
      (await admin.post(`/retention/consultants/${recent.id}/anonymise`, { reason: 'ask' })).status === 400);
    check('an unexpected field is refused',
      (await admin.post(`/retention/consultants/${recent.id}/anonymise`, { reason: 'Erasure requested', force: true })).status === 400);
    check('an id that is not a UUID is refused',
      (await admin.post('/retention/consultants/not-an-id/anonymise', { reason: 'Erasure requested' })).status === 400);
    check('an unknown consultant is a 404',
      (await admin.post('/retention/consultants/00000000-0000-4000-8000-000000000000/anonymise', { reason: 'Erasure requested' })).status === 404);
    check('somebody already anonymised is a 409',
      (await admin.post(`/retention/consultants/${due.id}/anonymise`, { reason: 'Erasure requested again' })).status === 409);

    const blocked = await admin.post(`/retention/consultants/${placed.id}/anonymise`, { reason: 'Erasure requested by the consultant' });
    check('somebody on a live placement cannot be anonymised', blocked.status === 409, blocked.body);
    check('and is left whole',
      (await sql(`SELECT full_name FROM consultant WHERE consultant_id = $1`, [placed.id]))[0].full_name === placed.name);

    const requested = await admin.post(`/retention/consultants/${recent.id}/anonymise`, { reason: 'Erasure requested by the consultant' });
    check('a recent, unplaced consultant can be anonymised on request', requested.status === 200, requested.body);
    check('the response says what was done', requested.body.anonymised === true, requested.body);

    const before = (await sql(
      `SELECT i.total, l.line_total, l.unit_rate, l.quantity, l.description
         FROM invoice i JOIN invoice_line l ON l.invoice_id = i.invoice_id WHERE i.invoice_id = $1`, [invoice.id]))[0];
    check('before: the invoice line holds the name', String(before.description).includes(placed.name), before.description);

    const ended = await admin.post(`/placements/${pl.body.placement_id}/terminate`, { reason: 'Ended so the consultant can be anonymised' });
    check('the placement is ended first', ended.status === 200, ended.body);

    const finished = await admin.post(`/retention/consultants/${placed.id}/anonymise`, { reason: 'Erasure requested by the consultant' });
    check('once the work is finished, a placed consultant can be anonymised', finished.status === 200, finished.body);
    check('the response counts the invoice line it rewrote', finished.body.invoice_lines_rewritten === 1, finished.body);

    const after = (await sql(
      `SELECT i.total, l.line_total, l.unit_rate, l.quantity, l.description
         FROM invoice i JOIN invoice_line l ON l.invoice_id = i.invoice_id WHERE i.invoice_id = $1`, [invoice.id]))[0];
    check('the invoice is kept', !!after);
    check('the name is taken out of the invoice line', !String(after.description).includes(placed.name) && String(after.description).includes('Anonymised consultant'), after.description);
    check('the rest of the line is intact', String(after.description).includes('Retention placement'), after.description);
    check('the amounts have not moved by a cent',
      Number(after.total) === Number(before.total) && Number(after.line_total) === Number(before.line_total)
      && Number(after.unit_rate) === Number(before.unit_rate) && Number(after.quantity) === Number(before.quantity), { before, after });

    const placementKept = (await sql(`SELECT status FROM placement WHERE placement_id = $1`, [pl.body.placement_id]))[0];
    check('the placement itself is kept', placementKept.status === 'TERMINATED', placementKept);
    const nameOnRecords = await admin.get(`/placements?consultantId=${placed.id}`);
    const shown = nameOnRecords.body.items.find((p: any) => p.placement_id === pl.body.placement_id);
    check('lists now show the anonymised name', shown?.consultant_name === 'Anonymised consultant', shown?.consultant_name);
  } finally {
    // Whatever happened above, leave the setting as it was found.
    try {
      if (adminActor) {
        await withActor(adminActor, (c) => c.query(
          `UPDATE system_setting SET setting_value = $1 WHERE setting_key = 'candidate_retention_months'`, [originalMonths]));
      }
    } catch { /* nothing more can be done */ }
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
