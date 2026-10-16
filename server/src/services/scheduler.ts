import type { PoolClient } from 'pg';
import { withActor } from '../lib/db.js';

/**
 * Raising notifications on a schedule.
 *
 * FR-TMS-013 and FR-PLC-008. Timesheet reminders and placement end-date alerts
 * had templates, recipients and a working delivery path, but nothing created
 * them: a consultant was never reminded and nobody was warned that a contract
 * was ending. Forgetting contract end dates was one of the three problems the
 * client named in the first interview, so this is not a convenience.
 *
 * This job decides *what* to raise. The dispatcher decides *when it is sent*.
 * Keeping them apart means a mail server being down delays delivery without
 * losing the reminder, and a scheduler running twice sends nothing twice.
 *
 * Every row carries a dedupe key naming the thing and the occasion, with a
 * unique index behind it. Running this hourly, or on two instances at once, is
 * therefore safe: the second attempt is refused by the database rather than
 * prevented by a check that could race.
 */

export interface ScheduleResult {
  timesheetsDue: number;
  timesheetsOverdue: number;
  approvalsEscalated: number;
  placementsEnding: number;
  documentsExpiring: number;
  total: number;
}

/** Reads a system setting, falling back when it is absent. */
async function setting(c: PoolClient, key: string, fallback: string): Promise<string> {
  const r = await c.query('SELECT setting_value FROM system_setting WHERE setting_key = $1', [key]);
  return r.rows[0]?.setting_value ?? fallback;
}

/**
 * Inserts a notification unless its key has been used.
 *
 * ON CONFLICT DO NOTHING is what makes the job repeatable. The alternative —
 * selecting first — leaves a window in which two runs both find nothing and
 * both insert.
 */
async function raise(
  c: PoolClient,
  args: {
    event: string;
    dedupeKey: string;
    recipientUserId?: string | null;
    recipientEmail?: string | null;
    subject: string;
    body: string;
    relatedTable?: string;
    relatedId?: string;
  },
): Promise<boolean> {
  const r = await c.query(
    `INSERT INTO notification (event, channel, recipient_user_id, recipient_email,
                               subject, body, related_table, related_id, dedupe_key)
     VALUES ($1::notification_event_enum,'EMAIL',$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING notification_id`,
    [
      args.event, args.recipientUserId ?? null, args.recipientEmail ?? null,
      args.subject, args.body, args.relatedTable ?? null, args.relatedId ?? null,
      args.dedupeKey,
    ],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Renders a template for an event, falling back to the text supplied. */
async function render(
  c: PoolClient,
  event: string,
  leadDays: number,
  vars: Record<string, string | number>,
  fallbackSubject: string,
  fallbackBody: string,
): Promise<{ subject: string; body: string }> {
  const t = await c.query(
    `SELECT subject, body FROM notification_template
      WHERE event = $1::notification_event_enum AND channel = 'EMAIL'
        AND lead_days = $2 AND is_active LIMIT 1`,
    [event, leadDays],
  );
  const fill = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_m, k) => String(vars[k] ?? ''));
  return t.rows[0]
    ? { subject: fill(t.rows[0].subject), body: fill(t.rows[0].body) }
    : { subject: fill(fallbackSubject), body: fill(fallbackBody) };
}

const SYSTEM = { userId: '00000000-0000-0000-0000-000000000000', role: 'ADMINISTRATOR' as const };

/**
 * Raises everything due.
 *
 * Runs as an administrator because it works across every consultant and client.
 * It writes notifications and nothing else: no business record is changed, so a
 * failure part way through leaves the system exactly as it was, minus some
 * reminders that the next run will raise.
 */
