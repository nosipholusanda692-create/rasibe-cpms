-- =====================================================================
-- 04_seed.sql — reference data and a demonstration data set
-- The people, clients and figures mirror the approved prototype screens
-- so the running system shows the same content the client reviewed.
-- Passwords are bcrypt via pgcrypto and verify against bcryptjs in the API.
-- =====================================================================

-- ---------------------------------------------------------------------
-- System settings (FR-CFG)
-- ---------------------------------------------------------------------
INSERT INTO system_setting (setting_key, setting_value, description) VALUES
 ('company_name',            'Rasibe Global Solutions', 'Name printed on invoices'),
 ('company_registration',    '2025/123456/07',          'Company registration number'),
 ('company_bank',            'FNB — Acc 62012345678',   'Banking details printed on invoices'),
 ('vat_registered',          'false',                   'Client is not currently registered for VAT'),
 ('vat_rate',                '0',                       'Applied only when vat_registered is true'),
 ('timesheet_cycle',         'WEEKLY',                  'Monday to Sunday'),
 ('week_starts_on',          'MONDAY',                  'First day of the timesheet period'),
 ('timesheet_due_day',       'MONDAY',                  'Submission expected the Monday following'),
 ('reminder_lead_hours',     '48',                      'First reminder before the due time'),
 ('approval_escalation_hours','72',                     'Escalate to the administrator after this'),
 ('max_hours_per_day',       '16',                      'BR-016 ceiling'),
 ('placement_alert_days',    '60,30,14',                'Placement ending alert thresholds'),
 ('candidate_retention_months','12',                    'Unplaced candidate retention'),
 ('financial_retention_years','5',                      'Financial record retention'),
 ('invoice_prefix',          'INV-',                    'Invoice number prefix');

INSERT INTO data_retention_rule (entity_type, retention_months, applies_from_field, note) VALUES
 ('consultant_unplaced', 12, 'created_at', 'Deleted or anonymised unless the consultant consents to longer'),
 ('invoice',             60, 'issued_at',  'Financial record, five-year retention'),
 ('timesheet',           60, 'approved_at','Supports the invoice, five-year retention');

-- ---------------------------------------------------------------------
-- Capabilities
-- ---------------------------------------------------------------------
INSERT INTO role_capability (role, capability) VALUES
 ('ADMINISTRATOR','view_margin'), ('ADMINISTRATOR','issue_invoice'),
 ('ADMINISTRATOR','approve_rate'), ('ADMINISTRATOR','override_approval'),
 ('ADMINISTRATOR','view_banking'), ('ADMINISTRATOR','view_vetting'),
 ('ADMINISTRATOR','manage_users'), ('ADMINISTRATOR','view_audit'),
 ('ADMINISTRATOR','manage_catalogue'), ('ADMINISTRATOR','manage_settings'),
 ('RECRUITER','manage_catalogue'), ('RECRUITER','manage_consultants'),
 ('RECRUITER','manage_clients'), ('RECRUITER','submit_candidate'),
 ('RECRUITER','create_placement'), ('RECRUITER','view_reports'),
 ('CONSULTANT','submit_timesheet'), ('CONSULTANT','manage_own_profile'),
 ('CLIENT_MANAGER','raise_request'), ('CLIENT_MANAGER','review_candidates'),
 ('CLIENT_MANAGER','approve_timesheet');

