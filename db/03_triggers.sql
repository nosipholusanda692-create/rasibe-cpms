-- =====================================================================
-- 03_triggers.sql — state machines and invariants enforced in the database
--
-- Realises the five state machine diagrams (Figures 15–19) and
-- BR-002, BR-003, BR-008, BR-010, BR-011, BR-016, BR-017, BR-018
-- =====================================================================

-- ---------------------------------------------------------------------
-- Generic: maintain updated_at
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER trg_touch_consultant BEFORE UPDATE ON consultant
  FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();
CREATE TRIGGER trg_touch_placement BEFORE UPDATE ON placement
  FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();
CREATE TRIGGER trg_touch_request BEFORE UPDATE ON resource_request
  FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();
CREATE TRIGGER trg_touch_invoice BEFORE UPDATE ON invoice
  FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();

-- ---------------------------------------------------------------------
-- Figure 15 — timesheet status
-- Every permitted transition is listed. Anything absent is refused.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_timesheet_status_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ok boolean := false;
BEGIN
  IF OLD.status = NEW.status THEN
    -- BR-018: a submitted timesheet may not be edited by anyone but an administrator
    IF OLD.status IN ('SUBMITTED','APPROVED','INVOICED','LOCKED')
       AND (OLD.total_standard_hours <> NEW.total_standard_hours
            OR OLD.total_overtime_hours <> NEW.total_overtime_hours)
       AND NOT is_admin() THEN
      RAISE EXCEPTION 'timesheet %: hours may not be changed while status is % (BR-018)',
        OLD.timesheet_id, OLD.status USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  ok := CASE
    WHEN OLD.status = 'DRAFT'        AND NEW.status IN ('PENDING_SYNC','SUBMITTED') THEN true
    WHEN OLD.status = 'PENDING_SYNC' AND NEW.status IN ('DRAFT','SUBMITTED')        THEN true
    WHEN OLD.status = 'SUBMITTED'    AND NEW.status IN ('DRAFT','APPROVED','REJECTED') THEN true
    WHEN OLD.status = 'REJECTED'     AND NEW.status IN ('DRAFT','SUBMITTED')        THEN true
    WHEN OLD.status = 'APPROVED'     AND NEW.status IN ('INVOICED','LOCKED')        THEN true
    -- administrator override returns an approved week for correction (Q26)
    WHEN OLD.status = 'APPROVED'     AND NEW.status = 'SUBMITTED' AND is_admin()    THEN true
    WHEN OLD.status = 'INVOICED'     AND NEW.status = 'LOCKED'                      THEN true
    ELSE false
  END;

  IF NOT ok THEN
    RAISE EXCEPTION 'timesheet %: transition % -> % is not permitted',
      OLD.timesheet_id, OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;

  -- BR-008: snapshot the rates in force at submission
  IF NEW.status = 'SUBMITTED' AND OLD.status IN ('DRAFT','PENDING_SYNC') THEN
    SELECT p.bill_rate, p.pay_rate, p.overtime_multiplier
      INTO NEW.bill_rate, NEW.pay_rate, NEW.overtime_multiplier
      FROM placement p WHERE p.placement_id = NEW.placement_id;
    NEW.submitted_at := now();
    NEW.rejected_reason := NULL;
  END IF;

  IF NEW.status = 'APPROVED' THEN
    NEW.approved_at := now();
    NEW.rejected_reason := NULL;
  END IF;

  -- an administrator override is recorded as an override, not a normal approval
  IF OLD.status = 'APPROVED' AND NEW.status = 'SUBMITTED' THEN
    NEW.is_override := true;
  END IF;

  NEW.row_version := OLD.row_version + 1;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_timesheet_status_transition BEFORE UPDATE ON timesheet
  FOR EACH ROW EXECUTE FUNCTION fn_timesheet_status_transition();

-- BR-002: a timesheet may exist only against an active placement
CREATE OR REPLACE FUNCTION fn_timesheet_requires_active_placement() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE s placement_status_enum;
BEGIN
  SELECT status INTO s FROM placement WHERE placement_id = NEW.placement_id;
  IF s NOT IN ('ACTIVE','ENDING_SOON') THEN
    RAISE EXCEPTION 'placement % is %; a timesheet may only be raised against an active placement (BR-002)',
      NEW.placement_id, s USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_timesheet_active_placement BEFORE INSERT ON timesheet
  FOR EACH ROW EXECUTE FUNCTION fn_timesheet_requires_active_placement();

-- Recompute weekly totals from the day lines, and apply the configured
-- daily maximum (BR-016).
CREATE OR REPLACE FUNCTION fn_timesheet_recalc() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_ts uuid := coalesce(NEW.timesheet_id, OLD.timesheet_id);
  v_max numeric;
  v_over numeric;
