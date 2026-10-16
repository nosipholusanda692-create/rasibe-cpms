/**
 * Checks the mail configuration without sending anything to a real person.
 *
 *   npm run mail:verify
 *   npm run mail:verify -- you@example.com     (also sends one test message)
 */
import 'dotenv/config';
import { verifyMail, sendMail, mailConfigured } from '../services/mailer.js';

const to = process.argv[2];

console.log('\nMail configuration');
console.log(`  SMTP_HOST   ${process.env.SMTP_HOST || '(not set)'}`);
console.log(`  SMTP_PORT   ${process.env.SMTP_PORT || '587 (default)'}`);
console.log(`  SMTP_USER   ${process.env.SMTP_USER || '(not set)'}`);
console.log(`  SMTP_PASSWORD ${process.env.SMTP_PASSWORD ? '(set)' : '(not set)'}`);
console.log(`  MAIL_FROM   ${process.env.MAIL_FROM || 'no-reply@rasibe.co.za (default)'}`);

if (!mailConfigured()) {
  console.log('\nNo SMTP_HOST is set, so notifications are written to the database and logged');
  console.log('rather than delivered. That is the documented development behaviour.\n');
  process.exit(0);
}

const check = await verifyMail();
console.log(`\nConnection: ${check.ok ? 'ok' : 'failed'}`);
console.log(`  ${check.detail}\n`);

if (!check.ok) {
  console.log('Common causes:');
  console.log('  - Gmail needs an app password, not your account password');
  console.log('  - a corporate network or firewall blocking port 587');
  console.log('  - SMTP_USER not matching the address in MAIL_FROM\n');
  process.exit(1);
}

if (to) {
  console.log(`Sending a test message to ${to} …`);
  const r = await sendMail({
    to,
    subject: 'Rasibe — mail configuration test',
    body: 'This is a test from the Rasibe placement system.\n\n'
      + 'If you are reading it, notifications will reach their recipients: '
      + 'timesheet reminders, approval requests, invitations and password reset links.',
  });
  console.log(`  ${r.outcome}: ${r.detail}\n`);
  process.exit(r.outcome === 'sent' ? 0 : 1);
}

console.log('Pass an address to send a test message:');
console.log('  npm run mail:verify -- you@example.com\n');
