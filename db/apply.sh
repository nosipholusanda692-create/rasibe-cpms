#!/usr/bin/env bash
# Applies the database scripts in order. Usage: ./apply.sh [database]
set -euo pipefail
DB="${1:-rasibe}"
cd "$(dirname "$0")"
for f in 01_schema.sql 02_security.sql 03_triggers.sql 04_seed.sql; do
  echo "Applying $f"
  psql -d "$DB" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done
psql -d "$DB" -c "GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO rasibe_app;
                  GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO rasibe_app;
                  REVOKE UPDATE,DELETE ON audit_entry FROM rasibe_app;" >/dev/null
echo "Database $DB is ready."
