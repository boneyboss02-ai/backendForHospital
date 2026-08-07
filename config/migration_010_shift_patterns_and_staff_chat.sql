-- ============================================
-- Migration 010: recurring shift patterns + staff-to-staff messaging
-- Run once against an existing database, in order after migration_009.
-- ============================================

-- The standing weekly plan: "Nurse X works Mondays 8-4" as a template,
-- separate from the concrete shifts it generates. Concrete rows in `shifts`
-- (existing table) are what everyone actually reads on the "Who's on Duty"
-- page — this table exists so that when admin changes the plan, we know
-- which future shift rows came from which template and can update/remove
-- them together instead of one by one.
CREATE TABLE IF NOT EXISTS shift_patterns (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ward_id INTEGER REFERENCES wards(id) ON DELETE SET NULL,
    day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0=Sunday .. 6=Saturday
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    note TEXT,
    effective_from DATE NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Links a generated shift back to the pattern that produced it. NULL means
-- a one-off shift assigned directly (the pre-existing behavior) — those are
-- untouched by pattern edits/removals.
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS pattern_id INTEGER REFERENCES shift_patterns(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_shift_patterns_user ON shift_patterns(user_id);
CREATE INDEX IF NOT EXISTS idx_shifts_pattern ON shifts(pattern_id);

-- Staff-to-staff messaging (admin<->employee, employee<->employee) — a
-- parallel, deliberately separate structure from the doctor<->patient
-- `conversations`/`messages` tables added earlier. Kept separate rather
-- than generalizing the existing ones because the access rules are
-- different in kind: doctor<->patient threads are gated by a clinical
-- relationship (an appointment/admission); staff threads aren't gated by
-- anything except both parties being staff. Reusing one table would mean
-- either loosening that clinical check or bolting on a type column and
-- branching every query on it — this is simpler and keeps each system's
-- authorization logic easy to audit on its own.
CREATE TABLE IF NOT EXISTS staff_conversations (
    id SERIAL PRIMARY KEY,
    user_a_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_b_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW(),
    CHECK (user_a_id < user_b_id), -- canonical ordering so a pair can never get two threads
    UNIQUE(user_a_id, user_b_id)
);

CREATE TABLE IF NOT EXISTS staff_messages (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES staff_conversations(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    read_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staff_conversations_a ON staff_conversations(user_a_id);
CREATE INDEX IF NOT EXISTS idx_staff_conversations_b ON staff_conversations(user_b_id);
CREATE INDEX IF NOT EXISTS idx_staff_messages_conversation_created ON staff_messages(conversation_id, created_at);
