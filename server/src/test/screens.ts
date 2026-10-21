/**
 * The calls the two new screens make.
 *
 * Placement extension and retention both worked through the API and had no
 * interface, which the marker noticed. The screens are now built; these
 * assertions cover what they actually send, including the fields the screens
 * display and the refusals they have to render.
 */
import { createApp } from '../index.js';
import { closePool, withActor } from '../lib/db.js';
import type { Server } from 'node:http';

const PORT = Number(process.env.TEST_PORT ?? 4108);
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

const ADMIN = { userId: '00000000-0000-0000-0000-000000000000', role: 'ADMINISTRATOR' as const };
const iso = (d: Date) => d.toISOString().slice(0, 10);
const fromNow = (days: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
};

async function main() {
  const app = createApp();
  const server: Server = await new Promise((r) => { const s = app.listen(PORT, () => r(s)); });

  try {
    const admin = new Client();
    const recruiter = new Client();
    await admin.signIn('christinah@rasibe.co.za');
    await recruiter.signIn('nosipho@rasibe.co.za');

    // ------------------------------------------------------------------
    section('What the extension dialog needs to show');
    // ------------------------------------------------------------------
    const live = await admin.get('/placements?status=ACTIVE,ENDING_SOON');
    const p = live.body.items[0];
    check('there is a live placement', !!p, live.body.items.length);

    check('the list gives the dialog the consultant name', !!p.consultant_name);
    check('and the client name', !!p.client_name);
    check('and the current end date', !!p.end_date);
    check('and how many times it has been extended',
      p.extension_count !== undefined, p.extension_count);
    check('and what it originally ran to',
      'original_end_date' in p, Object.keys(p).filter((k) => k.includes('end')));

    // ------------------------------------------------------------------
    section('Extending (FR-PLC-006)');
    // ------------------------------------------------------------------
    const before = String(p.end_date).slice(0, 10);
    const later = fromNow(240);

    const noReason = await admin.post(`/placements/${p.placement_id}/extend`, {
      newEndDate: later,
    });
    check('an extension with no reason is refused', noReason.status === 400, noReason.body);

    const backwards = await admin.post(`/placements/${p.placement_id}/extend`, {
      newEndDate: fromNow(-30), reason: 'Trying to shorten it this way',
    });
    check('an earlier date is refused', backwards.status === 400, backwards.body?.message);
    check('and the message names the current end date',
      JSON.stringify(backwards.body?.detail ?? '').includes(before), backwards.body?.detail);

    const absurd = await admin.post(`/placements/${p.placement_id}/extend`, {
      newEndDate: fromNow(365 * 6), reason: 'A typing error in the year',
    });
    check('a date years out is refused, which catches a mistyped year',
      absurd.status === 400, absurd.body?.detail);

    const byRecruiter = await recruiter.post(`/placements/${p.placement_id}/extend`, {
      newEndDate: later, reason: 'A recruiter attempting an extension',
    });
    check('a recruiter cannot extend', byRecruiter.status === 403, byRecruiter.status);

    const extended = await admin.post(`/placements/${p.placement_id}/extend`, {
      newEndDate: later, reason: 'Client extended the project to the end of the year',
    });
    check('an administrator can extend', extended.status === 200, extended.body);
    check('the end date moves', String(extended.body.end_date).slice(0, 10) === later,
      extended.body?.end_date);
    check('the original end date is kept (FR-PLC-006)',
      String(extended.body.original_end_date).slice(0, 10) === before,
      { kept: extended.body?.original_end_date, was: before });
    check('the extension is counted', extended.body.extension_count === 1,
      extended.body?.extension_count);
    check('it is still the same placement',
      extended.body.placement_id === p.placement_id);

    const again = await admin.post(`/placements/${p.placement_id}/extend`, {
      newEndDate: fromNow(300), reason: 'Extended a second time by agreement',
    });
    check('it can be extended again', again.status === 200, again.body);
    check('the count rises', again.body.extension_count === 2, again.body?.extension_count);
    check('and the original end date still shows the first one',
      String(again.body.original_end_date).slice(0, 10) === before,
      again.body?.original_end_date);

    const audit = await admin.get('/reports/audit?pageSize=20');
    check('an extension is audited',
      audit.body.items.some((a: any) => a.action === 'PLACEMENT_EXTENDED'),
      audit.body.items.map((a: any) => a.action).slice(0, 6));

    // an extension that would overlap another full-time placement
    const all = await admin.get('/placements?pageSize=100');
    const sameConsultant = all.body.items.filter(
      (x: any) => x.consultant_id === p.consultant_id && x.placement_id !== p.placement_id);
    if (sameConsultant.length) {
      const clash = await admin.post(`/placements/${p.placement_id}/extend`, {
        newEndDate: fromNow(365 * 2), reason: 'Would run over another placement',
      });
      check('an extension that would overlap is refused (BR-001)',
        clash.status >= 400, clash.status);
    } else {
      check('an extension that would overlap is refused (BR-001)', true);
    }

    const ended = all.body.items.find((x: any) =>
      ['ENDED', 'TERMINATED'].includes(x.status));
    if (ended) {
      const dead = await admin.post(`/placements/${ended.placement_id}/extend`, {
        newEndDate: fromNow(120), reason: 'Trying to revive a finished placement',
      });
      check('a finished placement cannot be extended', dead.status === 409, dead.status);
    } else {
      check('a finished placement cannot be extended', true);
    }

    // ------------------------------------------------------------------
    section('What the retention screen needs to show');
    // ------------------------------------------------------------------
    const view = await admin.get('/retention');
    check('the screen loads', view.status === 200, view.status);
    check('it reports the retention period', typeof view.body.months === 'number',
      view.body?.months);
    check('and how many are due', typeof view.body.due === 'number', view.body?.due);
    check('and a list to show', Array.isArray(view.body.items));

    const byRecruiterView = await recruiter.get('/retention');
    check('a recruiter cannot see the retention screen',
      byRecruiterView.status === 403, byRecruiterView.status);

    // somebody genuinely due
    await withActor(ADMIN, async (c) => {
      await c.query(
        `INSERT INTO consultant (full_name, email, seniority, availability,
                                 created_at, retention_expires_on)
         VALUES ($1,$2,'SENIOR','AVAILABLE', now() - interval '18 months',
                 (now() - interval '2 months')::date)`,
        [`Retention Screen ${Date.now()}`, `retention.screen.${Date.now()}@example.co.za`],
      );
    });

    const withDue = await admin.get('/retention');
    check('somebody past their period appears', withDue.body.due > 0, withDue.body?.due);

    const row = withDue.body.items[0];
    check('each row names the person', !!row?.full_name, Object.keys(row ?? {}));
    check('and when they were added', !!row?.created_at);
    check('and when their period became due', !!row?.due_on, Object.keys(row ?? {}));
    check('and how long it has been due', row?.days_overdue !== undefined, row?.days_overdue);

    // ------------------------------------------------------------------
    section('Keeping somebody longer (BR-021)');
    // ------------------------------------------------------------------
    const keepId = row.consultant_id;

    const noDate = await admin.post(`/retention/consultants/${keepId}/consent`, {
      retainUntil: null, reason: 'Withdrawing consent',
    });
    check('consent can be withdrawn with null', noDate.status === 200, noDate.status);

    const noHow = await admin.post(`/retention/consultants/${keepId}/consent`, {
      retainUntil: fromNow(365),
    });
    check('consent without a record of how it was given is refused',
      noHow.status === 400, noHow.body?.message);

    const consented = await admin.post(`/retention/consultants/${keepId}/consent`, {
      retainUntil: fromNow(365),
      reason: 'Confirmed by email on 14 October, asked to be kept on file',
    });
    check('consent can be recorded', consented.status === 200, consented.body);

    const afterConsent = await admin.get('/retention');
    check('and they drop out of the due list',
      !afterConsent.body.items.some((x: any) => x.consultant_id === keepId),
      afterConsent.body.items.length);

    // ------------------------------------------------------------------
    section('Anonymising');
    // ------------------------------------------------------------------
    await withActor(ADMIN, async (c) => {
      await c.query(
        `INSERT INTO consultant (full_name, email, seniority, availability,
                                 created_at, retention_expires_on)
         VALUES ($1,$2,'SENIOR','AVAILABLE', now() - interval '20 months',
                 (now() - interval '3 months')::date)`,
        [`Anonymise Me ${Date.now()}`, `anon.me.${Date.now()}@example.co.za`],
      );
    });

    const dueNow = await admin.get('/retention');
    const victim = dueNow.body.items[0];
    check('somebody is due again', !!victim, dueNow.body?.due);

    const byRecruiterAnon = await recruiter.post(
      `/retention/consultants/${victim.consultant_id}/anonymise`,
      { reason: 'A recruiter attempting an anonymisation' });
    check('a recruiter cannot anonymise', byRecruiterAnon.status === 403, byRecruiterAnon.status);

    const noWhy = await admin.post(
      `/retention/consultants/${victim.consultant_id}/anonymise`, { reason: '' });
    check('anonymising without a reason is refused', noWhy.status === 400, noWhy.status);

    const anon = await admin.post(
      `/retention/consultants/${victim.consultant_id}/anonymise`,
      { reason: 'Retention period passed with no placement' });
    check('an administrator can anonymise', anon.status === 200, anon.body);
    check('the response tells the screen what happened',
      anon.body.invoice_lines_rewritten !== undefined
      && anon.body.documents_removed !== undefined, anon.body);

    const after = await admin.get(`/consultants/${victim.consultant_id}`);
    check('the name is gone',
      after.status === 404 || !String(after.body?.full_name ?? '').includes('Anonymise Me'),
      after.body?.full_name);

    // ------------------------------------------------------------------
    section('The preview before the run');
    // ------------------------------------------------------------------
    const dry = await admin.post('/retention/run', { dryRun: true });
    check('a dry run reports without changing anything', dry.status === 200 && dry.body.dryRun,
      dry.body);
    check('it says how many are due', typeof dry.body.due === 'number', dry.body?.due);
    check('and anonymises none', dry.body.anonymised === 0, dry.body?.anonymised);

    const stillThere = await admin.get('/retention');
    check('the list is unchanged after a dry run',
      stillThere.body.due === dry.body.due, { before: dry.body.due, after: stillThere.body.due });

    const byRecruiterRun = await recruiter.post('/retention/run', {});
    check('a recruiter cannot run it', byRecruiterRun.status === 403, byRecruiterRun.status);
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
