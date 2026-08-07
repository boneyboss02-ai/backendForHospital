-- ============================================
-- Migration 008: appointment ownership + invoice due dates
-- Run once against an existing database, in order after migration_007.
-- ============================================

-- Who booked this appointment. Existing rows are left NULL on purpose —
-- there's no reliable way to backfill who booked a past appointment, and
-- NULL correctly means "not attributable to a specific receptionist" for
-- the ownership check in routes/appointments.js (a receptionist can only
-- cancel appointments where created_by = their own user id).
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- Optional — only set when reception wants to give a patient a payment
-- deadline. NULL means "no deadline", and such invoices are never treated
-- as overdue regardless of balance.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS due_date DATE;

CREATE INDEX IF NOT EXISTS idx_appointments_created_by ON appointments(created_by);
-- Speeds up the "overdue invoices" filter (due_date in the past, still
-- unpaid/partially paid) without indexing the far more common fully-paid
-- and no-due-date rows.
CREATE INDEX IF NOT EXISTS idx_invoices_due_date ON invoices(due_date) WHERE status IN ('unpaid', 'partially_paid');
