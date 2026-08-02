-- ============================================
-- Migration 005: General inventory + pharmacist role retirement
-- Run once against an existing database, in order after migration_004.
-- ============================================

-- Medicines and dental supplies (gloves, anesthesia, filling material, etc.)
-- now live in one general inventory table instead of a pharmacy-only one.
ALTER TABLE medicines RENAME TO inventory_items;
ALTER TABLE inventory_items ADD COLUMN category VARCHAR(30) NOT NULL DEFAULT 'medicine';
-- category is 'medicine' or 'supply' — enforced at the application layer
-- (routes/inventory.js) rather than a CHECK constraint, to keep this
-- migration simple to run on a live database.

-- The pharmacist role is retired: a dental clinic doesn't run its own
-- in-house dispensary, so there's no more dispense/auto-bill workflow and
-- no more pharmacist-specific screens. We deliberately do NOT drop
-- 'pharmacist' from the user_role enum — dropping enum values on a live
-- Postgres database requires recreating the type and is a much riskier
-- migration than it's worth for an unused value. It simply won't be
-- assignable to new accounts (enforced in routes/auth.js) or used by any
-- route going forward. Any existing pharmacist accounts are deactivated
-- here so they can no longer log in.
UPDATE users SET is_active = FALSE WHERE role = 'pharmacist';
