-- ============================================
-- Seed data for local development / testing
-- Run AFTER schema.sql
-- ============================================

-- Default branch. Every fresh install starts with one; add more from the
-- app once you're running (Branches page, general admin only).
INSERT INTO branches (name) VALUES ('Main Branch');

-- Default admin login.
-- Left as a general admin (branch_id NULL) — sees every branch. Make a
-- copy with a branch_id set if you want a branch-scoped admin too.
-- Step 1: generate a real bcrypt hash for your chosen password:
--   cd backend && node -e "console.log(require('bcryptjs').hashSync('YOUR_PASSWORD', 10))"
-- Step 2: paste the output below in place of REPLACE_WITH_BCRYPT_HASH, then run this file.
INSERT INTO users (full_name, email, phone, password_hash, role)
VALUES (
  'System Admin',
  'admin@wardline.local',
  '+251900000000',
  '$2a$10$MmJsshtxNaA/tx0GeU3m1.d6QSVADXSoVRJmoKmyN7gfHNxUvf9P.',
  'admin'
);

-- Sample doctor (needed to test appointment booking + consultation auto-billing).
-- Generate a real hash the same way as the admin above.
INSERT INTO users (full_name, email, phone, password_hash, role, branch_id)
SELECT
  'Dr. Selam Bekele',
  'selam@wardline.local',
  '+251900000001',
  '$2a$10$MmJsshtxNaA/tx0GeU3m1.d6QSVADXSoVRJmoKmyN7gfHNxUvf9P.',
  'doctor',
  id
FROM branches WHERE name = 'Main Branch';
INSERT INTO staff_profiles (user_id, specialty, department, consultation_fee)
SELECT id, 'General Medicine', 'Outpatient', 150.00 FROM users WHERE email = 'selam@wardline.local';

-- Sample wards
INSERT INTO wards (branch_id, name, floor)
SELECT b.id, w.name, w.floor
FROM branches b, (VALUES
  ('General Ward A', '1'),
  ('General Ward B', '1'),
  ('ICU', '2'),
  ('Maternity Ward', '2')
) AS w(name, floor)
WHERE b.name = 'Main Branch';

-- Sample beds (6 per general ward, 4 in ICU, 4 in maternity)
INSERT INTO beds (ward_id, bed_number)
SELECT w.id, 'A' || g
FROM wards w, generate_series(1, 6) g
WHERE w.name = 'General Ward A';

INSERT INTO beds (ward_id, bed_number)
SELECT w.id, 'B' || g
FROM wards w, generate_series(1, 6) g
WHERE w.name = 'General Ward B';

INSERT INTO beds (ward_id, bed_number)
SELECT w.id, 'ICU' || g
FROM wards w, generate_series(1, 4) g
WHERE w.name = 'ICU';

INSERT INTO beds (ward_id, bed_number)
SELECT w.id, 'M' || g
FROM wards w, generate_series(1, 4) g
WHERE w.name = 'Maternity Ward';

-- Sample inventory: medicines + dental supplies together
INSERT INTO inventory_items (branch_id, name, category, unit, stock_quantity, reorder_level, unit_price)
SELECT b.id, i.name, i.category, i.unit, i.stock_quantity, i.reorder_level, i.unit_price
FROM branches b, (VALUES
  ('Amoxicillin 500mg', 'medicine', 'capsule', 300, 40, 5.00),
  ('Ibuprofen 400mg', 'medicine', 'tablet', 500, 50, 2.00),
  ('Lidocaine 2% (dental)', 'medicine', 'vial', 100, 20, 8.50),
  ('Nitrile gloves (box of 100)', 'supply', 'box', 40, 10, 12.00),
  ('Composite filling material', 'supply', 'syringe', 25, 5, 22.00),
  ('Dental anesthesia cartridges', 'supply', 'cartridge', 200, 40, 1.50)
) AS i(name, category, unit, stock_quantity, reorder_level, unit_price)
WHERE b.name = 'Main Branch';
