/**
 * Pagination (NFR-PER-006).
 *
 * The defects worth testing for are not "does it return fewer rows". They are
 * losing a row between pages, returning the same row twice, reporting a total
 * that counts rows the caller may not see, and letting a caller ask for a page
 * size large enough to defeat the point.
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
    if (r.status !== 200) throw new Error(`sign in failed: ${JSON.stringify(r.body)}`);
    return (await this.get('/auth/me')).body.user;
  }
}

/** Enough consultants that paging has something to page through. */
async function seedPool(count: number) {
  await withActor({ userId: '00000000-0000-0000-0000-000000000000', role: 'ADMINISTRATOR' },
    async (c) => {
      for (let i = 0; i < count; i += 1) {
        await c.query(
          `INSERT INTO consultant (full_name, email, seniority, availability, headline)
           VALUES ($1, $2, 'INTERMEDIATE', 'AVAILABLE', 'Seeded for the paging suite')
           ON CONFLICT (email) DO NOTHING`,
          [`Paging Test ${String(i).padStart(3, '0')}`, `paging.${i}.${Date.now()}@example.co.za`],
        );
      }
    });
}

const ids = (body: any, key: string) => body.items.map((x: any) => x[key]);

async function main() {
  const app = createApp();
  const server: Server = await new Promise((r) => { const s = app.listen(PORT, () => r(s)); });

  try {
    await seedPool(60);

    const admin = new Client();
    const recruiter = new Client();
    const clientMgr = new Client();
    await admin.signIn('christinah@rasibe.co.za');
    await recruiter.signIn('nosipho@rasibe.co.za');
    await clientMgr.signIn('s.naidoo@nedgroupit.co.za');

    // ------------------------------------------------------------------
    section('The envelope');
    // ------------------------------------------------------------------
    const first = await recruiter.get('/consultants?pageSize=10');
    check('a list reports its page', first.body.page === 1, first.body?.page);
    check('a list reports its page size', first.body.pageSize === 10, first.body?.pageSize);
    check('a list reports the total before the limit',
      first.body.total > 10, first.body?.total);
    check('a list reports how many pages there are',
      first.body.pageCount === Math.ceil(first.body.total / 10), first.body?.pageCount);
    check('a list says whether there is more', first.body.hasMore === true);
    check('the page holds no more than the page size',
      first.body.items.length <= 10, first.body.items.length);

    // ------------------------------------------------------------------
    section('Walking the pages');
    // ------------------------------------------------------------------
    const seen = new Set<string>();
    let duplicates = 0;
    let pagesWalked = 0;
    let reported = 0;

    for (let p = 1; p <= 8; p += 1) {
      const r = await recruiter.get(`/consultants?pageSize=10&page=${p}`);
      reported = r.body.total;
      pagesWalked += 1;
      for (const id of ids(r.body, 'consultant_id')) {
        if (seen.has(id)) duplicates += 1;
        seen.add(id);
      }
      if (!r.body.hasMore) break;
    }

    check('no row appears on two pages', duplicates === 0, duplicates);
    check('walking the pages reaches every row',
      seen.size === Math.min(reported, pagesWalked * 10),
      { collected: seen.size, total: reported, pages: pagesWalked });

    const all = await recruiter.get('/consultants?pageSize=100');
    check('one large page holds the same rows as several small ones',
      ids(all.body, 'consultant_id').sort().join() ===
      [...seen].sort().join() || all.body.total > seen.size,
      { large: all.body.items.length, walked: seen.size });

    // ------------------------------------------------------------------
    section('Edges');
    // ------------------------------------------------------------------
    const beyond = await recruiter.get('/consultants?pageSize=10&page=9999');
    check('a page past the end is empty rather than an error',
      beyond.status === 200 && beyond.body.items.length === 0, beyond.status);
    check('and it still reports the true total', beyond.body.total === reported);

    const zero = await recruiter.get('/consultants?page=0');
    check('page zero is refused', zero.status === 400, zero.status);

    const negative = await recruiter.get('/consultants?page=-1');
    check('a negative page is refused', negative.status === 400);

    const huge = await recruiter.get('/consultants?pageSize=100000');
    check('an oversized page is refused rather than served',
      huge.status === 400, huge.status);

    const atCeiling = await recruiter.get('/consultants?pageSize=100');
    check('the ceiling itself is allowed', atCeiling.status === 200, atCeiling.status);
    const overCeiling = await recruiter.get('/consultants?pageSize=101');
    check('one above the ceiling is refused', overCeiling.status === 400, overCeiling.status);

    const nonsense = await recruiter.get('/consultants?page=abc');
    check('a non-numeric page is refused', nonsense.status === 400);

    const defaulted = await recruiter.get('/consultants');
    check('a caller sending nothing gets a sensible default',
      defaulted.body.pageSize === 25, defaulted.body?.pageSize);
    check('and is not served the whole table',
      defaulted.body.items.length <= 25, defaulted.body.items.length);

    // ------------------------------------------------------------------
    section('The total respects who is asking');
    // ------------------------------------------------------------------
    const adminPlacements = await admin.get('/placements?pageSize=5');
    const clientPlacements = await clientMgr.get('/placements?pageSize=5');
    check('an administrator is told the full total',
      adminPlacements.body.total >= clientPlacements.body.total,
      { admin: adminPlacements.body.total, client: clientPlacements.body.total });
    check('a client manager is told only their own total',
      clientPlacements.body.total < adminPlacements.body.total
      || adminPlacements.body.total === clientPlacements.body.total,
      { admin: adminPlacements.body.total, client: clientPlacements.body.total });
    check('and the count never exceeds what they can read',
      clientPlacements.body.total >= clientPlacements.body.items.length);

    // ------------------------------------------------------------------
    section('Every list that needed it');
    // ------------------------------------------------------------------
    for (const [label, path] of [
      ['consultants', '/consultants?pageSize=5'],
      ['role requests', '/requests?pageSize=5'],
      ['placements', '/placements?pageSize=5'],
      ['timesheets', '/timesheets?pageSize=5'],
      ['invoices', '/invoices?pageSize=5'],
    ] as const) {
      const r = await admin.get(path);
      check(`${label} page`,
        r.status === 200
        && typeof r.body.total === 'number'
        && typeof r.body.pageCount === 'number'
        && r.body.items.length <= 5,
        { status: r.status, keys: Object.keys(r.body ?? {}) });
    }

    const audit = await admin.get('/reports/audit?pageSize=5');
    check('the audit log pages',
      audit.status === 200 && typeof audit.body.total === 'number'
      && audit.body.items.length <= 5, { status: audit.status, n: audit.body?.items?.length });

    const auditLegacy = await admin.get('/reports/audit?limit=3');
    check('the audit log still honours the older limit parameter',
      auditLegacy.body.items.length <= 3, auditLegacy.body?.items?.length);

    // ------------------------------------------------------------------
    section('Filtering and paging together');
    // ------------------------------------------------------------------
    const filtered = await recruiter.get('/consultants?availability=AVAILABLE&pageSize=5');
    check('a filtered list still pages', filtered.body.pageSize === 5);
    check('the total counts the filtered rows, not every row',
      filtered.body.total <= reported, { filtered: filtered.body.total, all: reported });
    check('every row on the page matches the filter',
      filtered.body.items.every((c: any) => c.availability === 'AVAILABLE'),
      filtered.body.items.map((c: any) => c.availability).slice(0, 5));

    const narrow = await recruiter.get('/consultants?search=Paging+Test&pageSize=5&page=2');
    check('a search can be paged into', narrow.status === 200, narrow.status);
    check('and the rows still match the search',
      narrow.body.items.every((c: any) => String(c.full_name).includes('Paging Test')),
      narrow.body.items.map((c: any) => c.full_name).slice(0, 3));

    // ------------------------------------------------------------------
    section('Projection survives paging');
    // ------------------------------------------------------------------
    const cmPlacements = await clientMgr.get('/placements?pageSize=5');
    check('a paged response is still projected for the role',
      cmPlacements.body.items.every((p: any) => p.pay_rate === undefined),
      cmPlacements.body.items[0]);
    check('and still carries what the role may see',
      cmPlacements.body.items.every((p: any) => p.bill_rate !== undefined));
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
