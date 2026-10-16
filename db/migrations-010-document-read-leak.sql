-- =====================================================================
-- Migration 010 — a recruiter could list restricted documents
--
-- p_document_read withholds vetting results and identity documents from
-- everybody but an administrator (BR-015). p_document_write was declared
-- FOR ALL USING (is_internal()).
--
-- A FOR ALL policy's USING clause applies to SELECT as well as to writes, and
-- permissive policies are OR'd together. So the write policy quietly granted
-- every recruiter sight of exactly the rows the read policy was written to
-- withhold. Nothing errored, and the metadata — that a vetting report exists,
-- its file name, when it was taken — was visible in the documents list.
--
-- Found by a test asserting a recruiter sees no restricted documents.
--
-- The download path was never affected: that check lives in the route and was
-- always applied. What leaked was the listing.
--
--   psql -U postgres -d rasibe -f migrations-010-document-read-leak.sql
-- =====================================================================

DROP POLICY IF EXISTS p_document_write ON document;

CREATE POLICY p_document_insert ON document FOR INSERT WITH CHECK (is_internal());

CREATE POLICY p_document_update ON document FOR UPDATE
  USING (is_admin() OR (NOT is_restricted AND is_internal()))
  WITH CHECK (is_admin() OR (NOT is_restricted AND is_internal()));

CREATE POLICY p_document_delete ON document FOR DELETE USING (is_admin());
