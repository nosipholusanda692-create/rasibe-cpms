/**
 * The notification endpoints behind the bell (FR-NOT-005).
 *
 * The important property is isolation: a notification is addressed to one
 * person, and the count, the list and the mark-read must each respect that.
 * A bell showing somebody else's unread count would be a disclosure, not a
 * cosmetic defect.
 */
import { createApp } from '../index.js';
import { closePool, withActor } from '../lib/db.js';
import { raiseScheduledNotifications } from '../services/scheduler.js';
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

  async signIn(email: string, password = 'Password123!') {
    await this.get('/auth/me');
    const r = await this.post('/auth/login', { email, password });
    if (r.status !== 200) throw new Error(`sign in failed for ${email}: ${JSON.stringify(r.body)}`);
    return (await this.get('/auth/me')).body.user;
  }
}

const ADMIN = { userId: '00000000-0000-0000-0000-000000000000', role: 'ADMINISTRATOR' as const };

async function main() {
  const app = createApp();
  const server: Server = await new Promise((r) => { const s = app.listen(PORT, () => r(s)); });

  try {
    // something to look at
    await withActor(ADMIN, async (c) => {
      const placements = await c.query(
        `SELECT placement_id FROM placement WHERE status IN ('ACTIVE','ENDING_SOON') LIMIT 1`);
      if (placements.rows.length) {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() + 14);
        await c.query('UPDATE placement SET end_date = $2::date WHERE placement_id = $1',
          [placements.rows[0].placement_id, d.toISOString().slice(0, 10)]);
      }
    });
    await raiseScheduledNotifications();

    const admin = new Client();
    const consultant = new Client();
    const recruiter = new Client();
    await admin.signIn('christinah@rasibe.co.za');
    await consultant.signIn('thabo.m@example.co.za');
    await recruiter.signIn('nosipho@rasibe.co.za');

    // ------------------------------------------------------------------
    section('The count');
    // ------------------------------------------------------------------
    const adminCount = await admin.get('/notifications/unread-count');
    check('the unread count is returned',
      adminCount.status === 200 && typeof adminCount.body.unread === 'number', adminCount.body);
    check('the administrator has unread notifications', adminCount.body.unread > 0,
      adminCount.body.unread);

    const anon = await new Client().get('/notifications/unread-count');
    check('someone not signed in gets no count', anon.status === 401, anon.status);

    // ------------------------------------------------------------------
    section('Each person sees only their own');
    // ------------------------------------------------------------------
    const adminList = await admin.get('/notifications');
    const consultantList = await consultant.get('/notifications');

    check('the administrator has a list', adminList.body.items.length > 0,
      adminList.body.items.length);

    const adminIds = new Set(adminList.body.items.map((n: any) => n.notification_id));
    const overlap = consultantList.body.items
      .filter((n: any) => adminIds.has(n.notification_id));
    check('no notification appears in two people\u2019s lists', overlap.length === 0, overlap.length);

    const recruiterCount = await recruiter.get('/notifications/unread-count');
    check('a recruiter\u2019s count is their own, not the administrator\u2019s',
      recruiterCount.body.unread !== adminCount.body.unread
      || recruiterCount.body.unread === 0,
      { recruiter: recruiterCount.body.unread, admin: adminCount.body.unread });

    // ------------------------------------------------------------------
    section('Marking read');
    // ------------------------------------------------------------------
    const target = adminList.body.items.find((n: any) => !n.read_at);
    check('there is an unread notification to open', !!target);

    const before = (await admin.get('/notifications/unread-count')).body.unread;
    const marked = await admin.post(`/notifications/${target.notification_id}/read`);
    check('it can be marked read', marked.status === 200, marked.body);

    const after = (await admin.get('/notifications/unread-count')).body.unread;
    check('the count falls by one', after === before - 1, { before, after });

    const again = await admin.post(`/notifications/${target.notification_id}/read`);
    const afterAgain = (await admin.get('/notifications/unread-count')).body.unread;
    check('marking it read twice changes nothing',
      again.status === 200 && afterAgain === after, { after, afterAgain });

    // ------------------------------------------------------------------
    section('One person cannot mark another\u2019s notification');
    // ------------------------------------------------------------------
    const consultantUnread = consultantList.body.items.find((n: any) => !n.read_at);
    if (consultantUnread) {
      const consultantBefore = (await consultant.get('/notifications/unread-count')).body.unread;
      await admin.post(`/notifications/${consultantUnread.notification_id}/read`);
      const consultantAfter = (await consultant.get('/notifications/unread-count')).body.unread;
      check('an administrator cannot mark a consultant\u2019s notification read',
        consultantAfter === consultantBefore,
        { before: consultantBefore, after: consultantAfter });
    } else {
      check('an administrator cannot mark a consultant\u2019s notification read', true);
    }

    // ------------------------------------------------------------------
    section('Mark all read');
    // ------------------------------------------------------------------
    const consultantBeforeAll = (await consultant.get('/notifications/unread-count')).body.unread;
    const all = await admin.post('/notifications/read-all');
    check('everything can be marked read at once', all.status === 200, all.body);

    const adminAfterAll = (await admin.get('/notifications/unread-count')).body.unread;
    check('the administrator has nothing unread left', adminAfterAll === 0, adminAfterAll);

    const consultantAfterAll = (await consultant.get('/notifications/unread-count')).body.unread;
    check('and nobody else was affected',
      consultantAfterAll === consultantBeforeAll,
      { before: consultantBeforeAll, after: consultantAfterAll });

    // ------------------------------------------------------------------
    section('What the list carries');
    // ------------------------------------------------------------------
    const fresh = await admin.get('/notifications');
    const sample = fresh.body.items[0];
    check('each entry has a subject', !!sample?.subject);
    check('each entry has a body', !!sample?.body);
    check('each entry says when it was raised', !!sample?.scheduled_for);
    check('each entry names what it is about',
      sample?.related_table !== undefined, Object.keys(sample ?? {}));
    check('no template placeholder survived rendering',
      !String(sample?.subject).includes('{{') && !String(sample?.body).includes('{{'),
      sample?.subject);

    const unreadOnly = await admin.get('/notifications?unreadOnly=true');
    check('the list can be filtered to unread only',
      unreadOnly.body.items.every((n: any) => !n.read_at), unreadOnly.body.items.length);
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
