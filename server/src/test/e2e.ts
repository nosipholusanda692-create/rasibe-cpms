/** Drives the API exactly as the web client does: same endpoints, same order. */
import { createApp } from '../index.js';
import { closePool } from '../lib/db.js';

const PORT = 4101;
const BASE = `http://127.0.0.1:${PORT}/api`;
const jar: Record<string, string> = {};
let pass = 0, fail = 0;

async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(jar[who] ? { Cookie: jar[who] } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = res.headers.get('set-cookie');
  if (sc) jar[who] = sc.split(';')[0];
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}
const login = (w: string, e: string) => call(w, 'POST', '/auth/login', { email: e, password: 'Password123!' });
function ok(n: string, c: boolean, d?: unknown) {
  if (c) { pass++; console.log(`  \u2713 ${n}`); }
  else { fail++; console.log(`  \u2717 ${n} ${JSON.stringify(d).slice(0, 150)}`); }
}

const server = await new Promise<any>((r) => { const s = createApp().listen(PORT, () => r(s)); });
try {
  await login('admin', 'christinah@rasibe.co.za');
  await login('rec', 'nosipho@rasibe.co.za');
  await login('con', 'thabo.m@example.co.za');
  await login('cm', 's.naidoo@nedgroupit.co.za');

  console.log('\nScreens the web client loads');
  const dash = await call('admin', 'GET', '/dashboard');
  ok('dashboard loads with margin for administrator', dash.status === 200 && !!dash.body.margin);
  const dashRec = await call('rec', 'GET', '/dashboard');
  ok('dashboard omits margin for recruiter', !dashRec.body.margin);

  const search = await call('rec', 'GET', '/consultants?search=Thabo');
  ok('consultant search by name returns a match', search.body.items.length === 1, search.body.items.length);
  const skills = await call('rec', 'GET', '/skills');
  const java = skills.body.items.find((s: any) => s.name === 'Java');
  const byskill = await call('rec', 'GET', `/consultants?skill=${java.skill_id}`);
  ok('consultant search by skill', byskill.body.items.length >= 1, byskill.body.items.length);
  const bydate = await call('rec', 'GET', '/consultants?availableFrom=2026-12-01');
  ok('consultant search by available-by date (feedback FB-04)', bydate.status === 200);

  const reqs = await call('rec', 'GET', '/requests?status=OPEN,SHORTLISTING,INTERVIEWING');
  ok('role request list loads', reqs.body.items.length > 0, reqs.body.items.length);
  const rid = reqs.body.items[0].request_id;
  ok('request detail loads', (await call('rec', 'GET', `/requests/${rid}`)).status === 200);
  const matches = await call('rec', 'GET', `/requests/${rid}/matches`);
  ok('matching pool flags consent per candidate',
    matches.body.items.every((m: any) => 'has_consent' in m));

  ok('approvals screen loads for client manager',
    (await call('cm', 'GET', '/timesheets?status=SUBMITTED')).status === 200);

  const my = await call('con', 'GET', '/timesheets/my/current');
  ok('consultant current week loads', my.status === 200 && Array.isArray(my.body.items));
  ok('the consultant week never carries a bill rate',
    my.body.items.every((s: any) => s.bill_rate === undefined));

  ok('invoice list loads', (await call('admin', 'GET', '/invoices')).status === 200);
  ok('margin report loads for administrator', (await call('admin', 'GET', '/reports/margin')).status === 200);
  ok('margin report refused for recruiter', (await call('rec', 'GET', '/reports/margin')).status === 403);
  ok('invoice ageing loads', (await call('rec', 'GET', '/reports/invoice-ageing')).status === 200);
  ok('utilisation loads', (await call('rec', 'GET', '/reports/utilisation')).status === 200);

  const set = await call('admin', 'GET', '/settings');
  ok('settings load', set.body.items.length > 10, set.body.items?.length);
  ok('a recruiter may not change a setting',
    (await call('rec', 'PUT', '/settings/max_hours_per_day', { value: '20' })).status === 403);
  ok('notifications load', (await call('con', 'GET', '/notifications')).status === 200);
} finally {
  server.close();
  await closePool();
}
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
