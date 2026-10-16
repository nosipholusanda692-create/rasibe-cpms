import { pool } from '../lib/db.js';
import { sendMail, mailConfigured } from './mailer.js';

/**
 * Drains the notification queue.
 *
 * Notifications are written inside the business transaction that raises them,
 * so an approval is never lost because a mail server was unreachable
 * (FR-NOT-003). Something has to send them afterwards, and that is this.
 *
 * It runs on a timer inside the API, and can also be run once from the command
 * line. Both call the same function.
 */

const BATCH = 25;
const MAX_ATTEMPTS = 5;

export interface DispatchResult {
  considered: number;
  sent: number;
  logged: number;
  failed: number;
}

/**
 * Sends everything due.
 *
 * Rows are claimed with FOR UPDATE SKIP LOCKED, so two dispatchers — the timer
 * and a manual run, or two API instances — cannot send the same notification
 * twice. A row nobody can deliver is retried with a widening gap and given up
 * on after five attempts, rather than blocking the queue behind it.
 */
export async function dispatchNotifications(): Promise<DispatchResult> {
  const result: DispatchResult = { considered: 0, sent: 0, logged: 0, failed: 0 };
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const due = await client.query(
      `SELECT n.notification_id,
              coalesce(n.recipient_email, u.email) AS address,
              n.subject, n.body, n.attempts
         FROM notification n
         LEFT JOIN app_user u ON u.user_id = n.recipient_user_id
        WHERE n.sent_at IS NULL
          AND n.channel = 'EMAIL'
          AND n.scheduled_for <= now()
          AND n.attempts < $2
          AND (n.next_attempt_at IS NULL OR n.next_attempt_at <= now())
          AND coalesce(n.recipient_email, u.email) IS NOT NULL
        ORDER BY n.scheduled_for
        LIMIT $1
        FOR UPDATE OF n SKIP LOCKED`,
      [BATCH, MAX_ATTEMPTS],
    );

    result.considered = due.rows.length;

    for (const row of due.rows) {
      const { outcome, detail } = await sendMail({
        to: row.address,
        subject: row.subject,
        body: row.body,
      });

      if (outcome === 'failed') {
        result.failed += 1;
        const attempts = Number(row.attempts) + 1;
        // 1, 2, 4, 8 minutes: long enough to ride out a brief outage,
        // short enough that a reset link is still useful when it arrives
        const backoffMinutes = Math.min(2 ** (attempts - 1), 60);
        await client.query(
          `UPDATE notification
              SET attempts = $2,
                  next_attempt_at = now() + ($3 || ' minutes')::interval,
                  delivery_outcome = $4
            WHERE notification_id = $1`,
          [row.notification_id, attempts, String(backoffMinutes), detail.slice(0, 200)],
        );
        continue;
      }

      if (outcome === 'sent') result.sent += 1; else result.logged += 1;

      await client.query(
        `UPDATE notification
            SET sent_at = now(),
                attempts = attempts + 1,
                delivery_outcome = $2
          WHERE notification_id = $1`,
        [row.notification_id, outcome === 'sent' ? `sent: ${detail}`.slice(0, 200) : 'logged (no mail server configured)'],
      );
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  return result;
}

let timer: NodeJS.Timeout | null = null;

/**
 * Starts the timer.
 *
 * Deliberately not started during tests: a suite that sends real email would be
 * unpleasant, and the suites assert on the queue rather than on delivery.
 */
export function startDispatcher(): void {
  if (timer) return;
  if (process.env.NOTIFY_DISPATCH === 'off') {
    console.log('[notify] dispatcher disabled by NOTIFY_DISPATCH=off');
    return;
  }

  const seconds = Number(process.env.NOTIFY_INTERVAL_SECONDS ?? 60);

  timer = setInterval(() => {
    dispatchNotifications()
      .then((r) => {
        if (r.sent || r.failed) {
          console.log(`[notify] sent=${r.sent} failed=${r.failed} logged=${r.logged}`);
        }
      })
      .catch((e) => console.warn('[notify] dispatch failed:', e?.message ?? e));
  }, seconds * 1000);

  // the timer must not keep the process alive on its own
  timer.unref?.();

  console.log(
    mailConfigured()
      ? `[notify] dispatcher running every ${seconds}s via ${process.env.SMTP_HOST}`
      : `[notify] dispatcher running every ${seconds}s; no SMTP host, so notifications are logged`,
  );
}

export function stopDispatcher(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
