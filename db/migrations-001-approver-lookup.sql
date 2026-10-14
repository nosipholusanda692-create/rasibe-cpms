-- Migration 001 — approver notification lookup
--
-- Apply to an existing rasibe database. Included in 02_security.sql for a
-- fresh build, so a rebuild does not need this file.
--
--   psql -U postgres -d rasibe -f migrations-001-approver-lookup.sql

CREATE OR REPLACE FUNCTION placement_approver_user(p_placement uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT cc.user_id
    FROM placement p
    JOIN client_contact cc ON cc.contact_id = p.approver_contact_id
   WHERE p.placement_id = p_placement
     AND cc.user_id IS NOT NULL
     AND cc.is_active;
$$;
