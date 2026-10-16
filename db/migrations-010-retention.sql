-- =====================================================================
-- Migration 010 — retention of unplaced candidates, and anonymisation
--
-- NFR-PRI-004 / BR-021: an unplaced candidate is kept for the configured
--   period (setting candidate_retention_months, 12 by default) unless they
--   consent to longer.
-- NFR-PRI-005: a consultant's information can be anonymised on request.
--
-- retention_consent_until is the date a consultant has agreed we may keep
-- their record to, beyond the standard period. NULL means no such agreement.
-- Who recorded it, when and how consent was given is in the audit log.
--
-- The date a record falls due is always worked out from the current setting
-- (created_at + months, or the consent date if later), so changing the setting
-- applies to people already in the pool. The older retention_expires_on column
-- is left in place and is no longer what decides anything.
--
-- Apply to an existing database as the owner, for example in the Neon SQL
-- Editor or with:
--   psql -U postgres -d rasibe -f migrations-010-retention.sql
--
-- Safe to run twice. Also added to 01_schema.sql, so a rebuild needs nothing.
-- Run it BEFORE deploying the API that uses it.
-- =====================================================================

ALTER TYPE audit_action_enum ADD VALUE IF NOT EXISTS 'RETENTION_CONSENT_RECORDED';

ALTER TABLE consultant
  ADD COLUMN IF NOT EXISTS retention_consent_until date;

COMMENT ON COLUMN consultant.retention_consent_until IS
  'The date the consultant has agreed we may keep their record to, beyond the standard retention period. NULL if no agreement.';
