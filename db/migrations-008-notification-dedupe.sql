-- =====================================================================
-- Migration 008 — raising notifications on a schedule, exactly once
--
-- The dispatcher delivers what is in the notification table. Nothing yet puts
-- the scheduled ones there: timesheet reminders (FR-TMS-013) and the 60, 30 and
-- 14 day placement alerts (FR-PLC-008) have templates, recipients and a working
-- delivery path, but no job raising them.
--
-- A scheduler runs repeatedly and must not raise the same reminder twice. The
-- obvious approach — "look for a similar row first" — races against itself and
-- against a second instance. A unique key is the only arrangement the database
-- can actually guarantee, so each scheduled notification computes a key that
-- names exactly what it is about, and a second attempt fails harmlessly.
--
--   psql -U postgres -d rasibe -f migrations-008-notification-dedupe.sql
-- =====================================================================

ALTER TABLE notification
  ADD COLUMN IF NOT EXISTS dedupe_key varchar(200);

-- Partial, so the thousands of notifications raised by ordinary business
-- actions carry no key and do not compete for the index.
CREATE UNIQUE INDEX IF NOT EXISTS ux_notification_dedupe
  ON notification (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

COMMENT ON COLUMN notification.dedupe_key IS
  'Set by the scheduler. Names the thing and the occasion, so the same reminder '
  'cannot be raised twice however often the job runs.';

-- When the scheduler last completed, so a restart does not re-examine work it
-- has already done and an operator can see whether it is running at all.
CREATE TABLE IF NOT EXISTS scheduler_run (
  job          varchar(60) PRIMARY KEY,
  last_run_at  timestamptz NOT NULL DEFAULT now(),
  raised       int NOT NULL DEFAULT 0,
  detail       text
);

COMMENT ON TABLE scheduler_run IS
  'One row per scheduled job. A job that has never run has no row.';

GRANT SELECT, INSERT, UPDATE ON scheduler_run TO rasibe_app;

-- The settings the jobs read already exist in system_setting:
--   reminder_lead_hours        first timesheet reminder before the due time
--   approval_escalation_hours  escalate an unapproved week to the administrator
--   placement_alert_days       60,30,14
--   timesheet_due_day          the day submission is expected
