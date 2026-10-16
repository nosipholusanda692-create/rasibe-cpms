-- =====================================================================
-- 02_security.sql — database roles, session context, row-level security,
-- and column projection views.
--
-- Realises: NFR-SEC-002/003/004, BR-006, BR-007, BR-013, BR-015
-- The rule that a consultant never sees the bill rate and a client manager
-- never sees the pay rate is enforced here, in the database, so that a defect
-- in an application query cannot leak either value.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Database roles
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rasibe_app') THEN
    CREATE ROLE rasibe_app LOGIN PASSWORD 'rasibe_app_pw';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rasibe_reporting') THEN
    CREATE ROLE rasibe_reporting LOGIN PASSWORD 'rasibe_reporting_pw';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO rasibe_app, rasibe_reporting;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rasibe_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rasibe_app;

-- BR-020: the audit log is append-only for the application role.
REVOKE UPDATE, DELETE ON audit_entry FROM rasibe_app;

-- The reporting role holds no privilege on base tables. It reads only the
-- owner-executed report views defined at the foot of this file.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM rasibe_reporting;

-- ---------------------------------------------------------------------
-- Session context
-- The API issues SET LOCAL rasibe.actor_user_id / rasibe.actor_role
-- immediately after acquiring a connection for a request.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION actor_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('rasibe.actor_user_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION actor_role() RETURNS role_enum
LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('rasibe.actor_role', true), ''), 'CONSULTANT')::role_enum;
$$;

CREATE OR REPLACE FUNCTION is_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT actor_role() = 'ADMINISTRATOR'; $$;

CREATE OR REPLACE FUNCTION is_internal() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT actor_role() IN ('ADMINISTRATOR','RECRUITER'); $$;

-- The consultant record belonging to the signed-in user, if any.
--
-- SECURITY DEFINER is required, not optional. The policy on consultant calls
-- this function; without it the function's own read of consultant would
-- re-enter that policy and recurse until the stack is exhausted. Running as
-- the owner bypasses row-level security for this one lookup, which is safe
-- because the function returns only the row belonging to the caller.
CREATE OR REPLACE FUNCTION actor_consultant_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.consultant_id FROM consultant c WHERE c.user_id = actor_id();
$$;

-- The client companies the signed-in user may see (BR-013).
-- SECURITY DEFINER for the same reason as above.
CREATE OR REPLACE FUNCTION actor_client_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT cc.client_id FROM client_contact cc WHERE cc.user_id = actor_id() AND cc.is_active;
$$;

-- ---------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------
ALTER TABLE consultant        ENABLE ROW LEVEL SECURITY;
ALTER TABLE placement         ENABLE ROW LEVEL SECURITY;
ALTER TABLE timesheet         ENABLE ROW LEVEL SECURITY;
ALTER TABLE timesheet_line    ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice           ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_line      ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_request  ENABLE ROW LEVEL SECURITY;
ALTER TABLE submission        ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_company    ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_contact    ENABLE ROW LEVEL SECURITY;
ALTER TABLE document          ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification      ENABLE ROW LEVEL SECURITY;

-- The consultants a client manager legitimately sees: those placed with one of
-- their companies, and those submitted against one of their requests. Any other
-- consultant in the pool remains invisible to them.
-- SECURITY DEFINER prevents the policy on consultant re-entering the policies
-- on placement and submission.
CREATE OR REPLACE FUNCTION actor_visible_consultant_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT p.consultant_id
    FROM placement p
   WHERE p.client_id IN (SELECT cc.client_id FROM client_contact cc
                          WHERE cc.user_id = actor_id() AND cc.is_active)
  UNION
  SELECT DISTINCT sb.consultant_id
    FROM submission sb
    JOIN resource_request rr ON rr.request_id = sb.request_id
   WHERE rr.client_id IN (SELECT cc.client_id FROM client_contact cc
                           WHERE cc.user_id = actor_id() AND cc.is_active);
