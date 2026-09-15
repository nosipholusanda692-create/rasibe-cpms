-- =====================================================================
-- Rasibe Consultant Placement Management System
-- 01_schema.sql — enumerated types, tables, keys and constraints
-- Target: PostgreSQL 16
-- Traces to: ERD (Figure 10), class model (Figure 9), business rules BR-001..BR-022
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------
-- Enumerated types (17)
-- ---------------------------------------------------------------------
CREATE TYPE role_enum              AS ENUM ('ADMINISTRATOR','RECRUITER','CONSULTANT','CLIENT_MANAGER');
CREATE TYPE seniority_enum         AS ENUM ('JUNIOR','INTERMEDIATE','SENIOR','LEAD','PRINCIPAL');
CREATE TYPE proficiency_enum       AS ENUM ('BASIC','INTERMEDIATE','ADVANCED','EXPERT');
CREATE TYPE availability_enum      AS ENUM ('AVAILABLE','AVAILABLE_FROM','ON_PLACEMENT','NOT_AVAILABLE');
CREATE TYPE engagement_type_enum   AS ENUM ('FULL_TIME','PART_TIME','CONTRACT','FIXED_TERM');
CREATE TYPE work_mode_enum         AS ENUM ('ON_SITE','HYBRID','REMOTE');
CREATE TYPE request_status_enum    AS ENUM ('DRAFT','OPEN','SHORTLISTING','INTERVIEWING','FILLED','CANCELLED');
CREATE TYPE submission_outcome_enum AS ENUM ('SUBMITTED','SHORTLISTED','INTERVIEWING','OFFERED','PLACED','DECLINED_BY_CLIENT','WITHDRAWN');
CREATE TYPE placement_status_enum  AS ENUM ('PENDING_RATE_APPROVAL','PENDING_START','ACTIVE','ENDING_SOON','ENDED','TERMINATED','RENEWED');
CREATE TYPE timesheet_status_enum  AS ENUM ('DRAFT','PENDING_SYNC','SUBMITTED','REJECTED','APPROVED','INVOICED','LOCKED');
CREATE TYPE invoice_status_enum    AS ENUM ('DRAFT','AWAITING_APPROVAL','APPROVED','ISSUED','OVERDUE','PART_PAID','PAID','CANCELLED');
CREATE TYPE invoice_line_type_enum AS ENUM ('STANDARD','OVERTIME','CREDIT','ADJUSTMENT');
CREATE TYPE rate_unit_enum         AS ENUM ('HOURLY','DAILY','MONTHLY');
CREATE TYPE document_type_enum     AS ENUM ('CV','CONTRACT','CERTIFICATION','VETTING','ID_DOCUMENT','OTHER');
CREATE TYPE notification_event_enum AS ENUM (
  'TIMESHEET_DUE','TIMESHEET_OVERDUE','TIMESHEET_AWAITING_APPROVAL','TIMESHEET_APPROVED',
  'TIMESHEET_REJECTED','INVOICE_ISSUED','REQUEST_RAISED','SUBMISSION_OUTCOME',
  'PLACEMENT_ENDING','DOCUMENT_EXPIRING','ACCOUNT_CREATED','PASSWORD_RESET');
CREATE TYPE channel_enum           AS ENUM ('EMAIL','IN_APP');
CREATE TYPE audit_action_enum      AS ENUM (
  'TIMESHEET_APPROVED','TIMESHEET_REJECTED','TIMESHEET_OVERRIDDEN','RATE_CHANGED',
  'RATE_APPROVED','INVOICE_ISSUED','INVOICE_CANCELLED','CREDIT_NOTE_RAISED',
  'CONSENT_RECORDED','VETTING_ACCESSED','BANKING_ACCESSED','USER_DEACTIVATED',
  'PLACEMENT_TERMINATED','CONSULTANT_ANONYMISED');

-- ---------------------------------------------------------------------
-- Access and identity
-- ---------------------------------------------------------------------
CREATE TABLE app_user (
  user_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           varchar(255) NOT NULL UNIQUE,
  full_name       varchar(200) NOT NULL,
  phone           varchar(40),
  password_hash   varchar(255) NOT NULL,
  is_active       boolean NOT NULL DEFAULT true,
  failed_logins   int NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_user_email CHECK (position('@' in email) > 1)
);

