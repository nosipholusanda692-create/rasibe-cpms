-- =====================================================================
-- tests.sql — checks against the schema the application runs
--
-- One transaction, then ROLLBACK, so seed data is unchanged.
-- Run with:
--   PGOPTIONS=-c rasibe.tests_strict=on
--   psql -U postgres -d rasibe -v ON_ERROR_STOP=1 -f tests.sql
--
-- When rasibe.tests_strict is on, a failed check raises and psql exits
-- non-zero. Without it, a failure is only a NOTICE and psql exits 0.
-- The script sets the actor to a recruiter first, so rasibe_app can run
-- it under row security. postgres, the table owner, can run the same file.
-- This is not the design-folder suite. That file targets objects that
-- are not in this database.
-- =====================================================================

BEGIN;

-- Recruiter, not administrator: row security allows the writes when this
-- script runs as rasibe_app, and the hours lock still applies because the
-- actor is not an administrator. A superuser bypasses row security; the
-- same setting keeps that session from being treated as an administrator.
SELECT set_config('rasibe.actor_role', 'RECRUITER', true);
SELECT set_config('rasibe.actor_user_id', 'b0000001-0000-0000-0000-000000000002', true);

CREATE TEMP TABLE rasibe_test_tally (n int NOT NULL) ON COMMIT DROP;
INSERT INTO rasibe_test_tally VALUES (0);

CREATE OR REPLACE FUNCTION pg_temp.rasibe_test_check(p_name text, p_ok boolean)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_strict text;
BEGIN
  IF p_ok THEN
    UPDATE rasibe_test_tally SET n = n + 1;
    RAISE NOTICE 'PASS: %', p_name;
  ELSE
    v_strict := current_setting('rasibe.tests_strict', true);
    IF v_strict = 'on' THEN
      RAISE EXCEPTION 'FAIL: %', p_name;
    ELSE
      RAISE NOTICE 'FAIL: %', p_name;
    END IF;
  END IF;
END $$;

-- Rows created here belong to the test transaction and disappear on ROLLBACK.
INSERT INTO consultant (consultant_id, full_name, email, consent_recorded_at, is_active) VALUES
 ('90000001-0000-0000-0000-000000000001','Fixture No Consent','rcp02-noconsent@example.co.za', NULL, true),
 ('90000001-0000-0000-0000-000000000002','Fixture Consent','rcp02-consent@example.co.za', now(), true),
 ('90000001-0000-0000-0000-000000000003','Fixture Inactive','rcp02-inactive@example.co.za', now(), false),
 ('90000001-0000-0000-0000-000000000004','Fixture Placed','rcp02-placed@example.co.za', now(), true);

INSERT INTO resource_request (request_id, reference, client_id, title) VALUES
 ('90000002-0000-0000-0000-000000000001','TST-REQ-01','c0000001-0000-0000-0000-000000000001','Consent check'),
 ('90000002-0000-0000-0000-000000000002','TST-REQ-02','c0000001-0000-0000-0000-000000000001','Inactive check'),
 ('90000002-0000-0000-0000-000000000003','TST-REQ-03','c0000001-0000-0000-0000-000000000001','Consent present');

-- Two full-time windows that do not meet, one part-time window that does,
-- and a later placement used for rates, timesheets and invoices.
INSERT INTO placement (
  placement_id, reference, consultant_id, client_id, job_title,
  engagement_type, start_date, end_date, bill_rate, pay_rate
) VALUES
 ('90000003-0000-0000-0000-000000000001','TST-PLC-01','90000001-0000-0000-0000-000000000004',
  'c0000001-0000-0000-0000-000000000001','Overlap base','FULL_TIME','2030-01-01','2030-06-30',900,600),
 ('90000003-0000-0000-0000-000000000002','TST-PLC-02','90000001-0000-0000-0000-000000000004',
  'c0000001-0000-0000-0000-000000000001','Later window','FULL_TIME','2030-07-01','2030-12-31',900,600),
 ('90000003-0000-0000-0000-000000000003','TST-PLC-03','90000001-0000-0000-0000-000000000004',
  'c0000001-0000-0000-0000-000000000001','Part time overlap','PART_TIME','2030-02-01','2030-04-01',900,600),
 ('90000003-0000-0000-0000-000000000004','TST-PLC-04','90000001-0000-0000-0000-000000000004',
  'c0000001-0000-0000-0000-000000000001','Rate and time','FULL_TIME','2031-01-01','2031-12-31',900,600);