-- ---------------------------------------------------------------------
-- Notification templates (the 60/30/14 alerts coexist by lead_days)
-- ---------------------------------------------------------------------
INSERT INTO notification_template (event, channel, subject, body, lead_days) VALUES
 ('TIMESHEET_DUE','EMAIL','Your timesheet for {{week}} is due','Hello {{name}}, your timesheet for {{week}} is due on {{due}}.',0),
 ('TIMESHEET_OVERDUE','EMAIL','Timesheet overdue — {{week}}','Hello {{name}}, your timesheet for {{week}} is overdue.',0),
 ('TIMESHEET_AWAITING_APPROVAL','EMAIL','Approval needed: {{consultant}} — {{week}}','{{consultant}} has submitted {{hours}} hours for {{week}}. Please approve or reject.',0),
 ('TIMESHEET_APPROVED','EMAIL','Timesheet approved — {{week}}','Your timesheet for {{week}} has been approved.',0),
 ('TIMESHEET_REJECTED','EMAIL','Timesheet returned — {{week}}','Your timesheet for {{week}} was returned. Reason: {{reason}}',0),
 ('INVOICE_ISSUED','EMAIL','Invoice {{number}} from Rasibe Global Solutions','Invoice {{number}} for {{period}}, total {{total}}, due {{due}}.',0),
 ('REQUEST_RAISED','EMAIL','New role request: {{title}}','{{client}} has raised a request for {{title}}.',0),
 ('SUBMISSION_OUTCOME','EMAIL','Update on your submission to {{client}}','Your submission for {{title}} is now {{outcome}}.',0),
 ('PLACEMENT_ENDING','EMAIL','Placement ending in 60 days — {{consultant}}','{{consultant}} at {{client}} ends on {{end}}.',60),
 ('PLACEMENT_ENDING','EMAIL','Placement ending in 30 days — {{consultant}}','{{consultant}} at {{client}} ends on {{end}}.',30),
 ('PLACEMENT_ENDING','EMAIL','Placement ending in 14 days — {{consultant}}','{{consultant}} at {{client}} ends on {{end}}.',14),
 ('DOCUMENT_EXPIRING','EMAIL','Document expiring — {{document}}','{{document}} for {{name}} expires on {{expires}}.',30),
 ('ACCOUNT_CREATED','EMAIL','Your Rasibe account','An account has been created for you. Set your password using the link provided.',0),
 ('PASSWORD_RESET','EMAIL','Reset your Rasibe password','Use the link to set a new password. It expires in one hour.',0);

-- ---------------------------------------------------------------------
-- Skills
-- ---------------------------------------------------------------------
INSERT INTO skill (skill_id, name, category) VALUES
 ('a0000001-0000-0000-0000-000000000001','Java','Development'),
 ('a0000001-0000-0000-0000-000000000002','Spring Boot','Development'),
 ('a0000001-0000-0000-0000-000000000003','Apache Kafka','Integration'),
 ('a0000001-0000-0000-0000-000000000004','Oracle SQL','Data'),
 ('a0000001-0000-0000-0000-000000000005','C#','Development'),
 ('a0000001-0000-0000-0000-000000000006','React','Development'),
 ('a0000001-0000-0000-0000-000000000007','Test Automation','Quality'),
 ('a0000001-0000-0000-0000-000000000008','Manual Testing','Quality'),
 ('a0000001-0000-0000-0000-000000000009','Business Analysis','Analysis'),
 ('a0000001-0000-0000-0000-00000000000a','Azure','Infrastructure'),
 ('a0000001-0000-0000-0000-00000000000b','Kubernetes','Infrastructure'),
 ('a0000001-0000-0000-0000-00000000000c','Service Desk','Support'),
 ('a0000001-0000-0000-0000-00000000000d','Python','Development'),
 ('a0000001-0000-0000-0000-00000000000e','Power BI','Data');

-- ---------------------------------------------------------------------
-- Users. Demonstration password for every account: Password123!
-- ---------------------------------------------------------------------
INSERT INTO app_user (user_id, email, full_name, phone, password_hash) VALUES
 ('b0000001-0000-0000-0000-000000000001','christinah@rasibe.co.za','Christinah Rasibe','+27 82 000 0001', crypt('Password123!', gen_salt('bf',10))),
 ('b0000001-0000-0000-0000-000000000002','nosipho@rasibe.co.za','Nosipho','+27 82 000 0002', crypt('Password123!', gen_salt('bf',10))),
 ('b0000001-0000-0000-0000-000000000003','thabo.m@example.co.za','Thabo Mokoena','+27 82 000 0003', crypt('Password123!', gen_salt('bf',10))),
 ('b0000001-0000-0000-0000-000000000004','s.naidoo@nedgroupit.co.za','Sipho Naidoo','+27 82 000 0004', crypt('Password123!', gen_salt('bf',10))),
 ('b0000001-0000-0000-0000-000000000005','m.botha@shopritedigital.co.za','Marius Botha','+27 82 000 0005', crypt('Password123!', gen_salt('bf',10))),
 ('b0000001-0000-0000-0000-000000000006','l.vanwyk@example.co.za','Liesl van Wyk','+27 82 000 0006', crypt('Password123!', gen_salt('bf',10)));

INSERT INTO user_role (user_id, role) VALUES
 ('b0000001-0000-0000-0000-000000000001','ADMINISTRATOR'),
 ('b0000001-0000-0000-0000-000000000002','RECRUITER'),
 ('b0000001-0000-0000-0000-000000000003','CONSULTANT'),
 ('b0000001-0000-0000-0000-000000000004','CLIENT_MANAGER'),
 ('b0000001-0000-0000-0000-000000000005','CLIENT_MANAGER'),
 ('b0000001-0000-0000-0000-000000000006','CONSULTANT');

