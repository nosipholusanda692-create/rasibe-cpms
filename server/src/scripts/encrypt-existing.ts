/**
 * Backfills encryption over rows written before RCP-08 (NFR-SEC-005).
 *
 * There is no migration framework here: the database is built by applying
 * db/01 through db/04 in order. Those files cannot encrypt anything, because
 * the key lives in this process and never reaches PostgreSQL. So the seeded
 * rows arrive in clear and this turns them over afterwards.
 *
 * Safe to run repeatedly. A value that already carries the version prefix is
 * left alone, so a second run touches nothing and reports zero.
 *
 * Run it after applying the schema, and once after deploying this change to an
 * environment that already holds data.
 */
import { anonQuery, withActor, closePool, type Actor } from '../lib/db.js';
import { encrypt, blindIndex, isEncrypted } from '../lib/crypto.js';

const ENCRYPTED_COLUMNS = ['id_number', 'bank_name', 'bank_account_ref', 'vetting_status'] as const;

interface ConsultantRow {
  consultant_id: string;
  id_number: string | null;
  bank_name: string | null;
  bank_account_ref: string | null;
  vetting_status: string | null;
}

async function main() {
  // Row-level security applies to this connection like any other, so the work
  // needs an internal actor to see the pool at all. Nothing is being decided on
  // this identity's behalf; it is there to satisfy the policy.
  const admins = await anonQuery<{ user_id: string }>(
    `SELECT u.user_id
       FROM app_user u
       JOIN user_role r ON r.user_id = u.user_id
      WHERE r.role = 'ADMINISTRATOR' AND u.is_active
      LIMIT 1`,
  );
  if (!admins.length) throw new Error('No active administrator found to run the backfill as.');
  const actor: Actor = { userId: admins[0].user_id, role: 'ADMINISTRATOR' };

  const updated = await withActor(actor, async (c) => {
    const { rows } = await c.query<ConsultantRow>(
      `SELECT consultant_id, ${ENCRYPTED_COLUMNS.join(', ')} FROM consultant`,
    );

    let count = 0;
    for (const row of rows) {
      const pending = ENCRYPTED_COLUMNS.filter(
        (col) => row[col] !== null && !isEncrypted(row[col]),
      );
      // The index is derived from the identity number, so it is rebuilt
      // whenever that column is touched and ignored otherwise.
      if (!pending.length) continue;

      const sets: string[] = [];
      const params: unknown[] = [row.consultant_id];
      for (const col of pending) {
        params.push(encrypt(row[col]));
        sets.push(`${col} = $${params.length}`);
      }
      if (pending.includes('id_number')) {
        params.push(blindIndex(row.id_number));
        sets.push(`id_number_bidx = $${params.length}`);
      }

      await c.query(
        `UPDATE consultant SET ${sets.join(', ')} WHERE consultant_id = $1`,
        params,
      );
      count += 1;
    }
    return count;
  });

  console.log(
    updated === 0
      ? 'Nothing to do: every restricted value is already encrypted.'
      : `Encrypted restricted values on ${updated} consultant ${updated === 1 ? 'row' : 'rows'}.`,
  );
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error('Backfill failed:', err instanceof Error ? err.message : err);
    await closePool();
    process.exit(1);
  });
