-- ============================================
-- Migration 004: doctor <-> patient messaging
-- Safe to run on your existing database — only adds new tables.
-- Run with: psql hospital_db -f config/migration_004_chat.sql
-- ============================================

-- One thread per (patient, doctor) pair. Kept deliberately simple — no
-- group chats, no per-appointment threads. Whether a given pair is even
-- *allowed* to have a conversation is enforced in the app layer (they must
-- share an appointment or admission); this table doesn't re-derive that on
-- every read, it just stores the thread once it's been created.
CREATE TABLE IF NOT EXISTS conversations (
    id SERIAL PRIMARY KEY,
    patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    doctor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(patient_id, doctor_id)
);

CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    read_at TIMESTAMP, -- set when the *other* participant opens the thread
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversations_doctor ON conversations(doctor_id);
CREATE INDEX IF NOT EXISTS idx_conversations_patient ON conversations(patient_id);
-- Powers both "load a thread's messages in order" and the unread-count
-- subquery used on the conversation list.
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at);