-- ---------------------------------------------------------------------
-- Client companies and contacts
-- ---------------------------------------------------------------------
INSERT INTO client_company (client_id, legal_name, registration_number, vat_number, trading_name, industry, billing_address, payment_terms_days) VALUES
 ('c0000001-0000-0000-0000-000000000001','Nedgroup IT (Pty) Ltd','2001/000111/07','4110111222','Nedgroup IT','Financial services','135 Rivonia Road, Sandton, 2196',30),
 ('c0000001-0000-0000-0000-000000000002','Shoprite Digital (Pty) Ltd','2004/000222/07','4110222333','Shoprite Digital','Retail','Brackenfell, Cape Town, 7560',45),
 ('c0000001-0000-0000-0000-000000000003','Gauteng Health Services','2010/000333/07',NULL,'Gauteng Health','Public sector','45 Commissioner Street, Johannesburg, 2001',60),
 ('c0000001-0000-0000-0000-000000000004','Capitec Labs (Pty) Ltd','2015/000444/07','4110444555','Capitec Labs','Financial services','5 Neutron Road, Stellenbosch, 7600',30);

INSERT INTO client_contact (contact_id, client_id, user_id, first_name, last_name, job_title, email, phone, is_timesheet_approver, is_primary) VALUES
 ('d0000001-0000-0000-0000-000000000001','c0000001-0000-0000-0000-000000000001','b0000001-0000-0000-0000-000000000004','Sipho','Naidoo','Delivery Manager','s.naidoo@nedgroupit.co.za','+27 82 000 0004',true,true),
 ('d0000001-0000-0000-0000-000000000002','c0000001-0000-0000-0000-000000000002','b0000001-0000-0000-0000-000000000005','Marius','Botha','Head of Engineering','m.botha@shopritedigital.co.za','+27 82 000 0005',true,true),
 ('d0000001-0000-0000-0000-000000000003','c0000001-0000-0000-0000-000000000003',NULL,'Kagiso','Sithole','Programme Manager','k.sithole@gautenghealth.gov.za','+27 82 000 0007',true,true),
 ('d0000001-0000-0000-0000-000000000004','c0000001-0000-0000-0000-000000000004',NULL,'Anele','Mbeki','CTO','a.mbeki@capiteclabs.co.za','+27 82 000 0008',true,true);

INSERT INTO rate_card (rate_card_id, client_id, name, effective_from) VALUES
 ('e0000001-0000-0000-0000-000000000001','c0000001-0000-0000-0000-000000000001','Nedgroup IT 2026','2026-01-01'),
 ('e0000001-0000-0000-0000-000000000002','c0000001-0000-0000-0000-000000000002','Shoprite Digital 2026','2026-01-01');

INSERT INTO rate_card_line (rate_card_id, seniority, min_bill_rate, max_bill_rate) VALUES
 ('e0000001-0000-0000-0000-000000000001','SENIOR',850,1050),
 ('e0000001-0000-0000-0000-000000000001','INTERMEDIATE',600,820),
 ('e0000001-0000-0000-0000-000000000002','SENIOR',800,980),
 ('e0000001-0000-0000-0000-000000000002','INTERMEDIATE',560,780);

