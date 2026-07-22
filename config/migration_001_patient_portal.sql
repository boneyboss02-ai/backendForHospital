-- ============================================
-- Migration: Patient Self-Service Portal
-- Run AFTER schema.sql (and after seed.sql if already applied)
-- ============================================

-- A user can only ever be linked to ONE patient record (prevents a login
-- accidentally/maliciously being attached to two different patients).
-- NULLs (patients with no login yet) are unaffected — Postgres allows
-- multiple NULLs in a unique column.
ALTER TABLE patients
  ADD CONSTRAINT patients_user_id_unique UNIQUE (user_id);

-- File metadata for lab result uploads (result_file_url already existed,
-- but we need the original filename/type/size to serve downloads properly
-- and to validate uploads).
ALTER TABLE lab_results
  ADD COLUMN file_name VARCHAR(255),
  ADD COLUMN file_mime VARCHAR(100),
  ADD COLUMN file_size INTEGER;

-- Prevents two appointments being booked for the same doctor at the same
-- exact timestamp (race condition guard on top of the application-level
-- availability check). Cancelled/no-show slots don't block rebooking.
CREATE UNIQUE INDEX idx_appointments_no_double_book
  ON appointments (doctor_id, scheduled_at)
  WHERE status NOT IN ('cancelled', 'no_show');

-- In-app notifications
CREATE TABLE notifications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL, -- e.g. 'appointment_booked', 'appointment_status', 'lab_result', 'prescription'
    title VARCHAR(200) NOT NULL,
    message TEXT,
    related_type VARCHAR(50), -- e.g. 'appointment', 'lab_order', 'prescription'
    related_id INTEGER,
    read_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_notifications_user ON notifications(user_id, read_at, created_at DESC);

-- Patient self-signup tokens are unnecessary for v1 (no email sending is
-- wired up yet), but staff-issued accounts need a "must change password"
-- flag so a temp password can't just sit there unchanged forever.
ALTER TABLE users
  ADD COLUMN must_change_password BOOLEAN DEFAULT FALSE;
