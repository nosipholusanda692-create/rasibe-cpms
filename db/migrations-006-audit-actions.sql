-- =====================================================================
-- Migration 006 — audit actions for settings, invoice approval, payments
--
-- NFR-SEC-011 asks for an audit entry on every financially significant
-- action. Three were not recorded: changing a setting (VAT rate, company
-- banking details), approving an invoice, and recording a payment against one.
-- See docs/SECURITY-CONTROLS.md.
--
-- Apply to an existing database as the owner, for example in the Neon SQL
-- Editor or with:
--   psql -U postgres -d rasibe -f migrations-006-audit-actions.sql
--
-- Safe to run twice. Also added to 01_schema.sql, so a rebuild needs nothing.
-- Run it BEFORE deploying the API that writes these actions, or approving an
-- invoice will fail until it has been run.
-- =====================================================================

ALTER TYPE audit_action_enum ADD VALUE IF NOT EXISTS 'SETTING_CHANGED';
ALTER TYPE audit_action_enum ADD VALUE IF NOT EXISTS 'INVOICE_APPROVED';
ALTER TYPE audit_action_enum ADD VALUE IF NOT EXISTS 'PAYMENT_RECORDED';