-- ---------------------------------------------------------------------
-- Consultant pool
-- ---------------------------------------------------------------------
INSERT INTO consultant (consultant_id, user_id, full_name, preferred_name, id_number, date_of_birth, email, mobile,
                        location, nationality, right_to_work, seniority, headline, experience_years,
                        availability, available_from, min_pay_rate, preferred_pay_rate,
                        vetting_status, vetting_cleared_on, bank_name, bank_account_ref,
                        consent_recorded_at, retention_expires_on) VALUES
 ('f0000001-0000-0000-0000-000000000001','b0000001-0000-0000-0000-000000000003','Thabo Sipho Mokoena','Thabo','9107045000000','1991-07-04','thabo.m@example.co.za','+27 82 000 0003',
  'Midrand, Gauteng','South African','Citizen — no permit required','SENIOR',
  'Senior Java developer specialising in enterprise microservices and event-driven systems',9,
  'ON_PLACEMENT','2026-09-12',560,620,'Cleared','2026-03-11','FNB','****4417', now(), '2027-08-31'),
 ('f0000001-0000-0000-0000-000000000002','b0000001-0000-0000-0000-000000000006','Liesl van Wyk','Liesl','8804125000000','1988-04-12','l.vanwyk@example.co.za','+27 82 000 0006',
  'Bellville, Western Cape','South African','Citizen — no permit required','INTERMEDIATE',
  'Test analyst with strong automation and regression experience',7,
  'ON_PLACEMENT',NULL,480,540,'Cleared','2026-02-20','Standard Bank','****9902', now(), '2027-08-31'),
 ('f0000001-0000-0000-0000-000000000003',NULL,'Palesa Dlamini','Palesa',NULL,NULL,'p.dlamini@example.co.za','+27 82 000 0009',
  'Sandton, Gauteng','South African','Citizen — no permit required','SENIOR',
  'Business analyst experienced in public sector health programmes',11,
  'ON_PLACEMENT',NULL,520,600,'Cleared','2026-04-02',NULL,NULL, now(), '2027-08-31'),
 ('f0000001-0000-0000-0000-000000000004',NULL,'Ashwin Pillay','Ashwin',NULL,NULL,'a.pillay@example.co.za','+27 82 000 0010',
  'Durban, KwaZulu-Natal','South African','Citizen — no permit required','INTERMEDIATE',
  'Infrastructure engineer, Azure and Kubernetes',6,
  'ON_PLACEMENT',NULL,500,560,'Cleared','2026-05-15',NULL,NULL, now(), '2027-08-31'),
 ('f0000001-0000-0000-0000-000000000005',NULL,'Mpho September','Mpho',NULL,NULL,'m.september@example.co.za','+27 82 000 0011',
  'Centurion, Gauteng','South African','Citizen — no permit required','INTERMEDIATE',
  'Full stack developer, C# and React',5,
  'ON_PLACEMENT',NULL,470,530,'Cleared','2026-06-01',NULL,NULL, now(), '2027-08-31'),
 ('f0000001-0000-0000-0000-000000000006',NULL,'Jabulani Khumalo','Jabulani',NULL,NULL,'j.khumalo@example.co.za','+27 82 000 0012',
  'Cape Town, Western Cape','South African','Citizen — no permit required','JUNIOR',
  'Support engineer, service desk and first line',3,
  'ON_PLACEMENT',NULL,320,380,'Cleared','2026-06-18',NULL,NULL, now(), '2027-08-31'),
 ('f0000001-0000-0000-0000-000000000007',NULL,'Refilwe Ndlovu','Refilwe',NULL,NULL,'r.ndlovu@example.co.za','+27 82 000 0013',
  'Pretoria, Gauteng','South African','Citizen — no permit required','SENIOR',
  'Data engineer, Python and Power BI',8,
  'AVAILABLE',NULL,540,610,'Pending',NULL,NULL,NULL, now(), '2027-08-31'),
 ('f0000001-0000-0000-0000-000000000008',NULL,'Sarah Adams','Sarah',NULL,NULL,'s.adams@example.co.za','+27 82 000 0014',
  'Johannesburg, Gauteng','South African','Citizen — no permit required','LEAD',
  'Lead engineer, distributed systems and platform architecture',14,
  'AVAILABLE_FROM','2026-10-01',700,800,'Cleared','2026-07-01',NULL,NULL, now(), '2027-08-31');

INSERT INTO consultant_skill (consultant_id, skill_id, proficiency, years, last_used_year, is_primary) VALUES
 ('f0000001-0000-0000-0000-000000000001','a0000001-0000-0000-0000-000000000001','EXPERT',9,2026,true),
 ('f0000001-0000-0000-0000-000000000001','a0000001-0000-0000-0000-000000000002','ADVANCED',6,2026,false),
 ('f0000001-0000-0000-0000-000000000001','a0000001-0000-0000-0000-000000000003','INTERMEDIATE',3,2025,false),
 ('f0000001-0000-0000-0000-000000000001','a0000001-0000-0000-0000-000000000004','ADVANCED',7,2026,false),
 ('f0000001-0000-0000-0000-000000000002','a0000001-0000-0000-0000-000000000007','ADVANCED',5,2026,true),
 ('f0000001-0000-0000-0000-000000000002','a0000001-0000-0000-0000-000000000008','EXPERT',7,2026,false),
 ('f0000001-0000-0000-0000-000000000003','a0000001-0000-0000-0000-000000000009','EXPERT',11,2026,true),
 ('f0000001-0000-0000-0000-000000000004','a0000001-0000-0000-0000-00000000000a','ADVANCED',6,2026,true),
 ('f0000001-0000-0000-0000-000000000004','a0000001-0000-0000-0000-00000000000b','INTERMEDIATE',4,2026,false),
 ('f0000001-0000-0000-0000-000000000005','a0000001-0000-0000-0000-000000000005','ADVANCED',5,2026,true),
 ('f0000001-0000-0000-0000-000000000005','a0000001-0000-0000-0000-000000000006','ADVANCED',4,2026,false),
 ('f0000001-0000-0000-0000-000000000006','a0000001-0000-0000-0000-00000000000c','INTERMEDIATE',3,2026,true),
 ('f0000001-0000-0000-0000-000000000007','a0000001-0000-0000-0000-00000000000d','EXPERT',8,2026,true),
 ('f0000001-0000-0000-0000-000000000007','a0000001-0000-0000-0000-00000000000e','ADVANCED',5,2026,false),
 ('f0000001-0000-0000-0000-000000000008','a0000001-0000-0000-0000-000000000001','EXPERT',14,2026,true),
 ('f0000001-0000-0000-0000-000000000008','a0000001-0000-0000-0000-00000000000b','ADVANCED',6,2026,false);

