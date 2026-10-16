/**
 * Prepares a disposable copy of the hosted database for the test suites.
 * See docs/DEPLOY.md, "Running the suites against Neon".
 *
 *   npm run reset-demo-for-tests
 *
 * The suites sign in with the published demonstration password, which setup
 * replaced on the hosted database. This puts it back on every account, clears
 * lockouts, two-factor and open sessions, so the suites start from the state
 * they expect. Connects as rasibe_app (PGHOST, PGUSER, PGPASSWORD, PGSSLMODE)
 * with the hosted PASSWORD_PEPPER, because the API checks the hashes with it.
 *
 * Refuses the live database by its endpoint, and refuses unless NODE_ENV=test.
 */
import { anonQuery, closePool } from '../lib/db.js';
import { hashPassword } from '../lib/passwords.js';

// The live Neon endpoint (docs/DEPLOY.md). Its pooled host carries the same id.
const LIVE_ENDPOINTS = ['ep-morning-wave-ba31c64f'];
const PUBLISHED_PASSWORD = 'Password123!';

function refusal(): string | null {
  const host = (process.env.PGHOST ?? 'localhost').toLowerCase();
  if (process.env.NODE_ENV !== 'test') return 'NODE_ENV must be test.';
  if (LIVE_ENDPOINTS.some((id) => host.includes(id))) {
    return `${host} is the live database. Use the host of a test branch.`;
  }
  if (!process.env.PASSWORD_PEPPER) return 'PASSWORD_PEPPER is required (the hosted one).';
  return null;
}

async function main() {
  const problem = refusal();
  if (problem) throw new Error(`${problem} Nothing was changed.`);

  const hash = await hashPassword(PUBLISHED_PASSWORD);
  const users = await anonQuery(
    `UPDATE app_user
        SET password_hash = $1, failed_logins = 0, locked_until = NULL, is_active = true,
            totp_secret = NULL, totp_pending_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL
      RETURNING user_id`, [hash]);
  await anonQuery(`DELETE FROM recovery_code`);
  await anonQuery(`DELETE FROM login_challenge`);
  await anonQuery(`DELETE FROM login_attempt`);
  await anonQuery(`UPDATE user_session SET revoked_at = now() WHERE revoked_at IS NULL`);

  console.log(`Reset ${users.length} accounts on ${process.env.PGHOST} for the test suites.`);
  console.log('Delete this branch when the run is finished.');
}

main()
  .catch((err) => {
    console.error(`Reset failed: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
