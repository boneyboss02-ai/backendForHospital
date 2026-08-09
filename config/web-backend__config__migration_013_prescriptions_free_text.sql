-- ============================================
-- Migration 013: prescriptions no longer require an inventory item
-- Run once against an existing database, in order after migration_012.
-- ============================================

-- Prescriptions are pure documentation — the doctor writes what the
-- patient should take, the patient sees it in their portal, and either
-- fills it at an outside pharmacy or not; the clinic never dispenses it.
-- Requiring medicine_id to point at an `inventory_items` row was left over
-- from before the pharmacist role was retired (migration_005_inventory.sql),
-- and it's actively wrong now: inventory means physical clinic supplies
-- that get consumed and costed against a treatment (see treatment_items /
-- inventory_usage) — a doctor should be able to prescribe "Amoxicillin
-- 500mg" whether or not that happens to also be a stocked supply item.
ALTER TABLE prescription_items ADD COLUMN IF NOT EXISTS medicine_name VARCHAR(200);

-- Backfill from whatever inventory item old rows pointed at, so existing
-- prescriptions keep showing a name after this migration.
UPDATE prescription_items pi
SET medicine_name = i.name
FROM inventory_items i
WHERE pi.medicine_id = i.id AND pi.medicine_name IS NULL;

-- Anything that still ended up without a name (shouldn't happen, but a
-- dropped inventory item could have left one behind) gets a placeholder
-- rather than a blank — never silently lose what was prescribed.
UPDATE prescription_items SET medicine_name = '(unspecified)' WHERE medicine_name IS NULL;

ALTER TABLE prescription_items ALTER COLUMN medicine_name SET NOT NULL;

-- medicine_id and its FK to inventory_items are dropped outright, not just
-- made optional — keeping a stale, no-longer-enforced link back to a
-- table that has nothing to do with prescriptions would just confuse the
-- next person reading this schema.
ALTER TABLE prescription_items DROP COLUMN IF EXISTS medicine_id;