INSERT INTO certification (consultant_id, name, issuing_body, issued_on, expires_on) VALUES
 ('f0000001-0000-0000-0000-000000000001','Oracle Certified Professional','Oracle','2021-06-30','2028-06-30'),
 ('f0000001-0000-0000-0000-000000000001','AWS Solutions Architect','Amazon Web Services','2023-02-12','2026-02-12'),
 ('f0000001-0000-0000-0000-000000000002','ISTQB Foundation','ISTQB','2020-09-04','2026-09-04'),
 ('f0000001-0000-0000-0000-000000000004','Azure Administrator Associate','Microsoft','2024-05-20','2027-05-20');

-- ---------------------------------------------------------------------
-- Role requests
-- ---------------------------------------------------------------------
INSERT INTO resource_request (request_id, reference, client_id, contact_id, raised_by, title, description,
                              seniority, engagement_type, work_mode, location, quantity, start_date,
                              duration_months, budget_rate, status) VALUES
 ('11110001-0000-0000-0000-000000000001','REQ-1001','c0000001-0000-0000-0000-000000000004','d0000001-0000-0000-0000-000000000004',NULL,
  'Senior Java developer','Enterprise microservices on the payments platform.','SENIOR','FULL_TIME','HYBRID','Stellenbosch',1,'2026-09-01',6,1000,'SHORTLISTING'),
 ('11110001-0000-0000-0000-000000000002','REQ-1002','c0000001-0000-0000-0000-000000000002','d0000001-0000-0000-0000-000000000002',NULL,
  'Test analyst','Regression and automation for the e-commerce release train.','INTERMEDIATE','FULL_TIME','ON_SITE','Cape Town',2,'2026-09-15',3,820,'SHORTLISTING'),
 ('11110001-0000-0000-0000-000000000003','REQ-1003','c0000001-0000-0000-0000-000000000003','d0000001-0000-0000-0000-000000000003',NULL,
  'Business analyst','Health information systems programme.','SENIOR','CONTRACT','ON_SITE','Johannesburg',1,'2026-10-01',12,900,'OPEN'),
 ('11110001-0000-0000-0000-000000000004','REQ-1004','c0000001-0000-0000-0000-000000000001','d0000001-0000-0000-0000-000000000001',NULL,
  'DevOps engineer','Container platform and pipeline work.','INTERMEDIATE','FULL_TIME','REMOTE','Remote',1,'2026-09-22',6,880,'INTERVIEWING');

INSERT INTO request_skill (request_id, skill_id, is_mandatory, min_proficiency, min_years) VALUES
 ('11110001-0000-0000-0000-000000000001','a0000001-0000-0000-0000-000000000001',true,'ADVANCED',5),
 ('11110001-0000-0000-0000-000000000001','a0000001-0000-0000-0000-000000000002',false,'INTERMEDIATE',3),
 ('11110001-0000-0000-0000-000000000002','a0000001-0000-0000-0000-000000000007',true,'ADVANCED',3),
 ('11110001-0000-0000-0000-000000000003','a0000001-0000-0000-0000-000000000009',true,'EXPERT',8),
 ('11110001-0000-0000-0000-000000000004','a0000001-0000-0000-0000-00000000000b',true,'INTERMEDIATE',3);

