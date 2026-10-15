-- =====================================================================
-- Migration 005 — currency allow-list (ISO 4217)
--
-- rate_card.currency and invoice.currency were any three characters. They now
-- reference a table of the currencies the business invoices in: ZAR only, for
-- now. See docs/VALIDATION.md.
--
-- Apply to an existing database as the owner, for example in the Neon SQL
-- Editor. Safe to run twice. Also added to 01_schema.sql.
--
-- Fails, deliberately, if a row already holds a currency not in the list.
-- =====================================================================

CREATE TABLE IF NOT EXISTS currency (
  code        char(3) PRIMARY KEY,
  name        varchar(60) NOT NULL,
  minor_units smallint NOT NULL,
  CONSTRAINT ck_currency_code CHECK (code ~ '^[A-Z]{3}$'),
  CONSTRAINT ck_currency_minor CHECK (minor_units BETWEEN 0 AND 4)
);
INSERT INTO currency (code, name, minor_units) VALUES ('ZAR', 'South African rand', 2)
  ON CONFLICT (code) DO NOTHING;

DO $$ BEGIN
  ALTER TABLE rate_card ADD CONSTRAINT fk_rate_card_currency
    FOREIGN KEY (currency) REFERENCES currency(code);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE invoice ADD CONSTRAINT fk_invoice_currency
    FOREIGN KEY (currency) REFERENCES currency(code);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The blanket grant in 02_security.sql ran before this table existed. Read
-- only: the list changes by migration, not through the application.
GRANT SELECT ON currency TO rasibe_app;
