/**
 * Restores a backup into a new database and proves it is usable (RCP-16).
 *
 *   npm run restore -- <manifest.json> <new_database>
 *   npm run restore -- --verify-only <manifest.json> <database>
 *
 * The target must not exist. The dump is checked against its manifest before
 * anything is created, and afterwards every row count, every encrypted value
 * and every key fingerprint is checked against the keys in this environment.
 * Any mismatch exits non-zero. See docs/BACKUP.md.
 */
import { ownerConnectionFromEnv, restoreBackup, verifyRestore } from '../lib/backup.js';

async function main() {
  const args = process.argv.slice(2);
  const verifyOnly = args[0] === '--verify-only';
  const [manifestPath, database] = verifyOnly ? args.slice(1) : args;
  if (!manifestPath || !database) {
    throw new Error('Usage: npm run restore -- [--verify-only] <manifest.json> <database>');
  }

  const conn = ownerConnectionFromEnv();
  if (!verifyOnly) {
    await restoreBackup(conn, manifestPath, database);
    console.log(`Restored into ${database}.`);
  }

  const report = await verifyRestore(conn, manifestPath, database);
  console.log(
    `Checked ${report.checked.tables} tables, ${report.checked.encryptedValues} encrypted values, ` +
      `${report.checked.indexedValues} identity fingerprints.`,
  );
  if (!report.ok) {
    for (const problem of report.problems) console.error(`  - ${problem}`);
    throw new Error(`${database} is not usable with the keys in this environment.`);
  }
  console.log(`${database} matches its backup and is readable with these keys.`);
}

main().catch((err) => {
  console.error('Restore failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