-- ---------------------------------------------------------------------
-- Submissions and placements
-- ---------------------------------------------------------------------
INSERT INTO submission (submission_id, request_id, consultant_id, submitted_by, proposed_bill_rate, proposed_pay_rate, outcome, consent_reference) VALUES
 ('22220001-0000-0000-0000-000000000001','11110001-0000-0000-0000-000000000001','f0000001-0000-0000-0000-000000000008','b0000001-0000-0000-0000-000000000002',1000,700,'SHORTLISTED', gen_random_uuid()),
 ('22220001-0000-0000-0000-000000000002','11110001-0000-0000-0000-000000000001','f0000001-0000-0000-0000-000000000007','b0000001-0000-0000-0000-000000000002',960,610,'SUBMITTED', gen_random_uuid()),
 ('22220001-0000-0000-0000-000000000003','11110001-0000-0000-0000-000000000004','f0000001-0000-0000-0000-000000000004','b0000001-0000-0000-0000-000000000002',880,540,'INTERVIEWING', gen_random_uuid());

INSERT INTO placement (placement_id, reference, consultant_id, client_id, approver_contact_id, job_title,
                       engagement_type, work_mode, start_date, end_date, bill_rate, pay_rate,
                       status, rate_approved_by, rate_approved_at) VALUES
 ('33330001-0000-0000-0000-000000000001','PLC-2001','f0000001-0000-0000-0000-000000000001','c0000001-0000-0000-0000-000000000001','d0000001-0000-0000-0000-000000000001',
  'Senior Java developer','FULL_TIME','HYBRID','2026-03-02','2026-09-12',950,620,'ENDING_SOON','b0000001-0000-0000-0000-000000000001', now()),
 ('33330001-0000-0000-0000-000000000002','PLC-2002','f0000001-0000-0000-0000-000000000002','c0000001-0000-0000-0000-000000000002','d0000001-0000-0000-0000-000000000002',
  'Test analyst','FULL_TIME','ON_SITE','2026-04-01','2026-09-30',780,520,'ENDING_SOON','b0000001-0000-0000-0000-000000000001', now()),
 ('33330001-0000-0000-0000-000000000003','PLC-2003','f0000001-0000-0000-0000-000000000003','c0000001-0000-0000-0000-000000000003','d0000001-0000-0000-0000-000000000003',
  'Business analyst','CONTRACT','ON_SITE','2026-02-01','2026-10-31',900,600,'ACTIVE','b0000001-0000-0000-0000-000000000001', now()),
 ('33330001-0000-0000-0000-000000000004','PLC-2004','f0000001-0000-0000-0000-000000000004','c0000001-0000-0000-0000-000000000001','d0000001-0000-0000-0000-000000000001',
  'Infrastructure engineer','FULL_TIME','REMOTE','2026-05-04','2026-11-15',860,540,'ACTIVE','b0000001-0000-0000-0000-000000000001', now()),
 ('33330001-0000-0000-0000-000000000005','PLC-2005','f0000001-0000-0000-0000-000000000005','c0000001-0000-0000-0000-000000000001','d0000001-0000-0000-0000-000000000001',
  'Full stack developer','FULL_TIME','HYBRID','2026-06-01','2026-12-31',820,510,'ACTIVE','b0000001-0000-0000-0000-000000000001', now()),
 ('33330001-0000-0000-0000-000000000006','PLC-2006','f0000001-0000-0000-0000-000000000006','c0000001-0000-0000-0000-000000000002','d0000001-0000-0000-0000-000000000002',
  'Support engineer','FULL_TIME','ON_SITE','2026-07-01','2027-01-31',620,380,'ACTIVE','b0000001-0000-0000-0000-000000000001', now());

-- documents
INSERT INTO document (consultant_id, doc_type, file_name, storage_key, mime_type, size_bytes, is_restricted, expires_on, uploaded_by) VALUES
 ('f0000001-0000-0000-0000-000000000001','CV','CV - Mokoena.pdf','consultants/f0000001/cv-v3.pdf','application/pdf',284100,false,NULL,'b0000001-0000-0000-0000-000000000002'),
 ('f0000001-0000-0000-0000-000000000001','VETTING','Police clearance.pdf','consultants/f0000001/vetting.pdf','application/pdf',115200,true,'2027-03-11','b0000001-0000-0000-0000-000000000001'),
 ('f0000001-0000-0000-0000-000000000002','CV','CV - van Wyk.pdf','consultants/f0000002/cv-v2.pdf','application/pdf',201400,false,NULL,'b0000001-0000-0000-0000-000000000002');
