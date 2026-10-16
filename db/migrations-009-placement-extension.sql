-- =====================================================================
-- Migration 009 — extending a placement
--
-- FR-PLC-006: a placement may be extended, recording the revised end date and
-- retaining the original.
--
-- An extension moves end_date on the same placement. It is not a new
-- placement and it does not use the RENEWED status: RENEWED is not a live
-- status, so timesheets would stop the moment somebody extended (BR-002).
-- The date the placement first ran to is kept in original_end_date, set once,
-- on the first extension. Each extension, with who made it, when and why, is
-- written to the audit log (NFR-SEC-011), which is where the full history is.
--
-- Apply to an existing database as the owner, for example in the Neon SQL
-- Editor or with:
--   psql -U postgres -d rasibe -f migrations-009-placement-extension.sql
--
-- Safe to run twice. Also added to 01_schema.sql, so a rebuild needs nothing.
-- Run it BEFORE deploying the API that writes this action, or extending a
-- placement will fail until it has been run.
-- =====================================================================

ALTER TYPE audit_action_enum ADD VALUE IF NOT EXISTS 'PLACEMENT_EXTENDED';

ALTER TABLE placement
  ADD COLUMN IF NOT EXISTS original_end_date date,
  ADD COLUMN IF NOT EXISTS extension_count int NOT NULL DEFAULT 0;

COMMENT ON COLUMN placement.original_end_date IS
  'The end date before the first extension. NULL if never extended.';
COMMENT ON COLUMN placement.extension_count IS
  'How many times the end date has been extended. The history is in audit_entry.';
