-- ============================================
-- Migration 007: Clinic expenses (admin-only)
-- Run once against an existing database, in order after migration_006.
-- ============================================

-- Separate from invoices/payments (which is money coming IN from patients).
-- This is money going OUT — staff salaries, rent, utilities, security,
-- supplies bought outside the inventory flow, etc. staff_id is optional:
-- only set it when the expense is a salary for someone who actually has a
-- system account (doctor/nurse/receptionist/admin). Security guards,
-- cleaners, landlords, and other external payees don't have accounts, so
-- they're just identified by the description field instead.
CREATE TABLE expenses (
    id SERIAL PRIMARY KEY,
    category VARCHAR(30) NOT NULL, -- 'salary' | 'rent' | 'utilities' | 'security' | 'supplies' | 'other'
    description VARCHAR(255) NOT NULL, -- e.g. "August salary - Dr. Sarah", "Security guard - Ahmed", "Electricity bill"
    amount NUMERIC(12,2) NOT NULL,
    staff_id INTEGER REFERENCES users(id), -- optional — only for salaries paid to system staff
    recorded_by INTEGER REFERENCES users(id),
    expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMP DEFAULT NOW()
);
