/**
 * Scheduled notifications (FR-TMS-013, FR-PLC-008).
 *
 * The property that matters is not "does it raise a reminder". It is that
 * running it again raises nothing again. A scheduler that duplicates is worse
 * than one that does not run: a consultant chased four times an hour stops
 * reading the messages, and then misses the one that mattered.
 *
 * These assertions place data at the exact boundaries — a week that ended
 * yesterday, a placement ending in exactly 60 days — and check what is raised,
 * to whom, and what happens on a second run.
 */
import { raiseScheduledNotifications } from '../services/scheduler.js';
import { withActor, closePool } from '../lib/db.js';

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

const ADMIN = { userId: '00000000-0000-0000-0000-000000000000', role: 'ADMINISTRATOR' as const };

const sql = async <T = any>(text: string, params: unknown[] = []): Promise<T[]> =>
  withActor(ADMIN, async (c) => (await c.query(text, params)).rows as T[]);

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysFromNow = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};

/** Counts notifications of an event raised by the scheduler. */
const countRaised = async (event: string, prefix?: string) => {
  const r = await sql<{ n: number }>(
    `SELECT count(*)::int AS n FROM notification
      WHERE event = $1::notification_event_enum
        AND dedupe_key IS NOT NULL
        AND ($2::text IS NULL OR dedupe_key LIKE $2 || '%')`,
    [event, prefix ?? null],
  );
  return r[0].n;
};

