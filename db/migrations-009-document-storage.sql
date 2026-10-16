-- =====================================================================
-- Migration 009 — storing the documents themselves
--
-- The document table has always held the metadata: type, version, expiry and
-- the restriction flag. Nothing held the file. A CV, a signed contract and a
-- vetting result are the actual documents, and none could be attached
-- (FR-DOC-001 to 004, 007).
--
-- Where the bytes live
-- --------------------
-- The architecture specifies object storage with a path reference, and the
-- storage_key column exists for exactly that. Two things argue for the
-- database being the default rather than a filesystem:
--
--   * The deployed instance runs on Azure App Service, whose filesystem is
--     replaced on every restart. Files written there are lost.
--   * A document stored in the database is covered by the existing row-level
--     security, is included in every backup, and is restored by the same
--     drill that proves the backup works.
--
-- So the bytes go in a table of their own, separate from the metadata, and the
-- storage layer in the API can address object storage instead when a
-- connection string is configured. storage_key names the backend and the
-- object: 'db:<uuid>' or 'azure:<container>/<blob>'.
--
--   psql -U postgres -d rasibe -f migrations-009-document-storage.sql
-- =====================================================================

-- ---------------------------------------------------------------------
-- The bytes
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS document_content (
  document_id uuid PRIMARY KEY REFERENCES document(document_id) ON DELETE CASCADE,
  bytes       bytea NOT NULL,
  -- Taken on upload and checked on download, so a file that has been altered
  -- in storage is detected rather than served.
  sha256      bytea NOT NULL,
  stored_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE document_content IS
  'Document bytes, kept apart from the metadata so a listing never reads them.';

-- The content is reached only through the document row, which carries the
-- policies. Enabling row-level security here with no permissive policy means a
-- direct read returns nothing, which is the intent: the API joins from
-- document, and that join is what decides access.
ALTER TABLE document_content ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_document_content ON document_content;
CREATE POLICY p_document_content ON document_content
  FOR ALL
  USING (document_id IN (SELECT d.document_id FROM document d))
  WITH CHECK (document_id IN (SELECT d.document_id FROM document d));

-- ---------------------------------------------------------------------
-- Versions
--
-- FR-DOC-004. A new CV does not overwrite the previous one: the old version is
-- kept and marked superseded, so what was sent to a client six months ago can
-- still be produced.
-- ---------------------------------------------------------------------
ALTER TABLE document
  ADD COLUMN IF NOT EXISTS superseded_by uuid REFERENCES document(document_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS sha256 bytea,
  ADD COLUMN IF NOT EXISTS original_name varchar(255);

CREATE INDEX IF NOT EXISTS ix_document_current
  ON document (consultant_id, doc_type)
  WHERE is_current;

COMMENT ON COLUMN document.superseded_by IS
  'The document that replaced this one. Null while current.';
COMMENT ON COLUMN document.is_current IS
  'False once a newer version of the same type exists for the same owner.';

-- ---------------------------------------------------------------------
-- Download tokens
--
-- NFR-SEC-009. A document is not served from a guessable address. A download
-- is a short-lived, single-purpose token bound to one document and one user,
-- so a link copied out of a browser history is useless a few minutes later and
-- useless to anybody else.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS document_token (
  token_hash  bytea PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES document(document_id) ON DELETE CASCADE,
  issued_to   uuid NOT NULL REFERENCES app_user(user_id) ON DELETE CASCADE,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  CONSTRAINT ck_token_window CHECK (expires_at > issued_at)
);

CREATE INDEX IF NOT EXISTS ix_document_token_live
  ON document_token (document_id) WHERE used_at IS NULL;

COMMENT ON TABLE document_token IS
  'Short-lived download permissions. The token itself is never stored, only its hash.';

ALTER TABLE document_token ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_document_token ON document_token;
CREATE POLICY p_document_token ON document_token
  FOR ALL USING (issued_to = actor_id()) WITH CHECK (issued_to = actor_id());

-- ---------------------------------------------------------------------
-- Redeeming a token
--
-- SECURITY DEFINER because the download runs for a caller whose session is
-- valid but who must not be able to read document_token directly. Marks the
-- token used and returns the document in one statement, so the same link
-- cannot be redeemed twice in a race.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION redeem_document_token(p_hash bytea, p_user uuid)
RETURNS TABLE (document_id uuid, file_name varchar, mime_type varchar, is_restricted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_doc uuid;
BEGIN
  UPDATE document_token t
     SET used_at = now()
   WHERE t.token_hash = p_hash
     AND t.issued_to = p_user
     AND t.used_at IS NULL
     AND t.expires_at > now()
  RETURNING t.document_id INTO v_doc;

  IF v_doc IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT d.document_id, d.file_name, d.mime_type, d.is_restricted
      FROM document d WHERE d.document_id = v_doc;
END $$;

/** The bytes, for a download that has already been authorised. */
CREATE OR REPLACE FUNCTION document_bytes(p_document uuid)
RETURNS TABLE (bytes bytea, sha256 bytea)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.bytes, c.sha256 FROM document_content c WHERE c.document_id = p_document;
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON document_content TO rasibe_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON document_token TO rasibe_app;
GRANT EXECUTE ON FUNCTION redeem_document_token(bytea, uuid) TO rasibe_app;
GRANT EXECUTE ON FUNCTION document_bytes(uuid) TO rasibe_app;

-- Document actions belong in the audit log: a vetting result being read is
-- exactly the kind of access that has to be accountable.
DO $$ BEGIN
  ALTER TYPE audit_action_enum ADD VALUE IF NOT EXISTS 'DOCUMENT_UPLOADED';
  ALTER TYPE audit_action_enum ADD VALUE IF NOT EXISTS 'DOCUMENT_DOWNLOADED';
  ALTER TYPE audit_action_enum ADD VALUE IF NOT EXISTS 'DOCUMENT_REMOVED';
END $$;
