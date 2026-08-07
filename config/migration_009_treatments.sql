-- ============================================
-- Migration 009: treatments catalog + doctor-scoping support
-- Run once against an existing database, in order after migration_008.
-- ============================================

-- A fixed-price procedure a doctor can bill in one click (e.g. "Teeth
-- whitening — 1500", "Tooth extraction — 2000"). Kept deliberately separate
-- from ad-hoc consultation charges — this is the *catalog*, not a record of
-- what was actually done. Admin manages it; doctors just pick from it.
CREATE TABLE IF NOT EXISTS treatments (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    price NUMERIC(10,2) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE, -- soft delete — never hard-deleted, so past
                                     -- references to a treatment's name/price
                                     -- (already copied onto invoice_items at the
                                     -- time it was billed) are never orphaned
    created_at TIMESTAMP DEFAULT NOW()
);

-- The "recipe" — what a treatment consumes from inventory when performed.
-- Selecting a treatment on the consultation form auto-fills both the charge
-- (from treatments.price) and this usage (from here) — see routes/appointments.js,
-- which already accepted a generic items_used[] array before this migration
-- and needs no changes; the frontend just populates it from this recipe.
CREATE TABLE IF NOT EXISTS treatment_items (
    id SERIAL PRIMARY KEY,
    treatment_id INTEGER NOT NULL REFERENCES treatments(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    quantity NUMERIC(10,2) NOT NULL DEFAULT 1,
    UNIQUE(treatment_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_treatment_items_treatment ON treatment_items(treatment_id);
