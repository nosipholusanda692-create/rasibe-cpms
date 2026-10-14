/**
 * Mobile client integration tests.
 *
 * Drives the API exactly as the phone does: same endpoints, same order, and
 * crucially the same CSRF handling. The client receives rasibe_csrf on a read
 * and must echo it in X-CSRF-Token on every write, so these tests carry a
 * cookie jar rather than a bare session string.
 *
 * Run with the API already listening on TEST_API (default 4000).
 */
const BASE = (process.env.TEST_API ?? 'http://127.0.0.1:4000') + '/api';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    pass += 1;
    console.log(`  \u2713 ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  \u2717 ${name}`);
    if (detail !== undefined) console.log(`      ${JSON.stringify(detail).slice(0, 220)}`);
  }
}

function section(t: string) { console.log(`\n${t}`); }

/** A browser-like client: keeps every cookie and echoes the CSRF token. */
class Phone {
  private cookies = new Map<string, string>();

  private header(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.cookies.size) {
      h.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    const csrf = this.cookies.get('rasibe_csrf');
    if (csrf) h['X-CSRF-Token'] = csrf;
    return h;
  }

  private absorb(res: Response) {
    // undici exposes every Set-Cookie via getSetCookie
    const all = (res.headers as any).getSetCookie?.() ?? [];
    for (const line of all) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }

