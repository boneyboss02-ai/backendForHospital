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
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, -- who booked it; used to let receptionists cancel only their own bookings
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

-- A fixed-price procedure a doctor can bill in one click (e.g. "Teeth
-- whitening — 1500"). Admin manages the catalog; doctors just pick from it
-- on the consultation form. Never hard-deleted (is_active toggle instead)
-- so past invoices/usage referencing a treatment's name/price at billing
-- time are never orphaned.
CREATE TABLE treatments (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    price NUMERIC(10,2) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- What a treatment consumes from inventory when performed. Selecting a
-- treatment on the consultation form auto-fills the charge (from
-- treatments.price) and this usage — reuses the existing generic
-- items_used[] on POST /api/appointments/:id/consultation, no schema
-- change needed there.
CREATE TABLE treatment_items (
    id SERIAL PRIMARY KEY,
    treatment_id INTEGER NOT NULL REFERENCES treatments(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    quantity NUMERIC(10,2) NOT NULL DEFAULT 1,
    UNIQUE(treatment_id, item_id)
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
    medicine_name VARCHAR(200) NOT NULL, -- free text — prescriptions are documentation only,
                                          -- not tied to the inventory catalog (see migration_013)
    dosage VARCHAR(100), -- e.g. "500mg"
    frequency VARCHAR(100), -- e.g. "twice daily"
    duration_days INTEGER,
    dispensed BOOLEAN DEFAULT FALSE -- vestigial: no in-house dispense workflow anymore, always FALSE
);

-- When a doctor completes a visit and says "I used 2 aspirin and a
-- filling", this records exactly what was used, by whom, and when —
-- separate from the invoice (this is not billed; it's inventory
-- consumption). Doctors can only consume via this path — adding or
-- restocking inventory stays admin/nurse only (routes/inventory.js).
CREATE TABLE inventory_usage (
    id SERIAL PRIMARY KEY,
    appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
    item_id INTEGER REFERENCES inventory_items(id),
    quantity INTEGER NOT NULL,
    used_by INTEGER REFERENCES users(id),
    used_at TIMESTAMP DEFAULT NOW()
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
    due_date DATE, -- optional payment deadline; NULL = no deadline, never counts as overdue
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

-- Money going OUT of the clinic — staff salaries, rent, utilities, security,
-- supplies bought outside the inventory flow, etc. Separate from
-- invoices/payments (money coming IN from patients). staff_id is optional:
-- only set for salaries paid to someone with a system account; external
-- payees (security guards, landlords, etc.) are just identified by
-- description instead.
CREATE TABLE expenses (
    id SERIAL PRIMARY KEY,
    category VARCHAR(30) NOT NULL, -- 'salary' | 'rent' | 'utilities' | 'security' | 'supplies' | 'other'
    description VARCHAR(255) NOT NULL,
    amount NUMERIC(12,2) NOT NULL,
    staff_id INTEGER REFERENCES users(id),
    recorded_by INTEGER REFERENCES users(id),
    expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- One row per Chapa checkout attempt. tx_ref is generated by us (unique)
-- and is how we look up which invoice a redirect/verification is for.
CREATE TABLE chapa_transactions (
    id SERIAL PRIMARY KEY,
    invoice_id INTEGER REFERENCES invoices(id) ON DELETE CASCADE,
    patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE,
    tx_ref VARCHAR(100) UNIQUE NOT NULL,
    amount NUMERIC(12,2) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending' | 'success' | 'failed'
    created_at TIMESTAMP DEFAULT NOW(),
    verified_at TIMESTAMP
);

-- Fallback for interrupted Chapa checkouts: patient submits a transaction
-- number + screenshot, admin/receptionist reviews it manually. UNIQUE on
-- transaction_ref is the fraud guard — enforced at the database level.
CREATE TABLE payment_proofs (
    id SERIAL PRIMARY KEY,
    invoice_id INTEGER REFERENCES invoices(id) ON DELETE CASCADE,
    patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE,
    transaction_ref VARCHAR(100) UNIQUE NOT NULL,
    image_path VARCHAR(255) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
    submitted_at TIMESTAMP DEFAULT NOW(),
    reviewed_by INTEGER REFERENCES users(id),
    reviewed_at TIMESTAMP,
    review_note VARCHAR(255)
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
    body TEXT, -- nullable: a message can be attachment-only (see CHECK below)
    attachment_url VARCHAR(255),
    attachment_type VARCHAR(20), -- 'image' | 'video' | 'audio' | 'pdf' | 'file'
    attachment_name VARCHAR(255),
    read_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT messages_body_or_attachment CHECK (body IS NOT NULL OR attachment_url IS NOT NULL)
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
-- The standing weekly plan a shift row can be generated from — see
-- migration_010 for the full rationale. NULL pattern_id = a one-off shift.
CREATE TABLE shift_patterns (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ward_id INTEGER REFERENCES wards(id) ON DELETE SET NULL,
    day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    note TEXT,
    effective_from DATE NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE shifts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ward_id INTEGER REFERENCES wards(id) ON DELETE SET NULL, -- optional; mainly relevant for nurses
    pattern_id INTEGER REFERENCES shift_patterns(id) ON DELETE SET NULL, -- set if generated from a recurring weekly plan
    shift_date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    note VARCHAR(200),
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_shifts_date ON shifts(shift_date);
CREATE INDEX idx_shifts_user ON shifts(user_id);
CREATE INDEX idx_shift_patterns_user ON shift_patterns(user_id);
CREATE INDEX idx_shifts_pattern ON shifts(pattern_id);

-- Staff-to-staff messaging — parallel to (not shared with) the
-- doctor<->patient conversations/messages tables. See migration_010 for
-- why this is a separate structure rather than a generalization.
CREATE TABLE staff_conversations (
    id SERIAL PRIMARY KEY,
    user_a_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_b_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW(),
    CHECK (user_a_id < user_b_id),
    UNIQUE(user_a_id, user_b_id)
);

CREATE TABLE staff_messages (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES staff_conversations(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT,
    attachment_url VARCHAR(255),
    attachment_type VARCHAR(20),
    attachment_name VARCHAR(255),
    read_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT staff_messages_body_or_attachment CHECK (body IS NOT NULL OR attachment_url IS NOT NULL)
);

-- ============================================
-- INDEXES for common lookups
-- ============================================
CREATE INDEX idx_appointments_patient ON appointments(patient_id);
CREATE INDEX idx_appointments_doctor_date ON appointments(doctor_id, scheduled_at);
CREATE INDEX idx_admissions_patient ON admissions(patient_id);
CREATE INDEX idx_beds_status ON beds(status);
CREATE INDEX idx_invoices_patient ON invoices(patient_id);
CREATE INDEX idx_notifications_user ON notifications(user_id, read_at, created_at DESC);
CREATE INDEX idx_appointments_created_by ON appointments(created_by);
CREATE INDEX idx_invoices_due_date ON invoices(due_date) WHERE status IN ('unpaid', 'partially_paid');
CREATE INDEX idx_treatment_items_treatment ON treatment_items(treatment_id);
CREATE INDEX idx_staff_conversations_a ON staff_conversations(user_a_id);
CREATE INDEX idx_staff_conversations_b ON staff_conversations(user_b_id);
CREATE INDEX idx_staff_messages_conversation_created ON staff_messages(conversation_id, created_at);
CREATE INDEX idx_conversations_doctor ON conversations(doctor_id);
CREATE INDEX idx_conversations_patient ON conversations(patient_id);
CREATE INDEX idx_messages_conversation_created ON messages(conversation_id, created_at);

-- Prevents two appointments being booked for the same doctor at the exact
-- same timestamp (race-condition guard on top of the app-level availability
-- check). Cancelled/no-show slots don't block rebooking that slot.
CREATE UNIQUE INDEX idx_appointments_no_double_book
  ON appointments (doctor_id, scheduled_at)
  WHERE status NOT IN ('cancelled', 'no_show');
