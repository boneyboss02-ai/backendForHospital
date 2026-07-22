-- ============================================
-- Migration 002: password reset, shifts/rostering, patient claim lockout
-- Safe to run on your existing database — only adds new tables/columns.
-- Run with: psql hospital_db -f config/migration_002_scheduling_security.sql
-- ============================================

ALTER TABLE patients ADD COLUMN IF NOT EXISTS portal_claim_attempts INTEGER DEFAULT 0;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS portal_claim_locked_until TIMESTAMP;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    used_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_hash ON password_reset_tokens(token_hash);

CREATE TABLE IF NOT EXISTS shifts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ward_id INTEGER REFERENCES wards(id) ON DELETE SET NULL,
    shift_date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    note VARCHAR(200),
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shifts_date ON shifts(shift_date);
CREATE INDEX IF NOT EXISTS idx_shifts_user ON shifts(user_id);
