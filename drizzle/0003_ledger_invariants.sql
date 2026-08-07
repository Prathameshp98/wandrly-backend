-- Ledger invariants, search indexes, and deferred constraints.
-- TECHNICAL_DESIGN §5.3, §5.9, §5.10. Runs AFTER the generated schema migration.
--
-- This file is the reason a wrong balance is structurally impossible rather than
-- merely unlikely: the four sums below are checked by the database at COMMIT, so
-- no application bug can persist an unbalanced expense.

-- ─────────────────────────────────────────────────────────────────────
-- 1. Deferred day renumbering
-- ─────────────────────────────────────────────────────────────────────
-- Deleting day 2 of 5 requires renumbering 3,4,5 → 2,3,4. Doing that in one
-- UPDATE transiently collides on (variant_id, day_number), so the uniqueness
-- must be deferred to commit time.

DROP INDEX IF EXISTS days_variant_number_uq;

ALTER TABLE days
  ADD CONSTRAINT days_variant_number_uq
  UNIQUE (variant_id, day_number) DEFERRABLE INITIALLY DEFERRED;

-- ─────────────────────────────────────────────────────────────────────
-- 2. The expense balance invariant  (FR-SPLIT-17, FR-SPLIT-18)
-- ─────────────────────────────────────────────────────────────────────
-- Four sums must hold for every expense, in BOTH currencies:
--   SUM(shares.share_amount_minor)       = expenses.amount_minor
--   SUM(shares.share_amount_base_minor)  = expenses.amount_base_minor
--   SUM(payments.amount_minor)           = expenses.amount_minor
--   SUM(payments.amount_base_minor)      = expenses.amount_base_minor
--
-- Base-currency amounts are stored per row precisely so this can be asserted.
-- Converting each share at read time would break it, because the sum of rounded
-- values is not the rounded sum.

CREATE OR REPLACE FUNCTION assert_expense_balanced() RETURNS TRIGGER AS $$
DECLARE
  target_id        UUID;
  expense_total    BIGINT;
  expense_base     BIGINT;
  shares_total     BIGINT;
  shares_base      BIGINT;
  payments_total   BIGINT;
  payments_base    BIGINT;
BEGIN
  target_id := COALESCE(NEW.expense_id, OLD.expense_id);

  SELECT amount_minor, amount_base_minor
    INTO expense_total, expense_base
    FROM expenses
   WHERE id = target_id
     AND deleted_at IS NULL;

  -- Expense gone (or soft-deleted): nothing to assert.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM(share_amount_minor), 0),
         COALESCE(SUM(share_amount_base_minor), 0)
    INTO shares_total, shares_base
    FROM expense_shares
   WHERE expense_id = target_id;

  SELECT COALESCE(SUM(amount_minor), 0),
         COALESCE(SUM(amount_base_minor), 0)
    INTO payments_total, payments_base
    FROM expense_payments
   WHERE expense_id = target_id;

  IF shares_total <> expense_total THEN
    RAISE EXCEPTION
      'expense %: shares (%) do not sum to expense total (%)',
      target_id, shares_total, expense_total
      USING ERRCODE = 'check_violation';
  END IF;

  IF shares_base <> expense_base THEN
    RAISE EXCEPTION
      'expense %: base-currency shares (%) do not sum to base total (%)',
      target_id, shares_base, expense_base
      USING ERRCODE = 'check_violation';
  END IF;

  IF payments_total <> expense_total THEN
    RAISE EXCEPTION
      'expense %: payments (%) do not sum to expense total (%)',
      target_id, payments_total, expense_total
      USING ERRCODE = 'check_violation';
  END IF;

  IF payments_base <> expense_base THEN
    RAISE EXCEPTION
      'expense %: base-currency payments (%) do not sum to base total (%)',
      target_id, payments_base, expense_base
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_shares_balanced ON expense_shares;
CREATE CONSTRAINT TRIGGER trg_shares_balanced
  AFTER INSERT OR UPDATE OR DELETE ON expense_shares
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_expense_balanced();

DROP TRIGGER IF EXISTS trg_payments_balanced ON expense_payments;
CREATE CONSTRAINT TRIGGER trg_payments_balanced
  AFTER INSERT OR UPDATE OR DELETE ON expense_payments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_expense_balanced();

-- ─────────────────────────────────────────────────────────────────────
-- 3. Audit log is append-only  (FR-NFR-SEC-12)
-- ─────────────────────────────────────────────────────────────────────
-- The application role holds no UPDATE or DELETE grant. Enforced with triggers
-- too, so it holds even if grants are misconfigured on a new environment.

CREATE OR REPLACE FUNCTION reject_activity_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'activity_events is append-only'
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_activity_append_only ON activity_events;
CREATE TRIGGER trg_activity_append_only
  BEFORE UPDATE OR DELETE ON activity_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_activity_mutation();

-- ─────────────────────────────────────────────────────────────────────
-- 4. Full-text search  (FR-SRCH-05, FR-SRCH-06)
-- ─────────────────────────────────────────────────────────────────────
-- 'simple' config, not 'english': itinerary content is dominated by proper
-- nouns (Kiyomizu-dera, Arashiyama, Yoshida-sanso) that English stemming
-- mangles for no benefit. Generated columns mean no trigger to maintain.

ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title,       '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(destination, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(subtitle,    '')), 'C')
  ) STORED;

CREATE INDEX IF NOT EXISTS trips_search_idx ON trips USING GIN (search_tsv);

ALTER TABLE blocks
  ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(meta,  '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(notes, '')), 'C')
  ) STORED;

CREATE INDEX IF NOT EXISTS blocks_search_idx ON blocks USING GIN (search_tsv);

-- Name matching for people is a cheap ILIKE, not full-text: names are short.
CREATE INDEX IF NOT EXISTS participants_name_idx
  ON trip_participants (lower(display_name));

-- ─────────────────────────────────────────────────────────────────────
-- 5. Deferred FK for trips.main_variant_id
-- ─────────────────────────────────────────────────────────────────────
-- `variants` does not exist when `trips` is created, so the constraint is added
-- here (§5.7 migration ordering).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'trips_main_variant_fk'
  ) THEN
    -- DEFERRABLE because trips.main_variant_id <-> variants.trip_id is a true
    -- cycle: neither row can be inserted first. Deferring to commit lets the
    -- trips service create both inside one transaction, in any order.
    ALTER TABLE trips
      ADD CONSTRAINT trips_main_variant_fk
      FOREIGN KEY (main_variant_id) REFERENCES variants(id) ON DELETE SET NULL
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────
-- 6. Self-referencing FKs added after table creation
-- ─────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'variants_forked_from_fk'
  ) THEN
    ALTER TABLE variants
      ADD CONSTRAINT variants_forked_from_fk
      FOREIGN KEY (forked_from_id) REFERENCES variants(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'comments_parent_fk'
  ) THEN
    ALTER TABLE comments
      ADD CONSTRAINT comments_parent_fk
      FOREIGN KEY (parent_comment_id) REFERENCES comments(id) ON DELETE CASCADE;
  END IF;
END $$;
