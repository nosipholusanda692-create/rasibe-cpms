-- =====================================================================
-- Migration 004 — idle session timeout
--
-- A session now ends after SESSION_IDLE_MINUTES without a request, as well as
-- at its absolute expiry. See docs/SESSIONS.md.
--
-- Apply to an existing database as the owner, for example in the Neon SQL
-- Editor. Safe to run twice. Also added to 01_schema.sql.
--
-- Existing sessions start their idle clock from the moment this runs.
-- =====================================================================

ALTER TABLE user_session
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now();