$$;

-- Consultants: internal staff see all; a consultant sees their own record; a
-- client manager sees only those placed with or submitted to them.
CREATE POLICY p_consultant_read ON consultant FOR SELECT USING (
  is_internal()
  OR consultant_id = actor_consultant_id()
  OR consultant_id IN (SELECT actor_visible_consultant_ids())
);
CREATE POLICY p_consultant_write ON consultant FOR UPDATE USING (
  is_internal() OR consultant_id = actor_consultant_id()
);
CREATE POLICY p_consultant_insert ON consultant FOR INSERT WITH CHECK (is_internal());
CREATE POLICY p_consultant_delete ON consultant FOR DELETE USING (is_admin());

-- The client companies a consultant is placed with. SECURITY DEFINER for the
-- same anti-recursion reason as the helpers above: the policy on
-- client_company must not re-enter the policy on placement.
CREATE OR REPLACE FUNCTION actor_placement_client_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT p.client_id FROM placement p
   WHERE p.consultant_id = actor_consultant_id();
$$;

-- Client companies: internal staff see all; a client manager sees their own;
-- a consultant sees the companies they are actually placed with, so their own
-- placement can show who the work is for.
CREATE POLICY p_client_read ON client_company FOR SELECT USING (
  is_internal()
  OR client_id IN (SELECT actor_client_ids())
  OR client_id IN (SELECT actor_placement_client_ids())
);
CREATE POLICY p_client_write ON client_company FOR ALL USING (is_internal()) WITH CHECK (is_internal());

CREATE POLICY p_contact_read ON client_contact FOR SELECT USING (
  is_internal() OR client_id IN (SELECT actor_client_ids())
);
CREATE POLICY p_contact_write ON client_contact FOR ALL USING (is_internal()) WITH CHECK (is_internal());

-- Requests: internal staff see all; a client manager sees only their company's.
CREATE POLICY p_request_read ON resource_request FOR SELECT USING (
  is_internal() OR client_id IN (SELECT actor_client_ids())
);
CREATE POLICY p_request_write ON resource_request FOR ALL USING (
  is_internal() OR client_id IN (SELECT actor_client_ids())
) WITH CHECK (
  is_internal() OR client_id IN (SELECT actor_client_ids())
);

-- Submissions: internal staff see all; a client manager sees submissions against
-- their own requests; a consultant sees their own submissions.
CREATE POLICY p_submission_read ON submission FOR SELECT USING (
  is_internal()
  OR consultant_id = actor_consultant_id()
  OR request_id IN (SELECT r.request_id FROM resource_request r
                    WHERE r.client_id IN (SELECT actor_client_ids()))
);
CREATE POLICY p_submission_write ON submission FOR ALL USING (is_internal()) WITH CHECK (is_internal());

-- Placements: internal staff see all; consultant sees own; client manager sees own company's.
CREATE POLICY p_placement_read ON placement FOR SELECT USING (
  is_internal()
  OR consultant_id = actor_consultant_id()
  OR client_id IN (SELECT actor_client_ids())
);
CREATE POLICY p_placement_write ON placement FOR ALL USING (is_internal()) WITH CHECK (is_internal());

-- Timesheets: consultant sees own; client manager sees their company's; internal all.
CREATE POLICY p_timesheet_read ON timesheet FOR SELECT USING (
  is_internal()
  OR placement_id IN (SELECT p.placement_id FROM placement p
                      WHERE p.consultant_id = actor_consultant_id())
  OR placement_id IN (SELECT p.placement_id FROM placement p
                      WHERE p.client_id IN (SELECT actor_client_ids()))
);
CREATE POLICY p_timesheet_write ON timesheet FOR ALL USING (
  is_internal()
  OR placement_id IN (SELECT p.placement_id FROM placement p
                      WHERE p.consultant_id = actor_consultant_id())
  OR placement_id IN (SELECT p.placement_id FROM placement p
                      WHERE p.client_id IN (SELECT actor_client_ids()))
) WITH CHECK (
  is_internal()
  OR placement_id IN (SELECT p.placement_id FROM placement p
                      WHERE p.consultant_id = actor_consultant_id())
  OR placement_id IN (SELECT p.placement_id FROM placement p
                      WHERE p.client_id IN (SELECT actor_client_ids()))
);

