-- ============================================
-- Seed data for local development / testing
-- Run AFTER schema.sql
-- ============================================

-- Default admin login.
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
INSERT INTO users (full_name, email, phone, password_hash, role)
VALUES (
  'Dr. Selam Bekele',
  'selam@wardline.local',
  '+251900000001',
  '$2a$10$MmJsshtxNaA/tx0GeU3m1.d6QSVADXSoVRJmoKmyN7gfHNxUvf9P.',
  'doctor'
);
INSERT INTO staff_profiles (user_id, specialty, department, consultation_fee)
SELECT id, 'General Medicine', 'Outpatient', 150.00 FROM users WHERE email = 'selam@wardline.local';

-- Sample wards
INSERT INTO wards (name, floor) VALUES
  ('General Ward A', '1'),
  ('General Ward B', '1'),
  ('ICU', '2'),
  ('Maternity Ward', '2');

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

-- Sample medicines
INSERT INTO medicines (name, unit, stock_quantity, reorder_level, unit_price) VALUES
  ('Paracetamol 500mg', 'tablet', 500, 50, 2.00),
  ('Amoxicillin 250mg', 'capsule', 300, 40, 5.00),
  ('Normal Saline 0.9%', 'ml', 10000, 2000, 0.05);
