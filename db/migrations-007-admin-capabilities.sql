-- =====================================================================
-- Migration 007 — the administrator's capability list
--
-- The server has always allowed an administrator to manage consultants,
-- clients, submissions, placements and reports: the capability map in
-- lib/errors.ts lists ADMINISTRATOR alongside RECRUITER for each.
--
-- The seeded role_capability rows never said so. The clients build their
-- buttons from that table, so an administrator was never shown the Edit,
-- Deactivate or Add controls, even though the API would have accepted the
-- request. The permission existed; the affordance did not.
--
-- An administrator can do anything a recruiter can, by definition of the role
-- in section 4.2 of the requirements.
--
--   psql -U postgres -d rasibe -f migrations-007-admin-capabilities.sql
-- =====================================================================

INSERT INTO role_capability (role, capability)
SELECT 'ADMINISTRATOR'::role_enum, c
  FROM (VALUES
    ('manage_consultants'),
    ('manage_clients'),
    ('submit_candidate'),
    ('create_placement'),
    ('review_candidates'),
    ('raise_request'),
    ('approve_timesheet'),
    ('view_reports'),
    ('manage_own_profile')
  ) AS v(c)
 WHERE NOT EXISTS (
   SELECT 1 FROM role_capability rc
    WHERE rc.role = 'ADMINISTRATOR' AND rc.capability = v.c
 );

-- A recruiter reviews candidates and raises a request on a client's behalf,
-- both of which the server already permits.
INSERT INTO role_capability (role, capability)
SELECT 'RECRUITER'::role_enum, c
  FROM (VALUES ('review_candidates'), ('raise_request'), ('manage_own_profile')) AS v(c)
 WHERE NOT EXISTS (
   SELECT 1 FROM role_capability rc
    WHERE rc.role = 'RECRUITER' AND rc.capability = v.c
 );
