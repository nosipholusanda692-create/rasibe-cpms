-- =====================================================================
-- Migration 008 — audit action for deactivating a consultant
--
-- FR-CON-013 asks for a consultant to be deactivated with a recorded reason.
-- The reason is stored in the audit log (NFR-SEC-011), which until now had an
-- action for deactivating a login (USER_DEACTIVATED) but none for removing a
-- consultant from the pool. They are different acts: one stops somebody
-- signing in, the other stops them being submitted to a client.
--
-- Apply to an existing database as the owner, for example in the Neon SQL
-- Editor or with:
--   psql -U postgres -d rasibe -f migrations-008-consultant-audit.sql
--
-- Safe to run twice. Also added to 01_schema.sql, so a rebuild needs nothing.
-- Run it BEFORE deploying the API that writes this action, or deactivating a
-- consultant will fail until it has been run.
-- =====================================================================

ALTER TYPE audit_action_enum ADD VALUE IF NOT EXISTS 'CONSULTANT_DEACTIVATED';