BEGIN
  SELECT coalesce((SELECT setting_value::numeric FROM system_setting
                   WHERE setting_key = 'max_hours_per_day'), 16) INTO v_max;

  SELECT max(normal_hours + overtime_hours) INTO v_over
    FROM timesheet_line WHERE timesheet_id = v_ts;

  IF v_over IS NOT NULL AND v_over > v_max THEN
    RAISE EXCEPTION 'a day records % hours, above the configured maximum of % (BR-016)',
      v_over, v_max USING ERRCODE = '23514';
  END IF;

  UPDATE timesheet t SET
    total_standard_hours = coalesce((SELECT sum(normal_hours) FROM timesheet_line WHERE timesheet_id = v_ts), 0),
    total_overtime_hours = coalesce((SELECT sum(overtime_hours) FROM timesheet_line WHERE timesheet_id = v_ts), 0)
  WHERE t.timesheet_id = v_ts;

  RETURN NULL;
END $$;

CREATE TRIGGER trg_timesheet_recalc
  AFTER INSERT OR UPDATE OR DELETE ON timesheet_line
  FOR EACH ROW EXECUTE FUNCTION fn_timesheet_recalc();

-- ---------------------------------------------------------------------
-- Figure 16 — invoice status, and BR-003 / BR-010 / BR-011
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_invoice_status_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE ok boolean := false;
BEGIN
  IF OLD.status = NEW.status THEN
    -- BR-011: an issued invoice is immutable in its money columns
    IF OLD.status IN ('ISSUED','OVERDUE','PART_PAID','PAID')
       AND (OLD.subtotal <> NEW.subtotal OR OLD.total <> NEW.total
            OR OLD.vat_amount <> NEW.vat_amount) THEN
      RAISE EXCEPTION 'invoice %: an issued invoice may not be amended; raise a credit note (BR-011)',
        OLD.invoice_id USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  ok := CASE
    WHEN OLD.status = 'DRAFT'             AND NEW.status IN ('AWAITING_APPROVAL','CANCELLED') THEN true
    WHEN OLD.status = 'AWAITING_APPROVAL' AND NEW.status IN ('APPROVED','DRAFT','CANCELLED')  THEN true
    WHEN OLD.status = 'APPROVED'          AND NEW.status IN ('ISSUED','CANCELLED')            THEN true
    WHEN OLD.status = 'ISSUED'            AND NEW.status IN ('OVERDUE','PART_PAID','PAID')    THEN true
    WHEN OLD.status = 'OVERDUE'           AND NEW.status IN ('PART_PAID','PAID')              THEN true
    WHEN OLD.status = 'PART_PAID'         AND NEW.status IN ('PAID','OVERDUE')                THEN true
    ELSE false
  END;

  IF NOT ok THEN
    RAISE EXCEPTION 'invoice %: transition % -> % is not permitted (BR-011)',
      OLD.invoice_id, OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;

  -- BR-010: the number is allocated at issue, not when the draft is prepared,
  -- so a discarded draft consumes no number.
  IF NEW.status = 'ISSUED' AND OLD.status = 'APPROVED' THEN
    IF NEW.invoice_number IS NULL THEN
      NEW.invoice_number := 'INV-' || nextval('invoice_number_seq')::text;
    END IF;
    NEW.issued_at := now();
    NEW.due_date := (now() + (SELECT payment_terms_days FROM client_company
                              WHERE client_id = NEW.client_id) * interval '1 day')::date;
  END IF;

  IF NEW.status = 'CANCELLED' AND coalesce(NEW.cancelled_reason,'') = '' THEN
    RAISE EXCEPTION 'invoice %: cancellation requires a reason', OLD.invoice_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_invoice_status_transition BEFORE UPDATE ON invoice
  FOR EACH ROW EXECUTE FUNCTION fn_invoice_status_transition();

-- BR-003: an invoice line may only draw on an approved timesheet
CREATE OR REPLACE FUNCTION fn_invoice_line_requires_approval() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE s timesheet_status_enum;
BEGIN
  IF NEW.timesheet_id IS NULL THEN
    RETURN NEW;                        -- adjustment or credit line
  END IF;
  SELECT status INTO s FROM timesheet WHERE timesheet_id = NEW.timesheet_id;
  IF s NOT IN ('APPROVED','INVOICED') THEN
    RAISE EXCEPTION 'timesheet % is %; only approved hours may be invoiced (BR-003)',
      NEW.timesheet_id, s USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_invoice_line_requires_approval BEFORE INSERT ON invoice_line
  FOR EACH ROW EXECUTE FUNCTION fn_invoice_line_requires_approval();

-- Payment status follows from the amount recorded, not from anyone editing it
CREATE OR REPLACE FUNCTION fn_invoice_payment_status() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('ISSUED','OVERDUE','PART_PAID') AND NEW.amount_paid > 0 THEN
    IF NEW.amount_paid >= NEW.total THEN
      NEW.status := 'PAID';
    ELSE
      NEW.status := 'PART_PAID';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_invoice_payment BEFORE UPDATE OF amount_paid ON invoice
  FOR EACH ROW EXECUTE FUNCTION fn_invoice_payment_status();