  async call(method: string, path: string, body?: unknown) {
    const res = await fetch(BASE + path, {
      method,
      headers: this.header(),
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

  hasCsrf() { return this.cookies.has('rasibe_csrf'); }
  csrf() { return this.cookies.get('rasibe_csrf'); }

  /** Mimics the app: a read first, which seeds the token, then sign in. */
  async signIn(email: string) {
    await this.get('/auth/me');
    const r = await this.post('/auth/login', { email, password: 'Password123!' });
    if (r.status !== 200) throw new Error(`sign in failed: ${JSON.stringify(r.body)}`);
    const me = await this.get('/auth/me');
    return me.body.user;
  }

  /** Sends without the CSRF header, to prove the protection is live. */
  async postWithoutCsrf(path: string, body?: unknown) {
    const h = this.header();
    delete h['X-CSRF-Token'];
    const res = await fetch(BASE + path, { method: 'POST', headers: h, body: JSON.stringify(body ?? {}) });
    const t = await res.text();
    return { status: res.status, body: t ? JSON.parse(t) : null };
  }
}

const mondayOf = (d: Date) => {
  const c = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dow = c.getUTCDay() === 0 ? 7 : c.getUTCDay();
  c.setUTCDate(c.getUTCDate() - (dow - 1));
  return c.toISOString().slice(0, 10);
};
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const today = () => new Date().toISOString().slice(0, 10);

async function main() {
  const consultant = new Phone();
  const approver = new Phone();

  // ------------------------------------------------------------------
  section('Sign in and CSRF (NFR-SEC-008)');
  // ------------------------------------------------------------------
  const anon = new Phone();
  const beforeRead = anon.hasCsrf();
  await anon.get('/auth/me');
  check('a read hands the client a CSRF token', !beforeRead && anon.hasCsrf());

  const noToken = await anon.postWithoutCsrf('/auth/login', {
    email: 'thabo.m@example.co.za', password: 'Password123!',
  });
  check('a write without the token is refused', noToken.status === 403, noToken.body);

  const me = await consultant.signIn('thabo.m@example.co.za');
  check('the consultant signs in with the token echoed', me.role === 'CONSULTANT', me);
  check('the consultant is linked to a consultant record', !!me.consultantId);

  const tokenBefore = consultant.csrf();
  const approverUser = await approver.signIn('s.naidoo@nedgroupit.co.za');
  check('the client manager signs in', approverUser.role === 'CLIENT_MANAGER');
  check('the token is bound to the session, so each client has its own',
    tokenBefore !== approver.csrf());

  // ------------------------------------------------------------------
  section('Rate confidentiality on a phone (BR-006)');
  // ------------------------------------------------------------------
  const myPlacements = await consultant.get('/placements');
  const mine = myPlacements.body.items[0];
  check('the consultant sees their own placements', myPlacements.body.items.length > 0);
  check('no bill rate is ever sent to the phone', mine?.bill_rate === undefined, mine);
  check('no margin is ever sent to the phone', mine?.margin_amount === undefined);
  check('the consultant does see their own pay rate', mine?.pay_rate !== undefined);

  // ------------------------------------------------------------------
  section('Capturing the week (UC-16, UC-17)');
  // ------------------------------------------------------------------
  const ws = mondayOf(new Date());
  const week = await consultant.get(`/timesheets/my/current?weekStart=${ws}`);
  check('the current week loads', week.status === 200 && week.body.items.length > 0, week.body);

  const sheet = week.body.items[0];
  check('the week carries the placement for the heading', !!sheet.placement?.client_name);
  check('the week carries standard hours for the quick fill',
    sheet.placement?.standard_hours_per_day !== undefined);

  const workdays = [0, 1, 2, 3, 4]
    .map((i) => addDays(ws, i))
    .filter((d) => d <= today());

  const future = addDays(today(), 3);
  const futureSave = await consultant.put(`/timesheets/${sheet.timesheet_id}/lines`, {
    lines: [{ workDate: future, normalHours: 8, overtimeHours: 0 }],
  });
  check('hours on a future date are refused (BR-004)', futureSave.status === 400, futureSave.body);

  const saved = await consultant.put(`/timesheets/${sheet.timesheet_id}/lines`, {
    lines: workdays.map((d) => ({ workDate: d, normalHours: 8, overtimeHours: 0 })),
  });
  check('a draft week saves', saved.status === 200, saved.body);
  check('the total is derived from the days',
    Number(saved.body.total_standard_hours) === workdays.length * 8,
    saved.body.total_standard_hours);

  const submitted = await consultant.post(`/timesheets/${sheet.timesheet_id}/submit`);
  check('the week submits', submitted.status === 200, submitted.body);

  const editAfter = await consultant.put(`/timesheets/${sheet.timesheet_id}/lines`, {
    lines: workdays.map((d) => ({ workDate: d, normalHours: 9, overtimeHours: 0 })),
  });
  check('a submitted week can no longer be edited (BR-018)', editAfter.status === 409);

  // ------------------------------------------------------------------
  section('Approving on a phone (UC-18)');
  // ------------------------------------------------------------------
  const queue = await approver.get('/timesheets?status=SUBMITTED');
  const waiting = queue.body.items.find((t: any) => t.timesheet_id === sheet.timesheet_id);
  check('the week appears in the approver queue', !!waiting, queue.body.items.length);
  check('the approver sees hours', waiting && Number(waiting.total_standard_hours) > 0);
  check('the approver is NOT sent the pay rate (BR-007)', waiting?.pay_rate === undefined, waiting);
  check('the approver IS sent the bill rate they are charged', waiting?.bill_rate !== undefined);

  const days = await approver.get(`/timesheets/${sheet.timesheet_id}`);
  check('the day breakdown loads for review', Array.isArray(days.body.lines), days.body?.lines?.length);

  const noReason = await approver.post(`/timesheets/${sheet.timesheet_id}/decision`, {
    decision: 'REJECT',
  });
  check('rejecting without a reason is refused (BR-005)', noReason.status === 400, noReason.body);

  const rejected = await approver.post(`/timesheets/${sheet.timesheet_id}/decision`, {
    decision: 'REJECT', reason: 'Thursday shows 8 hours but you left at midday.',
  });
  check('rejecting with a reason succeeds', rejected.status === 200, rejected.body);

  const returned = await consultant.get(`/timesheets/${sheet.timesheet_id}`);
  check('the consultant can see why it came back',
    returned.body.status === 'REJECTED' && !!returned.body.rejected_reason,
    returned.body?.rejected_reason);

  const corrected = await consultant.put(`/timesheets/${sheet.timesheet_id}/lines`, {
    lines: workdays.map((d, i) => ({ workDate: d, normalHours: i === 3 ? 4 : 8, overtimeHours: 0 })),
  });
  check('a returned week can be corrected', corrected.status === 200);
  await consultant.post(`/timesheets/${sheet.timesheet_id}/submit`);
  const approved = await approver.post(`/timesheets/${sheet.timesheet_id}/decision`, {
    decision: 'APPROVE',
  });
  check('the corrected week is approved', approved.status === 200, approved.body);

  // ------------------------------------------------------------------
  section('Offline queue (FR-MOB-004 to 008, BR-019)');
  // ------------------------------------------------------------------
  const placements = await consultant.get('/placements');
  const active = placements.body.items.find((p: any) =>
    ['ACTIVE', 'ENDING_SOON'].includes(p.status));
  check('an active placement is available to capture against', !!active);

  const priorWeek = addDays(ws, -7);
  const priorDays = [0, 1, 2].map((i) => addDays(priorWeek, i));
  const token = crypto.randomUUID();
  const payload = {
    clientUuid: token,
    placementId: active.placement_id,
    weekStart: priorWeek,
    rowVersion: 0,
    submit: true,
    lines: priorDays.map((d) => ({ workDate: d, normalHours: 8, overtimeHours: 0 })),
  };

  const first = await consultant.post('/timesheets/sync', payload);
  check('a week captured offline synchronises',
    first.status === 200 && first.body.outcome === 'accepted', first.body);

  const second = await consultant.post('/timesheets/sync', payload);
  check('the same token creates no duplicate (BR-019)',
    second.body.outcome === 'already_accepted', second.body);
  check('the duplicate returns the same week',
    second.body.timesheet.timesheet_id === first.body.timesheet.timesheet_id);

  // the office moves on while the phone is still holding an old copy
  await approver.post(`/timesheets/${first.body.timesheet.timesheet_id}/decision`, {
    decision: 'APPROVE',
  });
  const stale = await consultant.post('/timesheets/sync', {
    ...payload, clientUuid: crypto.randomUUID(), rowVersion: 0,
  });
  check('a stale copy does not overwrite the office (BR-019)',
    stale.body.outcome === 'conflict', stale.body);
  check('the consultant is told their work was not thrown away',
    String(stale.body.message).includes('not been discarded'), stale.body.message);

  // ------------------------------------------------------------------
  section('Notifications and account');
  // ------------------------------------------------------------------
  const notes = await consultant.get('/notifications');
  check('notifications load on the phone', notes.status === 200 && notes.body.items.length > 0,
    notes.body?.items?.length);
  check('a rejection reached the consultant',
    notes.body.items.some((n: any) => n.event === 'TIMESHEET_REJECTED'),
    notes.body.items.map((n: any) => n.event).slice(0, 6));

  const approverNotes = await approver.get('/notifications');
  check('the approver was told a week was waiting',
    approverNotes.body.items.some((n: any) => n.event === 'TIMESHEET_AWAITING_APPROVAL'),
    approverNotes.body.items.map((n: any) => n.event).slice(0, 6));

  // ------------------------------------------------------------------
  section('What the phone must not reach');
  // ------------------------------------------------------------------
  check('a consultant cannot read the margin report',
    (await consultant.get('/reports/margin')).status === 403);
  check('a consultant cannot list the consultant pool as internal staff do',
    (await consultant.get('/consultants')).body.items.length <= 1);
  check('an approver cannot issue an invoice',
    (await approver.post('/invoices/prepare', {
      clientId: approverUser.clients[0].clientId,
      periodStart: priorWeek, periodEnd: today(),
    })).status === 403);
  check('a consultant cannot approve their own week',
    (await consultant.post(`/timesheets/${sheet.timesheet_id}/decision`, {
      decision: 'APPROVE',
    })).status === 403);

  // ------------------------------------------------------------------
  section('Sign out');
  // ------------------------------------------------------------------
  const out = await consultant.post('/auth/logout');
  check('sign out succeeds', out.status === 200);
  check('the session is gone afterwards',
    (await consultant.get('/timesheets/my/current')).status === 401);

  console.log(`\n${'='.repeat(56)}`);
  console.log(`  ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('\n  Failures:');
    failures.forEach((f) => console.log(`   - ${f}`));
  }
  console.log('='.repeat(56));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('Test run could not complete:', e);
  process.exit(1);
});
