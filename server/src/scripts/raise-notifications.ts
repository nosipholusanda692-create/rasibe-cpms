/**
 * Raises every scheduled notification that is due, once.
 *
 *   npm run notify:raise
 *
 * The API runs the same function hourly. This exists so the job can be run by
 * hand, or by a scheduled task where the API is not always running.
 *
 * Safe to run repeatedly: each reminder carries a key, and a second attempt is
 * refused by the database rather than duplicated.
 */
import 'dotenv/config';
import { raiseScheduledNotifications } from '../services/scheduler.js';
import { closePool } from '../lib/db.js';

const r = await raiseScheduledNotifications();

console.log('\nRaised');
console.log(`  timesheets due        ${r.timesheetsDue}`);
console.log(`  timesheets overdue    ${r.timesheetsOverdue}`);
console.log(`  approvals chased      ${r.approvalsEscalated}`);
console.log(`  placements ending     ${r.placementsEnding}`);
console.log(`  documents expiring    ${r.documentsExpiring}`);
console.log(`  total                 ${r.total}`);
console.log('\nRun `npm run notify:send` to deliver them, or let the dispatcher do it.\n');

await closePool();