export async function raiseScheduledNotifications(): Promise<ScheduleResult> {
  const out: ScheduleResult = {
    timesheetsDue: 0, timesheetsOverdue: 0, approvalsEscalated: 0,
    placementsEnding: 0, documentsExpiring: 0, total: 0,
  };

  await withActor(SYSTEM, async (c) => {
    // ----------------------------------------------------------------
    // Timesheets not yet submitted for a week that has ended (FR-TMS-013)
    // ----------------------------------------------------------------
    const leadHours = Number(await setting(c, 'reminder_lead_hours', '48'));

    const dueWeeks = await c.query(
      `SELECT t.timesheet_id, t.week_start, t.week_end,
              con.user_id AS consultant_user_id, con.full_name AS consultant_name,
              cl.legal_name AS client_name
         FROM timesheet t
         JOIN placement p ON p.placement_id = t.placement_id
         JOIN consultant con ON con.consultant_id = p.consultant_id
         JOIN client_company cl ON cl.client_id = p.client_id
        WHERE t.status IN ('DRAFT','PENDING_SYNC','REJECTED')
          AND t.week_end < current_date
          AND con.user_id IS NOT NULL
          -- not yet so old that a reminder is pointless; those escalate instead
          AND t.week_end > current_date - 60`,
    );

    for (const w of dueWeeks.rows) {
      const daysLate = Math.floor(
        (Date.now() - new Date(w.week_end).getTime()) / 86_400_000,
      );
      const overdue = daysLate * 24 > leadHours;
      const event = overdue ? 'TIMESHEET_OVERDUE' : 'TIMESHEET_DUE';

      // one reminder per week per day: a consultant who has not submitted gets
      // told again tomorrow, but not four times today
      const key = `${event}:${w.timesheet_id}:${new Date().toISOString().slice(0, 10)}`;

      const { subject, body } = await render(c, event, 0, {
        name: w.consultant_name,
        week: String(w.week_start).slice(0, 10),
        due: String(w.week_end).slice(0, 10),
        client: w.client_name,
        days: daysLate,
      },
        overdue ? 'Timesheet overdue — {{week}}' : 'Your timesheet for {{week}} is due',
        overdue
          ? 'Hello {{name}}, your timesheet for the week of {{week}} at {{client}} is {{days}} days overdue.'
          : 'Hello {{name}}, your timesheet for the week of {{week}} at {{client}} has not been submitted.');

      if (await raise(c, {
        event, dedupeKey: key, recipientUserId: w.consultant_user_id,
        subject, body, relatedTable: 'timesheet', relatedId: w.timesheet_id,
      })) {
        if (overdue) out.timesheetsOverdue += 1; else out.timesheetsDue += 1;
      }
    }

    // ----------------------------------------------------------------
    // Weeks submitted and not approved, past the escalation interval
    // ----------------------------------------------------------------
    const escalateHours = Number(await setting(c, 'approval_escalation_hours', '72'));

    const stuck = await c.query(
      `SELECT t.timesheet_id, t.week_start, t.submitted_at,
              con.full_name AS consultant_name,
              cl.legal_name AS client_name,
              cc.user_id AS approver_user_id,
              (cc.first_name || ' ' || cc.last_name) AS approver_name
         FROM timesheet t
         JOIN placement p ON p.placement_id = t.placement_id
         JOIN consultant con ON con.consultant_id = p.consultant_id
         JOIN client_company cl ON cl.client_id = p.client_id
         LEFT JOIN client_contact cc ON cc.contact_id = p.approver_contact_id
        WHERE t.status = 'SUBMITTED'
          AND t.submitted_at < now() - ($1 || ' hours')::interval`,
      [String(escalateHours)],
    );

    // administrators are told, because at this point the agency has to chase
    const admins = await c.query(
      `SELECT u.user_id FROM app_user u
         JOIN user_role ur ON ur.user_id = u.user_id
        WHERE ur.role = 'ADMINISTRATOR' AND u.is_active`,
    );

    for (const s of stuck.rows) {
      const day = new Date().toISOString().slice(0, 10);

      // the approver is reminded first
      if (s.approver_user_id) {
        const { subject, body } = await render(c, 'TIMESHEET_AWAITING_APPROVAL', 0, {
          consultant: s.consultant_name,
          week: String(s.week_start).slice(0, 10),
          hours: '',
        },
          'Still waiting: {{consultant}} — {{week}}',
          'The timesheet for {{consultant}} for the week of {{week}} is still waiting for your approval.');

        if (await raise(c, {
          event: 'TIMESHEET_AWAITING_APPROVAL',
          dedupeKey: `APPROVAL_REMINDER:${s.timesheet_id}:${day}`,
          recipientUserId: s.approver_user_id,
          subject, body, relatedTable: 'timesheet', relatedId: s.timesheet_id,
        })) out.approvalsEscalated += 1;
      }

      // and the agency, so an unresponsive approver is visible rather than
      // quietly delaying an invoice
      for (const a of admins.rows) {
        await raise(c, {
          event: 'TIMESHEET_AWAITING_APPROVAL',
          dedupeKey: `APPROVAL_ESCALATION:${s.timesheet_id}:${a.user_id}:${day}`,
          recipientUserId: a.user_id,
          subject: `Approval overdue: ${s.consultant_name} at ${s.client_name}`,
          body: `The week of ${String(s.week_start).slice(0, 10)} for ${s.consultant_name} `
            + `has been waiting for ${s.approver_name ?? 'the client'} since `
            + `${new Date(s.submitted_at).toISOString().slice(0, 10)}. `
            + 'It cannot be invoiced until it is approved.',
          relatedTable: 'timesheet', relatedId: s.timesheet_id,
        });
      }
    }

    // ----------------------------------------------------------------
    // Placements ending (FR-PLC-008)
    // ----------------------------------------------------------------
    const thresholds = (await setting(c, 'placement_alert_days', '60,30,14'))
      .split(',')
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isFinite(v) && v > 0)
      .sort((a, b) => b - a);

    for (const days of thresholds) {
      const ending = await c.query(
        `SELECT p.placement_id, p.reference, p.end_date,
                con.full_name AS consultant_name, con.user_id AS consultant_user_id,
                cl.legal_name AS client_name,
                cc.user_id AS approver_user_id
           FROM placement p
           JOIN consultant con ON con.consultant_id = p.consultant_id
           JOIN client_company cl ON cl.client_id = p.client_id
           LEFT JOIN client_contact cc ON cc.contact_id = p.approver_contact_id
          WHERE p.status IN ('ACTIVE','ENDING_SOON')
            AND p.end_date = current_date + $1::int`,
        [days],
      );

      for (const e of ending.rows) {
        const vars = {
          consultant: e.consultant_name,
          client: e.client_name,
          end: String(e.end_date).slice(0, 10),
          reference: e.reference,
          days,
        };
        const { subject, body } = await render(c, 'PLACEMENT_ENDING', days, vars,
          `Placement ending in ${days} days — {{consultant}}`,
          '{{consultant}} at {{client}} ends on {{end}}. Renew or let it run to its end date.');

        // the agency decides whether to renew, so the agency is told
        for (const a of admins.rows) {
          if (await raise(c, {
            event: 'PLACEMENT_ENDING',
            dedupeKey: `PLACEMENT_ENDING:${e.placement_id}:${days}:${a.user_id}`,
            recipientUserId: a.user_id,
            subject, body,
            relatedTable: 'placement', relatedId: e.placement_id,
          })) out.placementsEnding += 1;
        }

        // at the last threshold the consultant and the client are told too,
        // because by then it affects what they do next
        if (days === thresholds[thresholds.length - 1]) {
          if (e.consultant_user_id) {
            await raise(c, {
              event: 'PLACEMENT_ENDING',
              dedupeKey: `PLACEMENT_ENDING_CONSULTANT:${e.placement_id}:${days}`,
              recipientUserId: e.consultant_user_id,
              subject: `Your placement at ${e.client_name} ends on ${String(e.end_date).slice(0, 10)}`,
              body: `Your placement at ${e.client_name} ends on ${String(e.end_date).slice(0, 10)}. `
                + 'Submit your final timesheet by the Monday after your last week.',
              relatedTable: 'placement', relatedId: e.placement_id,
            });
          }
          if (e.approver_user_id) {
            await raise(c, {
              event: 'PLACEMENT_ENDING',
              dedupeKey: `PLACEMENT_ENDING_CLIENT:${e.placement_id}:${days}`,
              recipientUserId: e.approver_user_id,
              subject: `${e.consultant_name} finishes on ${String(e.end_date).slice(0, 10)}`,
              body: `${e.consultant_name} finishes with you on ${String(e.end_date).slice(0, 10)}. `
                + 'Contact Rasibe if you would like to extend.',
              relatedTable: 'placement', relatedId: e.placement_id,
            });
          }
        }
      }
    }

    // ----------------------------------------------------------------
    // Certifications and documents expiring
    // ----------------------------------------------------------------
    const expiring = await c.query(
      `SELECT ce.certification_id, ce.name, ce.expires_on,
              con.full_name AS consultant_name, con.consultant_id
         FROM certification ce
         JOIN consultant con ON con.consultant_id = ce.consultant_id
        WHERE ce.expires_on IS NOT NULL
          AND ce.expires_on = current_date + 30
          AND con.is_active`,
    );

    for (const d of expiring.rows) {
      for (const a of admins.rows) {
        const { subject, body } = await render(c, 'DOCUMENT_EXPIRING', 30, {
          document: d.name,
          name: d.consultant_name,
          expires: String(d.expires_on).slice(0, 10),
        },
          'Expiring in 30 days — {{document}}',
          '{{document}} for {{name}} expires on {{expires}}.');

        if (await raise(c, {
          event: 'DOCUMENT_EXPIRING',
          dedupeKey: `CERT_EXPIRING:${d.certification_id}:${a.user_id}`,
          recipientUserId: a.user_id,
          subject, body,
          relatedTable: 'certification', relatedId: d.certification_id,
        })) out.documentsExpiring += 1;
      }
    }

    out.total = out.timesheetsDue + out.timesheetsOverdue + out.approvalsEscalated
      + out.placementsEnding + out.documentsExpiring;

    await c.query(
      `INSERT INTO scheduler_run (job, last_run_at, raised, detail)
       VALUES ('notifications', now(), $1, $2)
       ON CONFLICT (job) DO UPDATE
         SET last_run_at = now(), raised = $1, detail = $2`,
      [out.total, JSON.stringify(out)],
    );
  });

  return out;
}