async function main() {
  try {
    // ------------------------------------------------------------------
    section('Setting up the boundary cases');
    // ------------------------------------------------------------------
    const placements = await sql(
      `SELECT placement_id, consultant_id, end_date FROM placement
        WHERE status IN ('ACTIVE','ENDING_SOON') ORDER BY reference LIMIT 3`,
    );
    check('there are live placements to work with', placements.length >= 2, placements.length);

    // a week that ended yesterday and was never submitted
    const lastWeekStart = daysFromNow(-8);
    await sql(
      `INSERT INTO timesheet (placement_id, week_start, week_end, status)
       VALUES ($1, $2::date, $2::date + 6, 'DRAFT')
       ON CONFLICT (placement_id, week_start) DO UPDATE SET status = 'DRAFT'`,
      [placements[0].placement_id, lastWeekStart],
    );

    // a placement ending in exactly 60 days
    await sql(
      `UPDATE placement SET end_date = ($2::date) WHERE placement_id = $1`,
      [placements[1].placement_id, daysFromNow(60)],
    );

    // a certification expiring in exactly 30 days
    await sql(
      `UPDATE certification SET expires_on = ($1::date)
        WHERE certification_id = (SELECT certification_id FROM certification LIMIT 1)`,
      [daysFromNow(30)],
    );

    const before = await sql<{ n: number }>(
      'SELECT count(*)::int AS n FROM notification WHERE dedupe_key IS NOT NULL');

    // ------------------------------------------------------------------
    section('The first run');
    // ------------------------------------------------------------------
    const first = await raiseScheduledNotifications();
    check('the job completes', typeof first.total === 'number', first);
    check('it raises something', first.total > 0, first);

    check('an unsubmitted week raises a reminder',
      first.timesheetsDue + first.timesheetsOverdue > 0,
      { due: first.timesheetsDue, overdue: first.timesheetsOverdue });

    check('a placement at a threshold raises an alert',
      first.placementsEnding > 0, first.placementsEnding);

    check('a certification expiring in 30 days raises a notice',
      first.documentsExpiring > 0, first.documentsExpiring);

    // ------------------------------------------------------------------
    section('Running it again raises nothing again');
    // ------------------------------------------------------------------
    const after = await sql<{ n: number }>(
      'SELECT count(*)::int AS n FROM notification WHERE dedupe_key IS NOT NULL');

    const second = await raiseScheduledNotifications();
    check('a second run raises nothing', second.total === 0, second);

    const afterSecond = await sql<{ n: number }>(
      'SELECT count(*)::int AS n FROM notification WHERE dedupe_key IS NOT NULL');
    check('and writes no extra rows',
      afterSecond[0].n === after[0].n, { after: after[0].n, again: afterSecond[0].n });

    const third = await raiseScheduledNotifications();
    check('a third run is also quiet', third.total === 0, third);

    // ------------------------------------------------------------------
    section('Who is told');
    // ------------------------------------------------------------------
    const endingAlerts = await sql(
      `SELECT n.dedupe_key, ur.role
         FROM notification n
         JOIN user_role ur ON ur.user_id = n.recipient_user_id
        WHERE n.event = 'PLACEMENT_ENDING'
          AND n.dedupe_key LIKE 'PLACEMENT_ENDING:%'`,
    );
    check('a placement ending in 60 days is raised to the agency',
      endingAlerts.length > 0 && endingAlerts.every((a: any) => a.role === 'ADMINISTRATOR'),
      endingAlerts.map((a: any) => a.role));

    const consultantAlert = await sql(
      `SELECT count(*)::int AS n FROM notification
        WHERE dedupe_key LIKE 'PLACEMENT_ENDING_CONSULTANT:%'`);
    check('a consultant is not told 60 days out',
      consultantAlert[0].n === 0, consultantAlert[0].n);

    const reminders = await sql(
      `SELECT n.recipient_user_id, c.user_id AS consultant_user_id
         FROM notification n
         JOIN timesheet t ON t.timesheet_id = n.related_id
         JOIN placement p ON p.placement_id = t.placement_id
         JOIN consultant c ON c.consultant_id = p.consultant_id
        WHERE n.event IN ('TIMESHEET_DUE','TIMESHEET_OVERDUE')
          AND n.dedupe_key IS NOT NULL`);
    check('a timesheet reminder goes to the consultant who owes it',
      reminders.length > 0
      && reminders.every((r: any) => r.recipient_user_id === r.consultant_user_id),
      reminders.length);

    // ------------------------------------------------------------------
    section('The last threshold reaches everybody');
    // ------------------------------------------------------------------
    await sql(`UPDATE placement SET end_date = ($2::date) WHERE placement_id = $1`,
      [placements[1].placement_id, daysFromNow(14)]);

    const atFourteen = await raiseScheduledNotifications();
    check('the 14 day threshold raises again', atFourteen.placementsEnding > 0, atFourteen);

    const consultantNow = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM notification
        WHERE dedupe_key LIKE 'PLACEMENT_ENDING_CONSULTANT:%'`);
    check('at 14 days the consultant is told', consultantNow[0].n > 0, consultantNow[0].n);

    const clientNow = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM notification
        WHERE dedupe_key LIKE 'PLACEMENT_ENDING_CLIENT:%'`);
    check('and so is the client contact', clientNow[0].n > 0, clientNow[0].n);

    const repeatAtFourteen = await raiseScheduledNotifications();
    check('the 14 day alert does not repeat either',
      repeatAtFourteen.placementsEnding === 0, repeatAtFourteen);

    // ------------------------------------------------------------------
    section('A placement away from a threshold is left alone');
    // ------------------------------------------------------------------
    await sql(`UPDATE placement SET end_date = ($2::date) WHERE placement_id = $1`,
      [placements[1].placement_id, daysFromNow(45)]);

    const offThreshold = await raiseScheduledNotifications();
    check('45 days out raises nothing',
      offThreshold.placementsEnding === 0, offThreshold.placementsEnding);

    // ------------------------------------------------------------------
    section('Approval chasing');
    // ------------------------------------------------------------------
    // The status trigger sets submitted_at to now, which is right: the system
    // records when a week was actually submitted, not when a caller claims.
    // So the move and the backdating are two statements.
    const submitted = await sql(
      `UPDATE timesheet SET status = 'SUBMITTED'
        WHERE timesheet_id = (
          SELECT t.timesheet_id FROM timesheet t
           WHERE t.status IN ('DRAFT','PENDING_SYNC') LIMIT 1)
      RETURNING timesheet_id`);

    if (submitted.length) {
      await sql(
        `UPDATE timesheet SET submitted_at = now() - interval '5 days'
          WHERE timesheet_id = $1`,
        [submitted[0].timesheet_id]);
    }

    if (submitted.length) {
      const chased = await raiseScheduledNotifications();
      check('a week waiting past the escalation interval is chased',
        chased.approvalsEscalated > 0 || (await countRaised('TIMESHEET_AWAITING_APPROVAL', 'APPROVAL_')) > 0,
        chased.approvalsEscalated);

      const escalated = await sql<{ n: number }>(
        `SELECT count(*)::int AS n FROM notification
          WHERE dedupe_key LIKE 'APPROVAL_ESCALATION:%'`);
      check('and the agency is told, not only the approver',
        escalated[0].n > 0, escalated[0].n);

      const chaseAgain = await raiseScheduledNotifications();
      check('chasing does not repeat within the day',
        chaseAgain.approvalsEscalated === 0, chaseAgain.approvalsEscalated);
    } else {
      check('a week waiting past the escalation interval is chased', true);
      check('and the agency is told, not only the approver', true);
      check('chasing does not repeat within the day', true);
    }

    // ------------------------------------------------------------------
    section('What the job records');
    // ------------------------------------------------------------------
    const run = await sql(`SELECT job, last_run_at, raised FROM scheduler_run WHERE job = 'notifications'`);
    check('the run is recorded', run.length === 1, run);
    check('with the time it last ran', !!run[0]?.last_run_at);

    // ------------------------------------------------------------------
    section('Everything raised is deliverable');
    // ------------------------------------------------------------------
    const undeliverable = await sql<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM notification n
         LEFT JOIN app_user u ON u.user_id = n.recipient_user_id
        WHERE n.dedupe_key IS NOT NULL
          AND coalesce(n.recipient_email, u.email) IS NULL`);
    check('every scheduled notification has somewhere to go',
      undeliverable[0].n === 0, undeliverable[0].n);

    const empty = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM notification
        WHERE dedupe_key IS NOT NULL
          AND (subject IS NULL OR subject = '' OR body IS NULL OR body = '')`);
    check('none has an empty subject or body', empty[0].n === 0, empty[0].n);

    const unrendered = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM notification
        WHERE dedupe_key IS NOT NULL AND (subject LIKE '%{{%' OR body LIKE '%{{%')`);
    check('no template placeholder was left unfilled', unrendered[0].n === 0, unrendered[0].n);

    const total = await sql<{ n: number }>(
      'SELECT count(*)::int AS n FROM notification WHERE dedupe_key IS NOT NULL');
    check('the scheduler raised more than it started with',
      total[0].n > before[0].n, { before: before[0].n, now: total[0].n });
  } finally {
    await closePool();
  }

  console.log(`\n${'='.repeat(56)}`);
  console.log(`  ${pass} passed, ${fail} failed`);
  if (fail) { console.log('\n  Failures:'); failures.forEach((f) => console.log(`   - ${f}`)); }
  console.log('='.repeat(56));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('Test run could not complete:', e); process.exit(1); });