DO $tests$
DECLARE
  v_ok boolean;
  v_bill numeric;
  v_pay numeric;
  v_place_bill numeric;
  v_place_pay numeric;
  v_failed int;
  v_until timestamptz;
  -- Expected lockout count (FR-AUT-009). The row stores 5.
  -- To prove the strict gate, change only this 5 to 4 and rerun.
  v_expected int := 5;
  v_attempt_at timestamptz;
  v_ip varchar;
  v_succeeded boolean;
  v_live int;
  v_n int;
BEGIN
  -- 01 BR-012
  v_ok := true;
  BEGIN
    INSERT INTO submission (submission_id, request_id, consultant_id)
    VALUES ('90000008-0000-0000-0000-000000000001',
            '90000002-0000-0000-0000-000000000001',
            '90000001-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN
    v_ok := false;
  END;
  PERFORM pg_temp.rasibe_test_check('01 consent missing rejects submission', NOT v_ok);

  -- 02 BR-012
  v_ok := true;
  BEGIN
    INSERT INTO submission (submission_id, request_id, consultant_id)
    VALUES ('90000008-0000-0000-0000-000000000002',
            '90000002-0000-0000-0000-000000000003',
            '90000001-0000-0000-0000-000000000002');
  EXCEPTION WHEN OTHERS THEN
    v_ok := false;
  END;
  PERFORM pg_temp.rasibe_test_check('02 consent recorded allows submission', v_ok);

  -- 03 BR-017
  v_ok := true;
  BEGIN
    INSERT INTO submission (submission_id, request_id, consultant_id)
    VALUES ('90000008-0000-0000-0000-000000000003',
            '90000002-0000-0000-0000-000000000002',
            '90000001-0000-0000-0000-000000000003');
  EXCEPTION WHEN OTHERS THEN
    v_ok := false;
  END;
  PERFORM pg_temp.rasibe_test_check('03 deactivated consultant rejects submission', NOT v_ok);

  -- 04 BR-001
  v_ok := true;
  BEGIN
    INSERT INTO placement (
      placement_id, reference, consultant_id, client_id, job_title,
      engagement_type, start_date, end_date, bill_rate, pay_rate
    ) VALUES (
      '90000003-0000-0000-0000-000000000011','TST-PLC-OVERLAP','90000001-0000-0000-0000-000000000004',
      'c0000001-0000-0000-0000-000000000001','Overlapping full time','FULL_TIME',
      '2030-03-01','2030-08-31',900,600
    );
  EXCEPTION WHEN OTHERS THEN
    v_ok := false;
  END;
  PERFORM pg_temp.rasibe_test_check('04 overlapping full-time placements rejected', NOT v_ok);

  -- 05 BR-001: TST-PLC-02 was inserted and does not meet TST-PLC-01.
  PERFORM pg_temp.rasibe_test_check(
    '05 non-overlapping full-time placement allowed',
    EXISTS (SELECT 1 FROM placement WHERE placement_id = '90000003-0000-0000-0000-000000000002')
  );

  -- 06 BR-001: the exclusion applies to full-time rows only.
  PERFORM pg_temp.rasibe_test_check(
    '06 overlapping part-time placement allowed',
    EXISTS (
      SELECT 1 FROM placement
       WHERE placement_id = '90000003-0000-0000-0000-000000000003'
         AND engagement_type = 'PART_TIME'
    )
  );

  -- 07 BR-009, while TST-PLC-04 is still pending.
  v_ok := true;
  BEGIN
    UPDATE placement SET status = 'ACTIVE'
     WHERE placement_id = '90000003-0000-0000-0000-000000000004';
  EXCEPTION WHEN OTHERS THEN
    v_ok := false;
  END;
  PERFORM pg_temp.rasibe_test_check('07 activation without rate approval rejected', NOT v_ok);

  -- 09 BR-002, still pending.
  v_ok := true;
  BEGIN
    INSERT INTO timesheet (timesheet_id, placement_id, week_start, week_end)
    VALUES ('90000004-0000-0000-0000-000000000001',
            '90000003-0000-0000-0000-000000000004',
            '2031-01-06','2031-01-12');
  EXCEPTION WHEN OTHERS THEN
    v_ok := false;
  END;
  PERFORM pg_temp.rasibe_test_check('09 timesheet against a placement awaiting rate approval rejected', NOT v_ok);

  -- 08 BR-009
  v_ok := true;
  BEGIN
    UPDATE placement
       SET status = 'ACTIVE',
           rate_approved_by = 'b0000001-0000-0000-0000-000000000001',
           rate_approved_at = now()
     WHERE placement_id = '90000003-0000-0000-0000-000000000004';
  EXCEPTION WHEN OTHERS THEN
    v_ok := false;
  END;
  PERFORM pg_temp.rasibe_test_check('08 activation with rate approval allowed', v_ok);

  -- 10 BR-002
  v_ok := true;
  BEGIN
    INSERT INTO timesheet (timesheet_id, placement_id, week_start, week_end)
    VALUES ('90000004-0000-0000-0000-000000000002',
            '90000003-0000-0000-0000-000000000004',
            '2031-01-06','2031-01-12');
  EXCEPTION WHEN OTHERS THEN
    v_ok := false;
  END;
  PERFORM pg_temp.rasibe_test_check('10 timesheet against an active placement allowed', v_ok);

  -- 11. The insert must succeed so the failure is the illegal transition.
  INSERT INTO timesheet (timesheet_id, placement_id, week_start, week_end)
  VALUES ('90000004-0000-0000-0000-000000000003',
          '90000003-0000-0000-0000-000000000004',
          '2031-01-13','2031-01-19');
  v_ok := true;
  BEGIN
    UPDATE timesheet SET status = 'APPROVED'
     WHERE timesheet_id = '90000004-0000-0000-0000-000000000003';
  EXCEPTION WHEN OTHERS THEN
    v_ok := false;
  END;
  PERFORM pg_temp.rasibe_test_check('11 timesheet cannot jump from draft to approved', NOT v_ok);

  -- 14 BR-008
  UPDATE timesheet SET status = 'SUBMITTED'
   WHERE timesheet_id = '90000004-0000-0000-0000-000000000002';
  SELECT t.bill_rate, t.pay_rate, p.bill_rate, p.pay_rate
    INTO v_bill, v_pay, v_place_bill, v_place_pay
    FROM timesheet t
    JOIN placement p ON p.placement_id = t.placement_id
   WHERE t.timesheet_id = '90000004-0000-0000-0000-000000000002';
  PERFORM pg_temp.rasibe_test_check(
    '14 submitting a timesheet snapshots the placement rates',
    v_bill = v_place_bill AND v_pay = v_place_pay AND v_bill IS NOT NULL
  );

  -- 12 BR-018. The actor is a recruiter, so this session is not an administrator.
  v_ok := true;
  BEGIN
    UPDATE timesheet
       SET total_standard_hours = total_standard_hours + 1
     WHERE timesheet_id = '90000004-0000-0000-0000-000000000002';
  EXCEPTION WHEN OTHERS THEN
    v_ok := false;
  END;
  PERFORM pg_temp.rasibe_test_check('12 hours cannot change on a submitted timesheet', NOT v_ok);

  UPDATE timesheet SET status = 'APPROVED'
   WHERE timesheet_id = '90000004-0000-0000-0000-000000000002';

  -- 15 BR-003
  INSERT INTO timesheet (timesheet_id, placement_id, week_start, week_end)
  VALUES ('90000004-0000-0000-0000-000000000004',
          '90000003-0000-0000-0000-000000000004',
          '2031-01-20','2031-01-26');
  INSERT INTO invoice (invoice_id, client_id, period_start, period_end)
  VALUES ('90000005-0000-0000-0000-000000000001',
          'c0000001-0000-0000-0000-000000000001',
          '2031-01-01','2031-01-31');
  v_ok := true;
  BEGIN
    INSERT INTO invoice_line (invoice_id, timesheet_id, description, quantity, unit_rate, line_total)
    VALUES ('90000005-0000-0000-0000-000000000001',
            '90000004-0000-0000-0000-000000000004',
            'Unapproved week', 8, 900, 7200);
  EXCEPTION WHEN OTHERS THEN
    v_ok := false;
  END;
  PERFORM pg_temp.rasibe_test_check('15 invoice line from an unapproved timesheet rejected', NOT v_ok);

  -- 16 BR-003
  v_ok := true;
  BEGIN
    INSERT INTO invoice_line (invoice_id, timesheet_id, description, quantity, unit_rate, line_total)
    VALUES ('90000005-0000-0000-0000-000000000001',
            '90000004-0000-0000-0000-000000000002',
            'Approved week', 8, 900, 7200);
  EXCEPTION WHEN OTHERS THEN
    v_ok := false;
  END;
  PERFORM pg_temp.rasibe_test_check('16 invoice line from an approved timesheet allowed', v_ok);

  -- 17 BR-011
  UPDATE invoice SET status = 'AWAITING_APPROVAL'
   WHERE invoice_id = '90000005-0000-0000-0000-000000000001';
  UPDATE invoice SET status = 'APPROVED'
   WHERE invoice_id = '90000005-0000-0000-0000-000000000001';
  UPDATE invoice
     SET status = 'ISSUED',
         issued_by = 'b0000001-0000-0000-0000-000000000001'
   WHERE invoice_id = '90000005-0000-0000-0000-000000000001';
  v_ok := true;
  BEGIN
    UPDATE invoice SET subtotal = subtotal + 1
     WHERE invoice_id = '90000005-0000-0000-0000-000000000001';
  EXCEPTION WHEN OTHERS THEN
    v_ok := false;
  END;
  PERFORM pg_temp.rasibe_test_check('17 an issued invoice cannot change its subtotal', NOT v_ok);

  -- 18 BR-011
  INSERT INTO invoice (invoice_id, client_id, period_start, period_end)
  VALUES ('90000005-0000-0000-0000-000000000002',
          'c0000001-0000-0000-0000-000000000001',
          '2031-02-01','2031-02-28');
  v_ok := true;
  BEGIN
    UPDATE invoice SET status = 'CANCELLED'
     WHERE invoice_id = '90000005-0000-0000-0000-000000000002';
  EXCEPTION WHEN OTHERS THEN
    v_ok := false;
  END;
  PERFORM pg_temp.rasibe_test_check('18 cancelling an invoice requires a reason', NOT v_ok);

  -- 19-21
  PERFORM pg_temp.rasibe_test_check(
    '19 placement ending template at 60 days',
    EXISTS (
      SELECT 1 FROM notification_template
       WHERE event = 'PLACEMENT_ENDING' AND channel = 'EMAIL'
         AND lead_days = 60 AND is_active
    )
  );
  PERFORM pg_temp.rasibe_test_check(
    '20 placement ending template at 30 days',
    EXISTS (
      SELECT 1 FROM notification_template
       WHERE event = 'PLACEMENT_ENDING' AND channel = 'EMAIL'
         AND lead_days = 30 AND is_active
    )
  );
  PERFORM pg_temp.rasibe_test_check(
    '21 placement ending template at 14 days',
    EXISTS (
      SELECT 1 FROM notification_template
       WHERE event = 'PLACEMENT_ENDING' AND channel = 'EMAIL'
         AND lead_days = 14 AND is_active
    )
  );

  -- 32
  v_ok := true;
  BEGIN
    INSERT INTO timesheet (timesheet_id, placement_id, week_start, week_end)
    VALUES ('90000004-0000-0000-0000-000000000005',
            '90000003-0000-0000-0000-000000000004',
            '2031-02-02','2031-02-07');
  EXCEPTION WHEN OTHERS THEN
    v_ok := false;
  END;
  PERFORM pg_temp.rasibe_test_check('32 a timesheet week must be seven days', NOT v_ok);

  -- 34 then 13, BR-016. The configured maximum is 16.
  v_ok := true;
  BEGIN
    INSERT INTO timesheet (timesheet_id, placement_id, week_start, week_end)
    VALUES ('90000004-0000-0000-0000-000000000006',
            '90000003-0000-0000-0000-000000000004',
            '2031-02-09','2031-02-15');
    INSERT INTO timesheet_line (timesheet_id, work_date, normal_hours)
    VALUES ('90000004-0000-0000-0000-000000000006','2031-02-09', 16);
  EXCEPTION WHEN OTHERS THEN
    v_ok := false;
  END;
  PERFORM pg_temp.rasibe_test_check('34 a day at the configured maximum is accepted', v_ok);

  v_ok := true;
  BEGIN
    INSERT INTO timesheet_line (timesheet_id, work_date, normal_hours)
    VALUES ('90000004-0000-0000-0000-000000000006','2031-02-10', 17);
  EXCEPTION WHEN OTHERS THEN
    v_ok := false;
  END;
  PERFORM pg_temp.rasibe_test_check('13 a day above the configured maximum is rejected', NOT v_ok);

  -- 33 BR-005
  INSERT INTO timesheet (timesheet_id, placement_id, week_start, week_end)
  VALUES ('90000004-0000-0000-0000-000000000007',
          '90000003-0000-0000-0000-000000000004',
          '2031-02-16','2031-02-22');
  UPDATE timesheet SET status = 'SUBMITTED'
   WHERE timesheet_id = '90000004-0000-0000-0000-000000000007';
  v_ok := true;
  BEGIN
    UPDATE timesheet
       SET status = 'REJECTED', rejected_reason = 'no'
     WHERE timesheet_id = '90000004-0000-0000-0000-000000000007';
  EXCEPTION WHEN OTHERS THEN
    v_ok := false;
  END;
  PERFORM pg_temp.rasibe_test_check('33 rejecting a timesheet requires a reason of at least five characters', NOT v_ok);

  -- 30
  v_ok := true;
  BEGIN
    UPDATE submission SET outcome = 'DECLINED_BY_CLIENT'
     WHERE submission_id = '90000008-0000-0000-0000-000000000002';
  EXCEPTION WHEN OTHERS THEN
    v_ok := false;
  END;
  PERFORM pg_temp.rasibe_test_check('30 declining a submission requires a reason', NOT v_ok);

  -- 31
  v_ok := true;
  BEGIN
    UPDATE placement SET status = 'TERMINATED'
     WHERE placement_id = '90000003-0000-0000-0000-000000000002';
  EXCEPTION WHEN OTHERS THEN
    v_ok := false;
  END;
  PERFORM pg_temp.rasibe_test_check('31 terminating a placement requires a reason', NOT v_ok);

  -- 35 BR-014
  v_ok := true;
  BEGIN
    INSERT INTO placement (
      placement_id, reference, consultant_id, client_id, job_title,
      start_date, end_date, bill_rate, pay_rate
    ) VALUES (
      '90000003-0000-0000-0000-000000000012','TST-PLC-DATES','90000001-0000-0000-0000-000000000004',
      'c0000001-0000-0000-0000-000000000001','Same day',
      '2032-01-01','2032-01-01',900,600
    );
  EXCEPTION WHEN OTHERS THEN
    v_ok := false;
  END;
  PERFORM pg_temp.rasibe_test_check('35 a placement cannot end on or before it starts', NOT v_ok);

  -- 36
  v_ok := true;
  BEGIN
    INSERT INTO placement (
      placement_id, reference, consultant_id, client_id, job_title,
      start_date, end_date, bill_rate, pay_rate
    ) VALUES (
      '90000003-0000-0000-0000-000000000013','TST-PLC-MARGIN','90000001-0000-0000-0000-000000000004',
      'c0000001-0000-0000-0000-000000000001','Negative margin',
      '2032-02-01','2032-06-01',50,100
    );
  EXCEPTION WHEN OTHERS THEN
    v_ok := false;
  END;
  PERFORM pg_temp.rasibe_test_check('36 a placement cannot bill less than it pays', NOT v_ok);

  -- 25-27. The same predicate the session middleware uses.
  INSERT INTO user_session (session_id, user_id, expires_at) VALUES
   ('90000007-0000-0000-0000-000000000001','b0000001-0000-0000-0000-000000000001', now() - interval '1 hour'),
   ('90000007-0000-0000-0000-000000000002','b0000001-0000-0000-0000-000000000001', now() + interval '8 hours'),
   ('90000007-0000-0000-0000-000000000003','b0000001-0000-0000-0000-000000000001', now() + interval '8 hours');
  UPDATE user_session SET revoked_at = now()
   WHERE session_id = '90000007-0000-0000-0000-000000000002';

  SELECT count(*) INTO v_live FROM user_session
   WHERE session_id = '90000007-0000-0000-0000-000000000001'
     AND revoked_at IS NULL AND expires_at > now();
  PERFORM pg_temp.rasibe_test_check('25 an expired session is not a live session', v_live = 0);

  SELECT count(*) INTO v_live FROM user_session
   WHERE session_id = '90000007-0000-0000-0000-000000000002'
     AND revoked_at IS NULL AND expires_at > now();
  PERFORM pg_temp.rasibe_test_check('26 a revoked session is not a live session', v_live = 0);

  SELECT count(*) INTO v_live FROM user_session
   WHERE session_id = '90000007-0000-0000-0000-000000000003'
     AND revoked_at IS NULL AND expires_at > now();
  PERFORM pg_temp.rasibe_test_check('27 a current unrevoked session is live', v_live = 1);

  -- 28
  INSERT INTO login_attempt (email, succeeded, ip_address)
  VALUES ('rcp02-lockout@example.co.za', false, '203.0.113.10')
  RETURNING attempted_at, ip_address, succeeded
  INTO v_attempt_at, v_ip, v_succeeded;
  PERFORM pg_temp.rasibe_test_check(
    '28 a failed login attempt stores the address and the time',
    v_succeeded = false
    AND v_ip = '203.0.113.10'
    AND v_attempt_at IS NOT NULL
    AND v_attempt_at > now() - interval '1 minute'
  );

  -- 29. Stored count stays 5. v_expected is the value under test.
  INSERT INTO app_user (user_id, email, full_name, password_hash, failed_logins, locked_until)
  VALUES ('90000006-0000-0000-0000-000000000001',
          'rcp02-lockout@example.co.za','Lockout Fixture','not-a-real-hash',
          5, now() + interval '15 minutes');
  SELECT failed_logins, locked_until INTO v_failed, v_until
    FROM app_user WHERE user_id = '90000006-0000-0000-0000-000000000001';
  PERFORM pg_temp.rasibe_test_check(
    '29 five failures lock the account for fifteen minutes',
    v_failed = v_expected
    AND v_until > now()
    AND v_until <= now() + interval '15 minutes' + interval '2 seconds'
  );

  SELECT n INTO v_n FROM rasibe_test_tally;
  IF v_n <> 33 THEN
    PERFORM pg_temp.rasibe_test_check('checks before the audit role switch', false);
  END IF;
END $tests$;

-- 22-24. Privileges are revoked from rasibe_app. Run as that role, then
-- record the outcome in transaction-local settings and check it as the owner.
SET LOCAL ROLE rasibe_app;

DO $audit$
DECLARE
  v_id bigint;
  v_insert text := 'no';
  v_update text := 'no';
  v_delete text := 'no';
BEGIN
  BEGIN
    INSERT INTO audit_entry (action, entity_table)
    VALUES ('CONSENT_RECORDED', 'consultant')
    RETURNING audit_id INTO v_id;
    IF v_id IS NOT NULL THEN
      v_insert := 'yes';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_insert := 'no';
  END;

  BEGIN
    UPDATE audit_entry SET reason = 'tamper' WHERE audit_id = v_id;
    v_update := 'no';
  EXCEPTION WHEN insufficient_privilege THEN
    v_update := 'yes';
  WHEN OTHERS THEN
    v_update := 'no';
  END;

  BEGIN
    DELETE FROM audit_entry WHERE audit_id = v_id;
    v_delete := 'no';
  EXCEPTION WHEN insufficient_privilege THEN
    v_delete := 'yes';
  WHEN OTHERS THEN
    v_delete := 'no';
  END;

  PERFORM set_config('rasibe.test_audit_insert', v_insert, true);
  PERFORM set_config('rasibe.test_audit_update', v_update, true);
  PERFORM set_config('rasibe.test_audit_delete', v_delete, true);
END $audit$;

RESET ROLE;

DO $audit_check$
DECLARE
  v_n int;
BEGIN
  PERFORM pg_temp.rasibe_test_check(
    '24 application role can append to the audit log',
    current_setting('rasibe.test_audit_insert', true) = 'yes'
  );
  PERFORM pg_temp.rasibe_test_check(
    '22 application role cannot update the audit log',
    current_setting('rasibe.test_audit_update', true) = 'yes'
  );
  PERFORM pg_temp.rasibe_test_check(
    '23 application role cannot delete the audit log',
    current_setting('rasibe.test_audit_delete', true) = 'yes'
  );

  SELECT n INTO v_n FROM rasibe_test_tally;
  IF v_n = 36 THEN
    RAISE NOTICE 'all 36 tests passed';
  ELSE
    PERFORM pg_temp.rasibe_test_check('suite completed 36 checks', false);
  END IF;
END $audit_check$;

ROLLBACK;