let timer: NodeJS.Timeout | null = null;

/**
 * Starts the timer.
 *
 * Hourly by default. More often would not raise anything new, because every
 * reminder is keyed to a day or a threshold; less often risks missing a
 * threshold entirely if the process restarts at the wrong moment.
 */
export function startScheduler(): void {
  if (timer) return;
  if (process.env.NOTIFY_SCHEDULE === 'off') {
    console.log('[schedule] disabled by NOTIFY_SCHEDULE=off');
    return;
  }

  const minutes = Number(process.env.NOTIFY_SCHEDULE_MINUTES ?? 60);

  const run = () => {
    raiseScheduledNotifications()
      .then((r) => {
        if (r.total) {
          console.log(
            `[schedule] raised ${r.total}: due=${r.timesheetsDue} overdue=${r.timesheetsOverdue} `
            + `approvals=${r.approvalsEscalated} ending=${r.placementsEnding} docs=${r.documentsExpiring}`,
          );
        }
      })
      .catch((e) => console.warn('[schedule] run failed:', e?.message ?? e));
  };

  // once shortly after start, so a restart does not wait an hour to catch up
  setTimeout(run, 10_000).unref?.();

  timer = setInterval(run, minutes * 60_000);
  timer.unref?.();

  console.log(`[schedule] raising reminders every ${minutes} minutes`);
}

export function stopScheduler(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
