-- ============================================
-- Migration 003: email verification for self-signup
-- Safe to run on your existing database — only adds new tables/columns.
-- Run with: psql hospital_db -f config/migration_003_email_verification.sql
-- ============================================

-- Defaults to TRUE so every existing account (staff, and any patients
-- already invited/self-signed-up before this migration) is treated as
-- already verified — nobody gets locked out retroactively. Only brand new
-- self-signups going forward will be created with this set to FALSE.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS email_verification_codes (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash VARCHAR(64) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    attempts INTEGER DEFAULT 0,
    used_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_verification_codes_user ON email_verification_codes(user_id);
