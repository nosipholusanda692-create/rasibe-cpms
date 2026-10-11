/**
 * Takes a backup and applies the retention period (RCP-16, NFR-REL-003).
 *
 *   npm run backup
 *
 * Run it daily from the host's scheduler. It must run with the same
 * DATA_ENCRYPTION_KEY, DATA_INDEX_KEY and PASSWORD_PEPPER as the API, because
 * their fingerprints go into the manifest. The keys themselves do not, and
 * must be backed up somewhere else. See docs/BACKUP.md.
 */
import { ownerConnectionFromEnv, pruneBackups, runBackup } from '../lib/backup.js';

async function main() {
  const dir = process.env.BACKUP_DIR || 'backups';
  const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS || 30);
  if (!Number.isFinite(retentionDays) || retentionDays < 1) {
    throw new Error('BACKUP_RETENTION_DAYS must be a whole number of days, at least 1.');
  }

  const { dumpPath, manifestPath, manifest } = await runBackup(ownerConnectionFromEnv(), dir);
  const rows = Object.values(manifest.tables).reduce((a, b) => a + b, 0);
  console.log(`Backup written: ${dumpPath}`);
  console.log(`Manifest:       ${manifestPath}`);
  console.log(`${Object.keys(manifest.tables).length} tables, ${rows} rows, ${manifest.bytes} bytes.`);

  const removed = await pruneBackups(dir, retentionDays);
  console.log(
    removed.length
      ? `Removed past retention (${retentionDays} days): ${removed.join(', ')}`
      : `Nothing past retention (${retentionDays} days).`,
  );
}

main().catch((err) => {
  console.error('Backup failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