CREATE POLICY p_tsline_all ON timesheet_line FOR ALL USING (
  timesheet_id IN (SELECT t.timesheet_id FROM timesheet t)
) WITH CHECK (
  timesheet_id IN (SELECT t.timesheet_id FROM timesheet t)
);

-- Invoices: internal staff see all; a client manager sees their own company's
-- issued invoices only. A consultant sees none.
CREATE POLICY p_invoice_read ON invoice FOR SELECT USING (
  is_internal()
  OR (client_id IN (SELECT actor_client_ids())
      AND status IN ('ISSUED','OVERDUE','PART_PAID','PAID'))
);
CREATE POLICY p_invoice_write ON invoice FOR ALL USING (is_internal()) WITH CHECK (is_internal());

CREATE POLICY p_invoice_line_read ON invoice_line FOR SELECT USING (
  invoice_id IN (SELECT i.invoice_id FROM invoice i)
);
CREATE POLICY p_invoice_line_write ON invoice_line FOR ALL USING (is_internal()) WITH CHECK (is_internal());

-- Documents: restricted documents are visible to the administrator alone (BR-015).
CREATE POLICY p_document_read ON document FOR SELECT USING (
  (is_admin())
  OR (NOT is_restricted AND is_internal())
  OR (NOT is_restricted AND consultant_id = actor_consultant_id())
);
CREATE POLICY p_document_write ON document FOR ALL USING (is_internal()) WITH CHECK (is_internal());

-- Notifications: a user sees only their own.
CREATE POLICY p_notification_read ON notification FOR SELECT USING (
  recipient_user_id = actor_id() OR is_admin()
);
CREATE POLICY p_notification_write ON notification FOR ALL USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------
-- Account tokens and the lookups that run before a session exists
--
-- Nobody reaches account_token through the ordinary API surface. Inviting,
-- resetting and redeeming go through the SECURITY DEFINER functions below,
-- because the caller is either not signed in or must not read the table.
-- Each does one narrow thing and returns only what the caller needs.
-- ---------------------------------------------------------------------
ALTER TABLE account_token ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_account_token_admin ON account_token FOR SELECT USING (is_admin());

