-- ============================================
-- Local Hospital Management System - Schema
-- PostgreSQL
-- ============================================

-- 'pharmacist' is kept in the enum for backward compatibility with existing
-- rows/migrations, but the role is retired as of migration_005_inventory.sql:
-- no new pharmacist accounts are created (see routes/auth.js) and no route
-- uses it. A dental clinic doesn't run its own in-house dispensary.
CREATE TYPE user_role AS ENUM ('admin', 'doctor', 'nurse', 'receptionist', 'pharmacist', 'patient');
CREATE TYPE appointment_status AS ENUM ('scheduled', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show');
CREATE TYPE bed_status AS ENUM ('available', 'occupied', 'cleaning', 'maintenance');
CREATE TYPE admission_status AS ENUM ('admitted', 'discharged', 'transferred');
CREATE TYPE invoice_status AS ENUM ('unpaid', 'partially_paid', 'paid', 'cancelled');

-- ============================================
-- USERS & AUTH
-- One row per login-capable person (staff or patient)
-- ============================================
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    full_name VARCHAR(150) NOT NULL,
    email VARCHAR(150) UNIQUE NOT NULL,
    phone VARCHAR(20),
    password_hash VARCHAR(255) NOT NULL,
    role user_role NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    must_change_password BOOLEAN DEFAULT FALSE, -- true for staff-issued patient accounts until first login password change
    email_verified BOOLEAN DEFAULT TRUE, -- FALSE only for self-signup accounts pending a code; staff-created/invited accounts are pre-verified
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- PATIENTS
-- ============================================
CREATE TABLE patients (
    id SERIAL PRIMARY KEY,
    user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE SET NULL, -- null if patient has no login; UNIQUE so one login maps to exactly one patient
    patient_code VARCHAR(20) UNIQUE NOT NULL, -- e.g. PT-2026-0001
    full_name VARCHAR(150) NOT NULL,
    date_of_birth DATE,
    gender VARCHAR(20),
    phone VARCHAR(20),
    address TEXT,
    blood_group VARCHAR(5),
    allergies TEXT,
    chronic_conditions TEXT,
    emergency_contact_name VARCHAR(150),
    emergency_contact_phone VARCHAR(20),
    portal_claim_attempts INTEGER DEFAULT 0, -- failed self-signup "claim my record" tries
    portal_claim_locked_until TIMESTAMP, -- set after too many failed attempts; blocks further tries until this passes
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- DOCTORS / STAFF PROFILES
-- Extra info tied to a user with role = doctor/nurse/etc.
-- ============================================
CREATE TABLE staff_profiles (
    id SERIAL PRIMARY KEY,
    user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    specialty VARCHAR(100), -- for doctors
    department VARCHAR(100),
    license_number VARCHAR(50),
    consultation_fee NUMERIC(10,2)
);

-- Doctor weekly availability (simple recurring slots)
CREATE TABLE doctor_availability (
    id SERIAL PRIMARY KEY,
    doctor_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    day_of_week SMALLINT NOT NULL, -- 0=Sunday ... 6=Saturday
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    slot_minutes SMALLINT DEFAULT 15
);

-- ============================================
-- APPOINTMENTS (Outpatient)
-- ============================================
CREATE TABLE appointments (
    id SERIAL PRIMARY KEY,
    patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE,
    doctor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    scheduled_at TIMESTAMP NOT NULL,
    token_number INTEGER, -- daily queue number
    status appointment_status DEFAULT 'scheduled',
    reason TEXT,
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE consultations (
    id SERIAL PRIMARY KEY,
    appointment_id INTEGER REFERENCES appointments(id) ON DELETE CASCADE,
    diagnosis TEXT,
    doctor_notes TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- WARDS / BEDS / ADMISSIONS (Inpatient)
-- ============================================
CREATE TABLE wards (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL, -- e.g. "General Ward A", "ICU"
    floor VARCHAR(20)
);

CREATE TABLE beds (
    id SERIAL PRIMARY KEY,
    ward_id INTEGER REFERENCES wards(id) ON DELETE CASCADE,
    bed_number VARCHAR(20) NOT NULL,
    status bed_status DEFAULT 'available',
    UNIQUE(ward_id, bed_number)
);

CREATE TABLE admissions (
    id SERIAL PRIMARY KEY,
    patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE,
    bed_id INTEGER REFERENCES beds(id) ON DELETE SET NULL,
    attending_doctor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    admitted_at TIMESTAMP DEFAULT NOW(),
    discharged_at TIMESTAMP,
    status admission_status DEFAULT 'admitted',
    admission_reason TEXT,
    discharge_summary TEXT
);

-- Vitals logged periodically by nurses during an admission
CREATE TABLE vitals_log (
    id SERIAL PRIMARY KEY,
    admission_id INTEGER REFERENCES admissions(id) ON DELETE CASCADE,
    recorded_by INTEGER REFERENCES users(id),
    temperature_c NUMERIC(4,1),
    blood_pressure VARCHAR(20),
    heart_rate INTEGER,
    respiratory_rate INTEGER,
    oxygen_saturation NUMERIC(4,1),
    recorded_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- INVENTORY
-- General clinic stock — medicines AND dental supplies (gloves, anesthesia,
-- filling material, etc.) together, managed by admin/nurse. There's no
-- pharmacist role or in-house dispensing; this is internal stock tracking
-- only, with no connection to billing.
-- ============================================
CREATE TABLE inventory_items (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    category VARCHAR(30) NOT NULL DEFAULT 'medicine', -- 'medicine' | 'supply'
    unit VARCHAR(30), -- e.g. "tablet", "ml", "vial", "box"
    stock_quantity INTEGER DEFAULT 0,
    reorder_level INTEGER DEFAULT 10,
    unit_price NUMERIC(10,2)
);

CREATE TABLE prescriptions (
    id SERIAL PRIMARY KEY,
    patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE,
    appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
    admission_id INTEGER REFERENCES admissions(id) ON DELETE SET NULL,
    prescribed_by INTEGER REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE prescription_items (
    id SERIAL PRIMARY KEY,
    prescription_id INTEGER REFERENCES prescriptions(id) ON DELETE CASCADE,
    medicine_id INTEGER REFERENCES inventory_items(id), -- always a category='medicine' row
    dosage VARCHAR(100), -- e.g. "500mg"
    frequency VARCHAR(100), -- e.g. "twice daily"
    duration_days INTEGER,
    dispensed BOOLEAN DEFAULT FALSE -- vestigial: no in-house dispense workflow anymore, always FALSE
);

-- ============================================
-- LAB
-- ============================================
CREATE TABLE lab_orders (
    id SERIAL PRIMARY KEY,
    patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE,
    ordered_by INTEGER REFERENCES users(id),
    test_name VARCHAR(150) NOT NULL,
    status VARCHAR(30) DEFAULT 'pending', -- pending, completed
    ordered_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE lab_results (
    id SERIAL PRIMARY KEY,
    lab_order_id INTEGER REFERENCES lab_orders(id) ON DELETE CASCADE,
    result_text TEXT,
    result_file_url VARCHAR(255),
    file_name VARCHAR(255),
    file_mime VARCHAR(100),
    file_size INTEGER,
    entered_by INTEGER REFERENCES users(id),
    entered_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- BILLING
-- ============================================
CREATE TABLE invoices (
    id SERIAL PRIMARY KEY,
    patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE,
    appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
    admission_id INTEGER REFERENCES admissions(id) ON DELETE SET NULL,
    total_amount NUMERIC(12,2) DEFAULT 0,
    amount_paid NUMERIC(12,2) DEFAULT 0,
    status invoice_status DEFAULT 'unpaid',
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE invoice_items (
    id SERIAL PRIMARY KEY,
    invoice_id INTEGER REFERENCES invoices(id) ON DELETE CASCADE,
    description VARCHAR(255) NOT NULL, -- e.g. "Consultation - Dr. Smith", "Paracetamol x10"
    quantity INTEGER DEFAULT 1,
    unit_price NUMERIC(10,2) NOT NULL,
    line_total NUMERIC(12,2) NOT NULL
);

CREATE TABLE payments (
    id SERIAL PRIMARY KEY,
    invoice_id INTEGER REFERENCES invoices(id) ON DELETE CASCADE,
    amount NUMERIC(12,2) NOT NULL,
    method VARCHAR(30), -- cash, card, insurance, mobile_money
    paid_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- NOTIFICATIONS (in-app only)
-- ============================================
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

-- ============================================
-- MESSAGING (doctor <-> patient chat)
-- One thread per (patient, doctor) pair. See migration_004_chat.sql for
-- the same tables applied to an existing database.
-- ============================================
CREATE TABLE conversations (
    id SERIAL PRIMARY KEY,
    patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    doctor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(patient_id, doctor_id)
);

CREATE TABLE messages (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    read_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- PASSWORD RESET
-- ============================================
CREATE TABLE password_reset_tokens (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL, -- sha256 hex digest; the raw token is only ever in the emailed link, never stored
    expires_at TIMESTAMP NOT NULL,
    used_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_password_reset_tokens_hash ON password_reset_tokens(token_hash);

-- ============================================
-- EMAIL VERIFICATION (self-signup only)
-- ============================================
CREATE TABLE email_verification_codes (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash VARCHAR(64) NOT NULL, -- sha256 hex of the 6-digit code; the raw code is only ever in the email
    expires_at TIMESTAMP NOT NULL,
    attempts INTEGER DEFAULT 0, -- wrong tries against this specific code; too many invalidates it
    used_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_email_verification_codes_user ON email_verification_codes(user_id);

-- ============================================
-- STAFF SHIFTS / ROSTERING
-- ============================================
CREATE TABLE shifts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ward_id INTEGER REFERENCES wards(id) ON DELETE SET NULL, -- optional; mainly relevant for nurses
    shift_date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    note VARCHAR(200),
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_shifts_date ON shifts(shift_date);
CREATE INDEX idx_shifts_user ON shifts(user_id);

-- ============================================
-- INDEXES for common lookups
-- ============================================
CREATE INDEX idx_appointments_patient ON appointments(patient_id);
CREATE INDEX idx_appointments_doctor_date ON appointments(doctor_id, scheduled_at);
CREATE INDEX idx_admissions_patient ON admissions(patient_id);
CREATE INDEX idx_beds_status ON beds(status);
CREATE INDEX idx_invoices_patient ON invoices(patient_id);
CREATE INDEX idx_notifications_user ON notifications(user_id, read_at, created_at DESC);
CREATE INDEX idx_conversations_doctor ON conversations(doctor_id);
CREATE INDEX idx_conversations_patient ON conversations(patient_id);
CREATE INDEX idx_messages_conversation_created ON messages(conversation_id, created_at);

-- Prevents two appointments being booked for the same doctor at the exact
-- same timestamp (race-condition guard on top of the app-level availability
-- check). Cancelled/no-show slots don't block rebooking that slot.
CREATE UNIQUE INDEX idx_appointments_no_double_book
  ON appointments (doctor_id, scheduled_at)
  WHERE status NOT IN ('cancelled', 'no_show');
