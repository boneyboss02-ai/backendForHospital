-- ============================================
-- Migration 014: branches (step 1 of the multi-branch rollout)
-- Run once against an existing database, in order after migration_013.
--
-- Design (agreed with the client):
--  - patients are shared across all branches — no branch_id on patients.
--  - treatments (the price/recipe catalog) are clinic-wide — no branch_id.
--  - every staff member belongs to exactly ONE branch (users.branch_id).
--  - "branch admin" and "general admin" are the SAME role ('admin') —
--    distinguished only by whether branch_id is NULL (general admin, sees
--    every branch) or set (branch admin, scoped to that one branch). This
--    means every existing authorize('admin', ...) check in the codebase
--    keeps working unchanged; branch scoping is an additional filter
--    layered inside each route, not a new permission level.
--  - wards (physical rooms) belong to a branch; beds/admissions inherit
--    it through ward_id, so they don't need their own branch_id.
--  - shifts/shift_patterns inherit a branch through the staff member's
--    own branch_id, so no branch_id needed there either.
--
-- Safe on existing data: everything gets backfilled into one "Main
-- Branch" so nothing breaks or goes invisible the moment this runs.
-- Existing admin accounts are left as general admins (branch_id NULL) —
-- since there's only been one branch until now, that's the safest default;
-- promote/demote specific admins to a branch afterward as needed.
-- ============================================

CREATE TABLE IF NOT EXISTS branches (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    address VARCHAR(255),
    phone VARCHAR(20),
    created_at TIMESTAMP DEFAULT NOW()
);

-- The branch every existing record gets assigned to, so this migration is
-- a no-op from the user's point of view — same data, same visibility,
-- just now labeled as belonging to one branch instead of implicitly "the
-- only one there is".
INSERT INTO branches (name)
SELECT 'Main Branch'
WHERE NOT EXISTS (SELECT 1 FROM branches);

-- users: NULL = general admin (or a patient — patients are never
-- branch-scoped regardless of this column). Non-admin staff need a home
-- branch to keep working, so they're backfilled; admins are left NULL.
ALTER TABLE users ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL;
UPDATE users SET branch_id = (SELECT id FROM branches ORDER BY id LIMIT 1)
WHERE role IN ('doctor', 'nurse', 'receptionist', 'pharmacist') AND branch_id IS NULL;

-- wards: every physical room belongs to exactly one branch going forward.
ALTER TABLE wards ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL;
UPDATE wards SET branch_id = (SELECT id FROM branches ORDER BY id LIMIT 1) WHERE branch_id IS NULL;
ALTER TABLE wards ALTER COLUMN branch_id SET NOT NULL;

-- appointments: stored directly (rather than derived from doctor_id) so
-- that if a doctor is ever reassigned to a different branch later, past
-- appointments still correctly show where they actually happened.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL;
UPDATE appointments SET branch_id = (SELECT id FROM branches ORDER BY id LIMIT 1) WHERE branch_id IS NULL;
ALTER TABLE appointments ALTER COLUMN branch_id SET NOT NULL;

-- inventory_items: each branch manages and stocks its own — this was the
-- client's explicit call ("branch admin can manage inventory... for that
-- branch only"), so it's a separate catalog per branch, not shared stock.
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL;
UPDATE inventory_items SET branch_id = (SELECT id FROM branches ORDER BY id LIMIT 1) WHERE branch_id IS NULL;
ALTER TABLE inventory_items ALTER COLUMN branch_id SET NOT NULL;

-- invoices: stored directly for the same reasoning as appointments above.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL;
UPDATE invoices SET branch_id = (SELECT id FROM branches ORDER BY id LIMIT 1) WHERE branch_id IS NULL;
ALTER TABLE invoices ALTER COLUMN branch_id SET NOT NULL;

-- expenses: each branch's costs are its own.
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL;
UPDATE expenses SET branch_id = (SELECT id FROM branches ORDER BY id LIMIT 1) WHERE branch_id IS NULL;
ALTER TABLE expenses ALTER COLUMN branch_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_branch ON users(branch_id);
CREATE INDEX IF NOT EXISTS idx_wards_branch ON wards(branch_id);
CREATE INDEX IF NOT EXISTS idx_appointments_branch ON appointments(branch_id);
CREATE INDEX IF NOT EXISTS idx_inventory_items_branch ON inventory_items(branch_id);
CREATE INDEX IF NOT EXISTS idx_invoices_branch ON invoices(branch_id);
CREATE INDEX IF NOT EXISTS idx_expenses_branch ON expenses(branch_id);
