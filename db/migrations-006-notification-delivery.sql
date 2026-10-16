-- =====================================================================
-- Migration 006 — notification delivery
--
-- Notifications were written and never sent. The dispatcher needs somewhere to
-- record how many times it has tried and when to try again, so a message that
-- cannot be delivered is retried with a widening gap rather than either
-- vanishing or blocking the queue behind it.
--
--   psql -U postgres -d rasibe -f migrations-006-notification-delivery.sql
-- =====================================================================

ALTER TABLE notification
  ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;

-- The dispatcher's query: unsent, due, not exhausted.
CREATE INDEX IF NOT EXISTS ix_notification_due
  ON notification (scheduled_for)
  WHERE sent_at IS NULL;

COMMENT ON COLUMN notification.attempts IS
  'Delivery attempts made. Abandoned after five.';
COMMENT ON COLUMN notification.next_attempt_at IS
  'Earliest retry after a failure. Backs off 1, 2, 4, 8 minutes.';
