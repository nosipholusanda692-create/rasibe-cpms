/**
 * Sends whatever is waiting in the notification queue, once.
 *
 *   npm run notify:send
 *
 * The API runs the same function on a timer. This exists so the queue can be
 * drained by hand, or by a scheduled task if the API is not always running.
 */
import 'dotenv/config';
import { dispatchNotifications } from '../services/dispatcher.js';
import { mailConfigured } from '../services/mailer.js';
import { closePool } from '../lib/db.js';

const r = await dispatchNotifications();

console.log(`\nConsidered ${r.considered} notification(s)`);
console.log(`  sent    ${r.sent}`);
console.log(`  logged  ${r.logged}${r.logged ? ' (no mail server configured)' : ''}`);
console.log(`  failed  ${r.failed}${r.failed ? ' — will be retried' : ''}`);

if (!mailConfigured() && r.logged) {
  console.log('\nSet SMTP_HOST in server/.env to deliver these for real.');
}
console.log();

await closePool();