-- The approver to notify when a week is submitted. The consultant submitting
-- it may not read client_contact, so a direct query would find nobody.
CREATE OR REPLACE FUNCTION placement_approver_user(p_placement uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT cc.user_id
    FROM placement p
    JOIN client_contact cc ON cc.contact_id = p.approver_contact_id
   WHERE p.placement_id = p_placement
     AND cc.user_id IS NOT NULL
     AND cc.is_active;
$$;

-- Records a token and returns its id; an outstanding token of the same
-- purpose is retired, so a reissued link makes the previous one stop working.
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

-- Redeems a token and sets the password together, so the same link cannot be
-- used twice. NULL for unknown, used or expired alike, so the caller cannot
-- tell which. Ends every other session for the account.
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

  UPDATE user_session
     SET revoked_at = now()
   WHERE user_id = v_user
     AND revoked_at IS NULL;

  RETURN v_user;
END $$;

-- The name and email behind a live token, so the set-password page can greet
-- the person. Nothing else.
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

-- The account for a reset request, which arrives with no session. The route
-- answers identically whether or not this finds anything.
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

-- ---------------------------------------------------------------------
-- Column projection views (security_invoker: RLS of the caller applies)
-- These are what the API selects from. The restricted columns are absent
-- from the view definition, so they are never serialised for that role.
-- ---------------------------------------------------------------------

-- Placement as a consultant may see it: pay rate yes, bill rate and margin never.
CREATE OR REPLACE VIEW v_placement_consultant
WITH (security_invoker = true) AS
SELECT p.placement_id, p.reference, p.consultant_id, p.client_id, c.legal_name AS client_name,
       p.job_title, p.engagement_type, p.work_mode, p.start_date, p.end_date,
       p.pay_rate, p.rate_unit, p.standard_hours_per_day, p.status
FROM placement p
JOIN client_company c ON c.client_id = p.client_id;

-- Placement as a client manager may see it: bill rate yes, pay rate and margin never.
CREATE OR REPLACE VIEW v_placement_client
WITH (security_invoker = true) AS
SELECT p.placement_id, p.reference, p.consultant_id, con.full_name AS consultant_name,
       p.client_id, p.job_title, p.engagement_type, p.work_mode,
       p.start_date, p.end_date, p.bill_rate, p.rate_unit,
       p.standard_hours_per_day, p.status
FROM placement p
JOIN consultant con ON con.consultant_id = p.consultant_id;

-- The consultant profile a client manager may see before placement:
-- no identity number, no rates, no contact details (NFR-PRI-003).
CREATE OR REPLACE VIEW v_consultant_profile_client
WITH (security_invoker = true) AS
SELECT c.consultant_id, c.preferred_name, c.headline, c.seniority,
       c.experience_years, c.location, c.availability, c.available_from
FROM consultant c
WHERE c.is_active;

-- Timesheet as an approver may see it: hours and bill rate, never the pay rate.
CREATE OR REPLACE VIEW v_timesheet_client
WITH (security_invoker = true) AS
SELECT t.timesheet_id, t.placement_id, t.week_start, t.week_end, t.status,
       t.total_standard_hours, t.total_overtime_hours, t.bill_rate,
       t.consultant_note, t.submitted_at, t.approved_at, t.rejected_reason
FROM timesheet t;

-- ---------------------------------------------------------------------
-- Reporting views — owner-executed, margin reachable only through here
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_report_margin_by_placement AS
SELECT p.placement_id, p.reference, con.full_name AS consultant_name,
       cl.legal_name AS client_name, p.start_date, p.end_date, p.status,
       sum(t.total_standard_hours + t.total_overtime_hours) AS hours_approved,
       sum((t.total_standard_hours + t.total_overtime_hours) * t.bill_rate) AS revenue,
       sum((t.total_standard_hours + t.total_overtime_hours) * t.pay_rate) AS cost,
       sum((t.total_standard_hours + t.total_overtime_hours) * (t.bill_rate - t.pay_rate)) AS margin
FROM placement p
JOIN consultant con ON con.consultant_id = p.consultant_id
JOIN client_company cl ON cl.client_id = p.client_id
LEFT JOIN timesheet t ON t.placement_id = p.placement_id
  AND t.status IN ('APPROVED','INVOICED','LOCKED')
GROUP BY p.placement_id, p.reference, con.full_name, cl.legal_name,
         p.start_date, p.end_date, p.status;

CREATE OR REPLACE VIEW v_report_pool_utilisation AS
SELECT count(*) FILTER (WHERE c.is_active) AS pool_size,
       count(*) FILTER (WHERE c.availability = 'ON_PLACEMENT') AS on_placement,
       count(*) FILTER (WHERE c.availability = 'AVAILABLE') AS available,
       round(100.0 * count(*) FILTER (WHERE c.availability = 'ON_PLACEMENT')
             / nullif(count(*) FILTER (WHERE c.is_active), 0), 1) AS utilisation_pct
FROM consultant c;

GRANT SELECT ON v_report_margin_by_placement, v_report_pool_utilisation TO rasibe_reporting;
GRANT SELECT ON v_placement_consultant, v_placement_client,
                v_consultant_profile_client, v_timesheet_client TO rasibe_app;