CREATE TABLE user_role (
  user_id   uuid NOT NULL REFERENCES app_user(user_id) ON DELETE CASCADE,
  role      role_enum NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

-- Roles are data, not subclasses (design decision DD in section 9)
CREATE TABLE role_capability (
  role       role_enum NOT NULL,
  capability varchar(80) NOT NULL,
  PRIMARY KEY (role, capability)
);

CREATE TABLE user_session (
  session_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES app_user(user_id) ON DELETE CASCADE,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  ip_address  varchar(64)
);
CREATE INDEX ix_session_user ON user_session(user_id);

CREATE TABLE login_attempt (
  attempt_id  bigserial PRIMARY KEY,
  email       varchar(255) NOT NULL,
  succeeded   boolean NOT NULL,
  ip_address  varchar(64),
  attempted_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Talent pool
-- ---------------------------------------------------------------------
CREATE TABLE consultant (
  consultant_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid UNIQUE REFERENCES app_user(user_id) ON DELETE SET NULL,
  full_name         varchar(200) NOT NULL,
  preferred_name    varchar(100),
  id_number         varchar(40) UNIQUE,            -- restricted: administrator only
  date_of_birth     date,
  email             varchar(255) NOT NULL UNIQUE,
  mobile            varchar(40),
  location          varchar(120),
  nationality       varchar(80),
  right_to_work     varchar(120),
  seniority         seniority_enum,
  headline          varchar(300),
  experience_years  int CHECK (experience_years IS NULL OR experience_years BETWEEN 0 AND 60),
  availability      availability_enum NOT NULL DEFAULT 'AVAILABLE',
  available_from    date,
  min_pay_rate      numeric(12,2) CHECK (min_pay_rate IS NULL OR min_pay_rate >= 0),
  preferred_pay_rate numeric(12,2) CHECK (preferred_pay_rate IS NULL OR preferred_pay_rate >= 0),
  rate_unit         rate_unit_enum NOT NULL DEFAULT 'HOURLY',
  vetting_status    varchar(60),                   -- restricted: administrator only
  vetting_cleared_on date,                         -- restricted: administrator only
  bank_name         varchar(120),                  -- restricted: administrator only
  bank_account_ref  varchar(80),                   -- restricted: administrator only
  consent_recorded_at timestamptz,
  retention_expires_on date,
  is_active         boolean NOT NULL DEFAULT true,
  is_anonymised     boolean NOT NULL DEFAULT false,
  source            varchar(120),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_available_from CHECK (availability <> 'AVAILABLE_FROM' OR available_from IS NOT NULL)
);
CREATE INDEX ix_consultant_name_trgm ON consultant USING gin (full_name gin_trgm_ops);
CREATE INDEX ix_consultant_availability ON consultant(availability, available_from);
CREATE INDEX ix_consultant_active ON consultant(is_active);

CREATE TABLE skill (
  skill_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name      varchar(120) NOT NULL UNIQUE,
  category  varchar(80),
  is_active boolean NOT NULL DEFAULT true
);
CREATE INDEX ix_skill_name_trgm ON skill USING gin (name gin_trgm_ops);

CREATE TABLE consultant_skill (
  consultant_id uuid NOT NULL REFERENCES consultant(consultant_id) ON DELETE CASCADE,
  skill_id      uuid NOT NULL REFERENCES skill(skill_id) ON DELETE CASCADE,
  proficiency   proficiency_enum NOT NULL,
  years         numeric(4,1) CHECK (years IS NULL OR years >= 0),
  last_used_year int,
  is_primary    boolean NOT NULL DEFAULT false,
  PRIMARY KEY (consultant_id, skill_id)
);

CREATE TABLE certification (
  certification_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultant_id    uuid NOT NULL REFERENCES consultant(consultant_id) ON DELETE CASCADE,
  name             varchar(200) NOT NULL,
  issuing_body     varchar(200),
  issued_on        date,
  expires_on       date,
  CONSTRAINT ck_cert_dates CHECK (expires_on IS NULL OR issued_on IS NULL OR expires_on >= issued_on)
);
CREATE INDEX ix_cert_expiry ON certification(expires_on);

-- ---------------------------------------------------------------------
-- Demand
-- ---------------------------------------------------------------------
CREATE TABLE client_company (
  client_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name       varchar(200) NOT NULL,
  registration_number varchar(60) UNIQUE,
  vat_number       varchar(40),
  trading_name     varchar(200),
  industry         varchar(120),
  physical_address text,
  billing_address  text,
  payment_terms_days int NOT NULL DEFAULT 30 CHECK (payment_terms_days BETWEEN 0 AND 180),
  purchase_order_required boolean NOT NULL DEFAULT false,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_client_name_trgm ON client_company USING gin (legal_name gin_trgm_ops);

CREATE TABLE client_contact (
  contact_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid NOT NULL REFERENCES client_company(client_id) ON DELETE CASCADE,
  user_id     uuid REFERENCES app_user(user_id) ON DELETE SET NULL,
  first_name  varchar(100) NOT NULL,
  last_name   varchar(100) NOT NULL,
  job_title   varchar(120),
  email       varchar(255) NOT NULL,
  phone       varchar(40),
  is_timesheet_approver boolean NOT NULL DEFAULT false,
  is_primary  boolean NOT NULL DEFAULT false,
  is_active   boolean NOT NULL DEFAULT true,
  UNIQUE (client_id, email)
);
CREATE INDEX ix_contact_user ON client_contact(user_id);

CREATE TABLE rate_card (
  rate_card_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    uuid NOT NULL REFERENCES client_company(client_id) ON DELETE CASCADE,
  name         varchar(120) NOT NULL,
  currency     char(3) NOT NULL DEFAULT 'ZAR',
  effective_from date NOT NULL,
  effective_to date,
  is_active    boolean NOT NULL DEFAULT true,
  CONSTRAINT ck_ratecard_dates CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE TABLE rate_card_line (
  rate_card_line_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rate_card_id  uuid NOT NULL REFERENCES rate_card(rate_card_id) ON DELETE CASCADE,
  skill_id      uuid REFERENCES skill(skill_id) ON DELETE SET NULL,
  seniority     seniority_enum,
  rate_unit     rate_unit_enum NOT NULL DEFAULT 'HOURLY',
  min_bill_rate numeric(12,2) NOT NULL CHECK (min_bill_rate >= 0),
  max_bill_rate numeric(12,2) NOT NULL CHECK (max_bill_rate >= 0),
  overtime_multiplier numeric(4,2) NOT NULL DEFAULT 1.50 CHECK (overtime_multiplier >= 1),
  CONSTRAINT ck_rate_band CHECK (max_bill_rate >= min_bill_rate)
);

CREATE TABLE resource_request (
  request_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference     varchar(30) NOT NULL UNIQUE,
  client_id     uuid NOT NULL REFERENCES client_company(client_id) ON DELETE RESTRICT,
  contact_id    uuid REFERENCES client_contact(contact_id) ON DELETE SET NULL,
  raised_by     uuid REFERENCES app_user(user_id) ON DELETE SET NULL,
  title         varchar(200) NOT NULL,
  description   text,
  seniority     seniority_enum,
  engagement_type engagement_type_enum NOT NULL DEFAULT 'FULL_TIME',
  work_mode     work_mode_enum NOT NULL DEFAULT 'ON_SITE',
  location      varchar(120),
  quantity      int NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  start_date    date,
  duration_months int CHECK (duration_months IS NULL OR duration_months > 0),
  budget_rate   numeric(12,2) CHECK (budget_rate IS NULL OR budget_rate >= 0),
  rate_unit     rate_unit_enum NOT NULL DEFAULT 'HOURLY',
  status        request_status_enum NOT NULL DEFAULT 'DRAFT',
  closed_at     timestamptz,
  close_reason  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_request_client_status ON resource_request(client_id, status);

CREATE TABLE request_skill (
  request_id  uuid NOT NULL REFERENCES resource_request(request_id) ON DELETE CASCADE,
  skill_id    uuid NOT NULL REFERENCES skill(skill_id) ON DELETE CASCADE,
  is_mandatory boolean NOT NULL DEFAULT true,
  min_proficiency proficiency_enum,
  min_years   numeric(4,1),
  PRIMARY KEY (request_id, skill_id)
);

CREATE TABLE submission (
  submission_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id    uuid NOT NULL REFERENCES resource_request(request_id) ON DELETE CASCADE,
  consultant_id uuid NOT NULL REFERENCES consultant(consultant_id) ON DELETE RESTRICT,
  submitted_by  uuid REFERENCES app_user(user_id) ON DELETE SET NULL,
  proposed_bill_rate numeric(12,2) CHECK (proposed_bill_rate IS NULL OR proposed_bill_rate >= 0),
  proposed_pay_rate  numeric(12,2) CHECK (proposed_pay_rate IS NULL OR proposed_pay_rate >= 0),
  outcome       submission_outcome_enum NOT NULL DEFAULT 'SUBMITTED',
  outcome_reason text,
  consent_reference uuid,
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  -- BR-022: one submission per consultant per request
  CONSTRAINT uq_submission UNIQUE (request_id, consultant_id)
);
CREATE INDEX ix_submission_consultant ON submission(consultant_id);

-- ---------------------------------------------------------------------
-- Delivery
-- ---------------------------------------------------------------------
CREATE TABLE placement (
  placement_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference     varchar(30) NOT NULL UNIQUE,
  submission_id uuid UNIQUE REFERENCES submission(submission_id) ON DELETE SET NULL,
  consultant_id uuid NOT NULL REFERENCES consultant(consultant_id) ON DELETE RESTRICT,
  client_id     uuid NOT NULL REFERENCES client_company(client_id) ON DELETE RESTRICT,
  request_id    uuid REFERENCES resource_request(request_id) ON DELETE SET NULL,
  approver_contact_id uuid REFERENCES client_contact(contact_id) ON DELETE SET NULL,
  job_title     varchar(200) NOT NULL,
  engagement_type engagement_type_enum NOT NULL DEFAULT 'FULL_TIME',
  work_mode     work_mode_enum NOT NULL DEFAULT 'ON_SITE',
  start_date    date NOT NULL,
  end_date      date NOT NULL,
  -- BR-008 snapshot: rates fixed on the placement, copied again onto each timesheet
  bill_rate     numeric(12,2) NOT NULL CHECK (bill_rate >= 0),
  pay_rate      numeric(12,2) NOT NULL CHECK (pay_rate >= 0),
  rate_unit     rate_unit_enum NOT NULL DEFAULT 'HOURLY',
  overtime_multiplier numeric(4,2) NOT NULL DEFAULT 1.50 CHECK (overtime_multiplier >= 1),
  margin_amount numeric(12,2) GENERATED ALWAYS AS (bill_rate - pay_rate) STORED,
  standard_hours_per_day numeric(4,1) NOT NULL DEFAULT 8 CHECK (standard_hours_per_day > 0),
  status        placement_status_enum NOT NULL DEFAULT 'PENDING_RATE_APPROVAL',
  rate_approved_by uuid REFERENCES app_user(user_id) ON DELETE SET NULL,
  rate_approved_at timestamptz,
  terminated_reason text,
  superseded_by uuid REFERENCES placement(placement_id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- BR-014
  CONSTRAINT ck_placement_dates CHECK (end_date > start_date),
  -- BR-006/BR-007 sanity: a placement must not lose money silently
  CONSTRAINT ck_placement_margin CHECK (bill_rate >= pay_rate)
);

-- BR-001: no overlapping active full-time placements for one consultant.
-- Enforced structurally rather than in application code.
ALTER TABLE placement ADD CONSTRAINT ex_placement_no_overlap
  EXCLUDE USING gist (
    consultant_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  )
  WHERE (engagement_type = 'FULL_TIME'
         AND status IN ('PENDING_RATE_APPROVAL','PENDING_START','ACTIVE','ENDING_SOON'));

CREATE INDEX ix_placement_consultant ON placement(consultant_id);
CREATE INDEX ix_placement_client_status ON placement(client_id, status);
CREATE INDEX ix_placement_end ON placement(end_date) WHERE status IN ('ACTIVE','ENDING_SOON');

CREATE TABLE timesheet (
  timesheet_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  placement_id  uuid NOT NULL REFERENCES placement(placement_id) ON DELETE RESTRICT,
  week_start    date NOT NULL,
  week_end      date NOT NULL,
  status        timesheet_status_enum NOT NULL DEFAULT 'DRAFT',
  -- BR-008: rates snapshotted at submission
  bill_rate     numeric(12,2),
  pay_rate      numeric(12,2),
  overtime_multiplier numeric(4,2),
  total_standard_hours numeric(6,2) NOT NULL DEFAULT 0 CHECK (total_standard_hours >= 0),
  total_overtime_hours numeric(6,2) NOT NULL DEFAULT 0 CHECK (total_overtime_hours >= 0),
  consultant_note text,
  submitted_at  timestamptz,
  approved_by   uuid REFERENCES app_user(user_id) ON DELETE SET NULL,
  approved_at   timestamptz,
  rejected_reason text,
  is_override   boolean NOT NULL DEFAULT false,
  invoice_id    uuid,
  -- offline sync (FR-MOB-004..008, BR-019)
  client_uuid   uuid UNIQUE,
  row_version   int NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_timesheet_week UNIQUE (placement_id, week_start),
  CONSTRAINT ck_timesheet_week CHECK (week_end = week_start + 6),
  -- BR-005: a rejection must carry a reason of at least five characters
  CONSTRAINT ck_reject_reason CHECK (status <> 'REJECTED' OR length(coalesce(rejected_reason,'')) >= 5)
);
CREATE INDEX ix_timesheet_status ON timesheet(status);
CREATE INDEX ix_timesheet_placement_week ON timesheet(placement_id, week_start DESC);

CREATE TABLE timesheet_line (
  timesheet_line_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  timesheet_id  uuid NOT NULL REFERENCES timesheet(timesheet_id) ON DELETE CASCADE,
  work_date     date NOT NULL,
  normal_hours  numeric(5,2) NOT NULL DEFAULT 0 CHECK (normal_hours >= 0 AND normal_hours <= 24),
  overtime_hours numeric(5,2) NOT NULL DEFAULT 0 CHECK (overtime_hours >= 0 AND overtime_hours <= 24),
  is_public_holiday boolean NOT NULL DEFAULT false,
  is_leave      boolean NOT NULL DEFAULT false,
  note          varchar(300),
  UNIQUE (timesheet_id, work_date),
  CONSTRAINT ck_day_total CHECK (normal_hours + overtime_hours <= 24)
);

-- ---------------------------------------------------------------------
-- Finance
-- ---------------------------------------------------------------------
CREATE TABLE invoice (
  invoice_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number varchar(30) UNIQUE,               -- allocated at issue (BR-010)
  client_id      uuid NOT NULL REFERENCES client_company(client_id) ON DELETE RESTRICT,
  period_start   date NOT NULL,
  period_end     date NOT NULL,
  status         invoice_status_enum NOT NULL DEFAULT 'DRAFT',
  currency       char(3) NOT NULL DEFAULT 'ZAR',
  subtotal       numeric(14,2) NOT NULL DEFAULT 0,
  vat_rate       numeric(5,2) NOT NULL DEFAULT 0,  -- business not VAT registered (client decision)
  vat_amount     numeric(14,2) NOT NULL DEFAULT 0,
  total          numeric(14,2) NOT NULL DEFAULT 0,
  amount_paid    numeric(14,2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  issued_at      timestamptz,
  issued_by      uuid REFERENCES app_user(user_id) ON DELETE SET NULL,
  due_date       date,
  exported_at    timestamptz,
  cancelled_reason text,
  credit_note_for uuid REFERENCES invoice(invoice_id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_invoice_period CHECK (period_end >= period_start),
  -- BR-010: an issued invoice must carry a number, an issuer and a timestamp
  CONSTRAINT ck_invoice_issued CHECK (
    status IN ('DRAFT','AWAITING_APPROVAL','APPROVED','CANCELLED')
    OR (invoice_number IS NOT NULL AND issued_at IS NOT NULL AND issued_by IS NOT NULL))
);
CREATE INDEX ix_invoice_client_status ON invoice(client_id, status);

CREATE TABLE invoice_line (
  invoice_line_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id    uuid NOT NULL REFERENCES invoice(invoice_id) ON DELETE CASCADE,
  timesheet_id  uuid REFERENCES timesheet(timesheet_id) ON DELETE RESTRICT,
  line_type     invoice_line_type_enum NOT NULL DEFAULT 'STANDARD',
  description   varchar(300) NOT NULL,
  quantity      numeric(10,2) NOT NULL,
  unit_rate     numeric(12,2) NOT NULL,
  line_total    numeric(14,2) NOT NULL
);
CREATE INDEX ix_invoice_line_invoice ON invoice_line(invoice_id);

ALTER TABLE timesheet
  ADD CONSTRAINT fk_timesheet_invoice FOREIGN KEY (invoice_id)
  REFERENCES invoice(invoice_id) ON DELETE SET NULL;

CREATE SEQUENCE invoice_number_seq START 1001;

-- ---------------------------------------------------------------------
-- Documents, audit, notification, retention
-- ---------------------------------------------------------------------
CREATE TABLE document (
  document_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultant_id uuid REFERENCES consultant(consultant_id) ON DELETE CASCADE,
  placement_id  uuid REFERENCES placement(placement_id) ON DELETE CASCADE,
  client_id     uuid REFERENCES client_company(client_id) ON DELETE CASCADE,
  doc_type      document_type_enum NOT NULL,
  file_name     varchar(255) NOT NULL,
  storage_key   varchar(400) NOT NULL,
  mime_type     varchar(120),
  size_bytes    bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  version       int NOT NULL DEFAULT 1,
  is_restricted boolean NOT NULL DEFAULT false,     -- vetting / ID / banking evidence
  expires_on    date,
  uploaded_by   uuid REFERENCES app_user(user_id) ON DELETE SET NULL,
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_document_owner CHECK (
    (consultant_id IS NOT NULL)::int + (placement_id IS NOT NULL)::int + (client_id IS NOT NULL)::int = 1)
);
CREATE INDEX ix_document_expiry ON document(expires_on);

-- BR-020: append-only. UPDATE and DELETE are revoked from the application role.
CREATE TABLE audit_entry (
  audit_id     bigserial PRIMARY KEY,
  actor_user_id uuid REFERENCES app_user(user_id) ON DELETE SET NULL,
  action       audit_action_enum NOT NULL,
  entity_table varchar(60) NOT NULL,
  entity_id    uuid,
  previous_value jsonb,
  new_value    jsonb,
  reason       text,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_entity ON audit_entry(entity_table, entity_id);
CREATE INDEX ix_audit_time ON audit_entry(occurred_at DESC);

CREATE TABLE notification_template (
  template_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event       notification_event_enum NOT NULL,
  channel     channel_enum NOT NULL,
  subject     varchar(300) NOT NULL,
  body        text NOT NULL,
  lead_days   int NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  -- allows the 60/30/14 day placement alerts to coexist
  CONSTRAINT uq_template UNIQUE (event, channel, lead_days)
);

CREATE TABLE notification (
  notification_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event        notification_event_enum NOT NULL,
  channel      channel_enum NOT NULL DEFAULT 'EMAIL',
  recipient_user_id uuid REFERENCES app_user(user_id) ON DELETE CASCADE,
  recipient_email varchar(255),
  subject      varchar(300) NOT NULL,
  body         text NOT NULL,
  related_table varchar(60),
  related_id   uuid,
  scheduled_for timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz,
  delivery_outcome varchar(200),
  read_at      timestamptz
);
CREATE INDEX ix_notification_recipient ON notification(recipient_user_id, read_at);
CREATE INDEX ix_notification_pending ON notification(sent_at) WHERE sent_at IS NULL;

CREATE TABLE data_retention_rule (
  rule_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type  varchar(60) NOT NULL UNIQUE,
  retention_months int NOT NULL CHECK (retention_months > 0),
  applies_from_field varchar(60) NOT NULL,
  note         text
);

-- ---------------------------------------------------------------------
-- System configuration (FR-CFG)
-- ---------------------------------------------------------------------
CREATE TABLE system_setting (
  setting_key   varchar(80) PRIMARY KEY,
  setting_value text NOT NULL,
  description   text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES app_user(user_id) ON DELETE SET NULL
);
