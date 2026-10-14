-- =====================================================================
-- Migration 002 — account tokens
--
-- Realises FR-AUT-001, FR-AUT-005, FR-AUT-010, FR-AUT-013.
--
-- Until now accounts existed only because 04_seed.sql created them. There was
-- no way for an administrator to add a seventh person, and no way for anyone to
-- recover a forgotten password. This adds the single-use, time-limited token
-- both of those need.
--
-- Apply to an existing database:
--   psql -U postgres -d rasibe -f migrations-002-account-tokens.sql
--
-- Also added to 01_schema.sql and 02_security.sql, so a rebuild needs nothing.
-- =====================================================================

DO $$ BEGIN
  CREATE TYPE account_token_purpose_enum AS ENUM ('INVITE', 'RESET');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS account_token (
  token_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES app_user(user_id) ON DELETE CASCADE,
  purpose     account_token_purpose_enum NOT NULL,

  -- The token itself is never stored. What is held is a SHA-256 of it, so a
  -- reader of this table cannot sign in as anybody: the same reasoning that
  -- keeps password_hash out of reach. The plain value exists only in the
  -- notification sent to the person.
  token_hash  bytea NOT NULL UNIQUE,

  issued_by   uuid REFERENCES app_user(user_id) ON DELETE SET NULL,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  ip_address  varchar(64),

  CONSTRAINT ck_token_window CHECK (expires_at > issued_at)
);

-- The lookup is always "this hash, not yet used, not yet expired".
CREATE INDEX IF NOT EXISTS ix_account_token_live
  ON account_token (token_hash)
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_account_token_user
  ON account_token (user_id, purpose);

-- Row-level security: nobody reaches this table through the ordinary API
-- surface. Both flows run before a session exists, so they go through the
-- SECURITY DEFINER functions below rather than through a policy.
ALTER TABLE account_token ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_account_token_admin ON account_token;
CREATE POLICY p_account_token_admin ON account_token
  FOR SELECT USING (is_admin());

-- ---------------------------------------------------------------------
-- Issuing and redeeming
--
-- SECURITY DEFINER because both run for a caller who is either not signed in
-- at all (accepting an invitation, resetting a password) or who must not be
-- able to read the table directly. Each function does one narrow thing and
-- returns only what the caller needs.
-- ---------------------------------------------------------------------

/** Records a token for a user and returns its id. The caller holds the plain value. */
CREATE OR REPLACE FUNCTION issue_account_token(
  p_user      uuid,
  p_purpose   account_token_purpose_enum,
  p_hash      bytea,
  p_hours     int,
  p_issued_by uuid,
  p_ip        varchar
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  -- An outstanding token of the same purpose is retired, so a reissued
  -- invitation makes the previous link stop working.
  UPDATE account_token
     SET consumed_at = now()
   WHERE user_id = p_user
     AND purpose = p_purpose
     AND consumed_at IS NULL;

  INSERT INTO account_token (user_id, purpose, token_hash, expires_at, issued_by, ip_address)
  VALUES (p_user, p_purpose, p_hash, now() + (p_hours * interval '1 hour'), p_issued_by, p_ip)
  RETURNING token_id INTO v_id;

  RETURN v_id;
END $$;

/**
 * Redeems a token and sets the password in one statement.
 *
 * Done together deliberately: a separate "check" and "use" would leave a window
 * in which the same link could be redeemed twice. Returns the user id on
 * success and NULL when the token is unknown, already used or expired, so the
 * caller cannot tell which.
 */
CREATE OR REPLACE FUNCTION redeem_account_token(
  p_hash     bytea,
  p_purpose  account_token_purpose_enum,
  p_password varchar
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user uuid;
BEGIN
  UPDATE account_token
     SET consumed_at = now()
   WHERE token_hash = p_hash
     AND purpose = p_purpose
     AND consumed_at IS NULL
     AND expires_at > now()
  RETURNING user_id INTO v_user;

  IF v_user IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE app_user
     SET password_hash = p_password,
         is_active = true,
         failed_logins = 0,
         locked_until = NULL
   WHERE user_id = v_user;

  -- Setting a password ends every other session, because the most likely
  -- reason for a reset is that somebody else has the old one.
  UPDATE user_session
     SET revoked_at = now()
   WHERE user_id = v_user
     AND revoked_at IS NULL;

  RETURN v_user;
END $$;

/**
 * The account an invitation or reset is for, by token.
 *
 * Returns the name and email so the set-password page can greet the person,
 * and nothing else. Never reveals whether an address has an account: the
 * caller already holds a token that only the account holder received.
 */
CREATE OR REPLACE FUNCTION account_token_subject(
  p_hash    bytea,
  p_purpose account_token_purpose_enum
) RETURNS TABLE (full_name varchar, email varchar)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.full_name, u.email
    FROM account_token t
    JOIN app_user u ON u.user_id = t.user_id
   WHERE t.token_hash = p_hash
     AND t.purpose = p_purpose
     AND t.consumed_at IS NULL
     AND t.expires_at > now();
$$;

/**
 * Finds the account for a password reset request.
 *
 * SECURITY DEFINER because the request arrives with no session. Returns at most
 * one row; the route answers identically whether or not it found anything, so
 * the form cannot be used to discover which addresses are registered.
 */
CREATE OR REPLACE FUNCTION account_for_reset(p_email varchar)
RETURNS TABLE (user_id uuid, full_name varchar, email varchar)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.user_id, u.full_name, u.email
    FROM app_user u
   WHERE lower(u.email) = lower(p_email)
     AND u.is_active;
$$;

GRANT EXECUTE ON FUNCTION issue_account_token(uuid, account_token_purpose_enum, bytea, int, uuid, varchar) TO rasibe_app;
GRANT EXECUTE ON FUNCTION redeem_account_token(bytea, account_token_purpose_enum, varchar) TO rasibe_app;
GRANT EXECUTE ON FUNCTION account_token_subject(bytea, account_token_purpose_enum) TO rasibe_app;
GRANT EXECUTE ON FUNCTION account_for_reset(varchar) TO rasibe_app;
GRANT SELECT, INSERT, UPDATE ON account_token TO rasibe_app;

-- New audit actions raised by the user-management routes.
DO $$ BEGIN
  ALTER TYPE audit_action_enum ADD VALUE IF NOT EXISTS 'USER_CREATED';
  ALTER TYPE audit_action_enum ADD VALUE IF NOT EXISTS 'USER_INVITED';
  ALTER TYPE audit_action_enum ADD VALUE IF NOT EXISTS 'USER_REINSTATED';
  ALTER TYPE audit_action_enum ADD VALUE IF NOT EXISTS 'USER_ROLE_CHANGED';
  ALTER TYPE audit_action_enum ADD VALUE IF NOT EXISTS 'PASSWORD_RESET_REQUESTED';
  ALTER TYPE audit_action_enum ADD VALUE IF NOT EXISTS 'PASSWORD_SET';
END $$;