-- ---------------------------------------------------------------------
-- Figure 17 — placement status, and the rate gate
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_placement_status_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE ok boolean := false;
BEGIN
  -- BR-009: a rate change on a live placement returns it for approval
  IF (OLD.bill_rate <> NEW.bill_rate OR OLD.pay_rate <> NEW.pay_rate)
     AND OLD.status IN ('ACTIVE','ENDING_SOON','PENDING_START') THEN
    IF NOT is_admin() THEN
      RAISE EXCEPTION 'placement %: a rate change requires administrator approval (BR-009)',
        OLD.placement_id USING ERRCODE = '42501';
    END IF;
    NEW.status := 'PENDING_RATE_APPROVAL';
    NEW.rate_approved_by := NULL;
    NEW.rate_approved_at := NULL;
    RETURN NEW;
  END IF;

  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  ok := CASE
    WHEN OLD.status = 'PENDING_RATE_APPROVAL' AND NEW.status IN ('PENDING_START','ACTIVE','TERMINATED') THEN true
    WHEN OLD.status = 'PENDING_START' AND NEW.status IN ('ACTIVE','TERMINATED')            THEN true
    WHEN OLD.status = 'ACTIVE'        AND NEW.status IN ('ENDING_SOON','ENDED','TERMINATED','RENEWED') THEN true
    WHEN OLD.status = 'ENDING_SOON'   AND NEW.status IN ('ENDED','TERMINATED','RENEWED','ACTIVE')      THEN true
    ELSE false
  END;

  IF NOT ok THEN
    RAISE EXCEPTION 'placement %: transition % -> % is not permitted',
      OLD.placement_id, OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;

  IF NEW.status IN ('ACTIVE','PENDING_START') AND OLD.status = 'PENDING_RATE_APPROVAL' THEN
    IF NEW.rate_approved_by IS NULL THEN
      RAISE EXCEPTION 'placement %: rates must be approved before activation (BR-009)',
        OLD.placement_id USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.status = 'TERMINATED' AND coalesce(NEW.terminated_reason,'') = '' THEN
    RAISE EXCEPTION 'placement %: early termination requires a reason', OLD.placement_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_placement_status_transition BEFORE UPDATE ON placement
  FOR EACH ROW EXECUTE FUNCTION fn_placement_status_transition();

-- Consultant availability follows from placement state rather than being
-- maintained by hand, so the flag cannot drift from the records (DD-10).
CREATE OR REPLACE FUNCTION fn_sync_consultant_availability() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('ACTIVE','ENDING_SOON') THEN
    UPDATE consultant SET availability = 'ON_PLACEMENT'
      WHERE consultant_id = NEW.consultant_id AND availability <> 'NOT_AVAILABLE';
  ELSIF NEW.status IN ('ENDED','TERMINATED') THEN
    UPDATE consultant SET availability = 'AVAILABLE', available_from = NULL
      WHERE consultant_id = NEW.consultant_id
        AND NOT EXISTS (SELECT 1 FROM placement p2
                        WHERE p2.consultant_id = NEW.consultant_id
                          AND p2.placement_id <> NEW.placement_id
                          AND p2.status IN ('ACTIVE','ENDING_SOON'));
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER trg_sync_availability AFTER UPDATE OF status ON placement
  FOR EACH ROW EXECUTE FUNCTION fn_sync_consultant_availability();

-- ---------------------------------------------------------------------
-- Figure 19 — submission outcome; placing one closes the request (FILLED)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_submission_outcome() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.outcome <> OLD.outcome THEN
    NEW.decided_at := now();
    IF NEW.outcome IN ('DECLINED_BY_CLIENT','WITHDRAWN')
       AND coalesce(NEW.outcome_reason,'') = '' THEN
      RAISE EXCEPTION 'submission %: a declined or withdrawn outcome requires a reason',
        OLD.submission_id USING ERRCODE = '23514';
    END IF;
    IF NEW.outcome = 'PLACED' THEN
      UPDATE resource_request
         SET status = 'FILLED', closed_at = now()
       WHERE request_id = NEW.request_id AND status <> 'FILLED';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_submission_outcome BEFORE UPDATE ON submission
  FOR EACH ROW EXECUTE FUNCTION fn_submission_outcome();

-- BR-012: consent must be on record before a consultant is disclosed to a client
CREATE OR REPLACE FUNCTION fn_submission_requires_consent() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_consent timestamptz; v_active boolean;
BEGIN
  SELECT consent_recorded_at, is_active INTO v_consent, v_active
    FROM consultant WHERE consultant_id = NEW.consultant_id;
  IF v_consent IS NULL THEN
    RAISE EXCEPTION 'consultant %: consent must be recorded before submission (BR-012)',
      NEW.consultant_id USING ERRCODE = '23514';
  END IF;
  IF NOT v_active THEN
    RAISE EXCEPTION 'consultant %: a deactivated consultant may not be submitted (BR-017)',
      NEW.consultant_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_submission_consent BEFORE INSERT ON submission
  FOR EACH ROW EXECUTE FUNCTION fn_submission_requires_consent();
