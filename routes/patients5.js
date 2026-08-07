const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { generatePatientCode } = require('../utils/patientCode');
const { sendMail } = require('../utils/mailer');

const router = express.Router();

// POST /api/patients — register a new patient (reception/admin)
router.post('/', authenticate, authorize('admin', 'receptionist'), async (req, res) => {
  const {
    full_name, date_of_birth, gender, phone, address,
    blood_group, allergies, chronic_conditions,
    emergency_contact_name, emergency_contact_phone,
  } = req.body;

  if (!full_name) {
    return res.status(400).json({ error: 'full_name is required' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const patient_code = await generatePatientCode(client);
    const result = await client.query(
      `INSERT INTO patients
        (patient_code, full_name, date_of_birth, gender, phone, address,
         blood_group, allergies, chronic_conditions, emergency_contact_name, emergency_contact_phone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [patient_code, full_name, date_of_birth, gender, phone, address,
       blood_group, allergies, chronic_conditions, emergency_contact_name, emergency_contact_phone]
    );
    await client.query('COMMIT');
    res.status(201).json({ patient: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error creating patient' });
  } finally {
    client.release();
  }
});

// GET /api/patients?search=name-or-code — search patients
// Staff-only: this is the hospital-wide directory. Patients get their own
// data through /api/portal instead, never through this list/lookup.
router.get('/', authenticate, authorize('admin', 'receptionist', 'doctor', 'nurse'), async (req, res) => {
  const { search } = req.query;
  try {
    let result;
    if (search) {
      result = await db.query(
        `SELECT * FROM patients
         WHERE full_name ILIKE $1 OR patient_code ILIKE $1 OR phone ILIKE $1
         ORDER BY created_at DESC LIMIT 50`,
        [`%${search}%`]
      );
    } else {
      result = await db.query('SELECT * FROM patients ORDER BY created_at DESC LIMIT 50');
    }
    res.json({ patients: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching patients' });
  }
});

// GET /api/patients/:id — full patient profile
// Staff-only — a patient viewing their own profile goes through
// /api/portal/me instead, which enforces the id match server-side.
router.get('/:id', authenticate, authorize('admin', 'receptionist', 'doctor', 'nurse'), async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM patients WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Patient not found' });
    }
    res.json({ patient: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching patient' });
  }
});

// PUT /api/patients/:id — update patient info
router.put('/:id', authenticate, authorize('admin', 'receptionist', 'doctor', 'nurse'), async (req, res) => {
  const fields = [
    'full_name', 'date_of_birth', 'gender', 'phone', 'address',
    'blood_group', 'allergies', 'chronic_conditions',
    'emergency_contact_name', 'emergency_contact_phone',
  ];
  const updates = [];
  const values = [];
  let i = 1;

  for (const field of fields) {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = $${i}`);
      values.push(req.body[field]);
      i++;
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  values.push(req.params.id);
  try {
    const result = await db.query(
      `UPDATE patients SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Patient not found' });
    }
    res.json({ patient: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error updating patient' });
  }
});

// POST /api/patients/:id/invite — staff creates a portal login for an
// existing patient record (e.g. a walk-in patient who wants access later,
// or an elderly patient who needs help setting it up).
// body: { email, password? } — if password is omitted, a random temporary
// one is generated and returned ONCE in the response for staff to relay to
// the patient. The account is flagged must_change_password so the patient
// is required to set their own password on first login.
router.post('/:id/invite', authenticate, authorize('admin', 'receptionist'), async (req, res) => {
  const { email } = req.body;
  let { password } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'email is required' });
  }

  let generatedPassword = null;
  if (!password) {
    generatedPassword = crypto.randomBytes(6).toString('base64url'); // e.g. "k3F9xQaZ"
    password = generatedPassword;
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const patientResult = await client.query('SELECT * FROM patients WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (patientResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Patient not found' });
    }
    const patient = patientResult.rows[0];
    if (patient.user_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This patient already has a portal account' });
    }

    const password_hash = await bcrypt.hash(password, 10);
    const userResult = await client.query(
      `INSERT INTO users (full_name, email, phone, password_hash, role, must_change_password)
       VALUES ($1,$2,$3,$4,'patient', TRUE) RETURNING id, full_name, email, role`,
      [patient.full_name, email, patient.phone, password_hash]
    );
    const user = userResult.rows[0];

    await client.query('UPDATE patients SET user_id = $1 WHERE id = $2', [user.id, patient.id]);

    await client.query('COMMIT');

    // Best-effort — if email fails (or isn't configured), the password is
    // still returned in the API response below so staff can relay it in
    // person or by phone, per the note in the response.
    if (generatedPassword) {
      await sendMail({
        to: email,
        subject: 'Your Yoma patient portal account',
        text: `Hi ${patient.full_name},\n\nAn account has been created for you on the Yoma patient portal.\n\nEmail: ${email}\nTemporary password: ${generatedPassword}\n\nYou'll be asked to set your own password the first time you log in.`,
      });
    }

    res.status(201).json({
      user,
      temporary_password: generatedPassword, // null if the caller supplied their own password
      note: 'Share this password with the patient now — it will not be shown again. They will be required to change it on first login.',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A user with this email already exists' });
    }
    res.status(500).json({ error: 'Server error creating portal account' });
  } finally {
    client.release();
  }
});

// GET /api/patients/:id/history — full clinical history in one call: past
// visits (with diagnosis/treatment notes), lab orders + results,
// prescriptions, chair/room admissions, and invoices. Built for the
// patient detail/chart view — one place to see everything about a patient
// instead of hunting across Appointments, Lab, Prescriptions, and Billing.
router.get('/:id/history', authenticate, authorize('admin', 'receptionist', 'doctor', 'nurse'), async (req, res) => {
  const patientId = req.params.id;
  try {
    const patientResult = await db.query('SELECT * FROM patients WHERE id = $1', [patientId]);
    if (patientResult.rows.length === 0) {
      return res.status(404).json({ error: 'Patient not found' });
    }

    const [appointments, labOrders, prescriptions, admissions, invoices, inventoryUsage] = await Promise.all([
      db.query(
        `SELECT a.id, a.scheduled_at, a.status, a.reason, a.token_number,
                u.full_name AS doctor_name, c.diagnosis, c.doctor_notes
         FROM appointments a
         LEFT JOIN users u ON u.id = a.doctor_id
         LEFT JOIN consultations c ON c.appointment_id = a.id
         WHERE a.patient_id = $1
         ORDER BY a.scheduled_at DESC`,
        [patientId]
      ),
      db.query(
        `SELECT lo.id, lo.test_name, lo.status, lo.ordered_at,
                u.full_name AS ordered_by_name,
                lr.result_text, lr.result_file_url, lr.file_name, lr.entered_at
         FROM lab_orders lo
         LEFT JOIN users u ON u.id = lo.ordered_by
         LEFT JOIN lab_results lr ON lr.lab_order_id = lo.id
         WHERE lo.patient_id = $1
         ORDER BY lo.ordered_at DESC`,
        [patientId]
      ),
      db.query(
        `SELECT p.id, p.created_at, u.full_name AS prescribed_by_name
         FROM prescriptions p
         JOIN users u ON u.id = p.prescribed_by
         WHERE p.patient_id = $1
         ORDER BY p.created_at DESC`,
        [patientId]
      ),
      db.query(
        `SELECT ad.id, ad.admitted_at, ad.discharged_at, ad.status, ad.admission_reason, ad.discharge_summary,
                u.full_name AS doctor_name, b.bed_number AS chair_number, w.name AS room_name
         FROM admissions ad
         LEFT JOIN users u ON u.id = ad.attending_doctor_id
         LEFT JOIN beds b ON b.id = ad.bed_id
         LEFT JOIN wards w ON w.id = b.ward_id
         WHERE ad.patient_id = $1
         ORDER BY ad.admitted_at DESC`,
        [patientId]
      ),
      db.query(
        `SELECT id, total_amount, amount_paid, status, created_at
         FROM invoices WHERE patient_id = $1 ORDER BY created_at DESC`,
        [patientId]
      ),
      db.query(
        `SELECT iu.appointment_id, iu.quantity, iu.used_at, i.name AS item_name
         FROM inventory_usage iu
         JOIN inventory_items i ON i.id = iu.item_id
         JOIN appointments a ON a.id = iu.appointment_id
         WHERE a.patient_id = $1`,
        [patientId]
      ),
    ]);

    // Batch-fetch prescription items for every prescription found above,
    // then group them back onto each prescription in JS (avoids N+1 queries).
    const prescriptionIds = prescriptions.rows.map((p) => p.id);
    let itemsByPrescription = {};
    if (prescriptionIds.length > 0) {
      const items = await db.query(
        `SELECT pi.prescription_id, pi.dosage, pi.frequency, pi.duration_days, m.name AS medicine_name
         FROM prescription_items pi
         JOIN inventory_items m ON m.id = pi.medicine_id
         WHERE pi.prescription_id = ANY($1::int[])`,
        [prescriptionIds]
      );
      itemsByPrescription = items.rows.reduce((acc, item) => {
        (acc[item.prescription_id] = acc[item.prescription_id] || []).push(item);
        return acc;
      }, {});
    }
    const prescriptionsWithItems = prescriptions.rows.map((p) => ({
      ...p,
      items: itemsByPrescription[p.id] || [],
    }));

    const usageByAppointment = inventoryUsage.rows.reduce((acc, u) => {
      (acc[u.appointment_id] = acc[u.appointment_id] || []).push({ item_name: u.item_name, quantity: u.quantity });
      return acc;
    }, {});
    const appointmentsWithUsage = appointments.rows.map((a) => ({
      ...a,
      items_used: usageByAppointment[a.id] || [],
    }));

    res.json({
      patient: patientResult.rows[0],
      appointments: appointmentsWithUsage,
      lab_orders: labOrders.rows,
      prescriptions: prescriptionsWithItems,
      admissions: admissions.rows,
      invoices: invoices.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching patient history' });
  }
});

module.exports = router;
