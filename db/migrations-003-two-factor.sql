-- =====================================================================
-- Migration 003 — two-factor authentication
--
-- Time-based codes from an authenticator app (RFC 6238), with single-use
-- recovery codes for a lost phone. See docs/TWO-FACTOR.md.
--
-- Apply to an existing database as the owner, for example in the Neon SQL
-- Editor or with:
--   psql -U postgres -d rasibe -f migrations-003-two-factor.sql
--
-- Safe to run twice. Also added to 01_schema.sql, so a rebuild needs nothing.
-- =====================================================================

ALTER TYPE audit_action_enum ADD VALUE IF NOT EXISTS 'TWO_FACTOR_ENABLED';
ALTER TYPE audit_action_enum ADD VALUE IF NOT EXISTS 'TWO_FACTOR_DISABLED';
ALTER TYPE audit_action_enum ADD VALUE IF NOT EXISTS 'TWO_FACTOR_RESET';
ALTER TYPE audit_action_enum ADD VALUE IF NOT EXISTS 'RECOVERY_CODE_USED';

-- Both secrets are AES-256-GCM ciphertext written by the service.
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS totp_secret         text;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS totp_pending_secret text;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS totp_enabled_at     timestamptz;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS totp_last_step      bigint;

DO $$ BEGIN
  ALTER TABLE app_user ADD CONSTRAINT ck_user_totp
    CHECK ((totp_enabled_at IS NULL) = (totp_secret IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS login_challenge (
  challenge_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES app_user(user_id) ON DELETE CASCADE,
  token_hash   bytea NOT NULL UNIQUE,
  issued_at    timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  attempts     int NOT NULL DEFAULT 0,
  consumed_at  timestamptz,
  ip_address   varchar(64),
  CONSTRAINT ck_challenge_window CHECK (expires_at > issued_at)
);
CREATE INDEX IF NOT EXISTS ix_login_challenge_user ON login_challenge(user_id);

CREATE TABLE IF NOT EXISTS recovery_code (
  code_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES app_user(user_id) ON DELETE CASCADE,
  code_hash  bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at    timestamptz
);
CREATE INDEX IF NOT EXISTS ix_recovery_code_user ON recovery_code(user_id) WHERE used_at IS NULL;

-- The blanket grant in 02_security.sql ran before these tables existed.
GRANT SELECT, INSERT, UPDATE, DELETE ON login_challenge, recovery_code TO rasibe_app;
