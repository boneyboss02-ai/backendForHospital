const express = require('express');
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { isWithinWorkingHours, isTimeSlotTaken } = require('../utils/availability');
const { createNotification } = require('../utils/notifications');

const router = express.Router();

// Every route below is patient-only, and every query is scoped to
// req.patient.id — never to a patient_id read from the request. This is the
// whole point of this file: a patient cannot ever pass someone else's id
// and see their data, because we never look at anything but req.user.id
// to figure out whose data to fetch.
router.use(authenticate, authorize('patient'));

router.use(async (req, res, next) => {
  try {
    const result = await db.query('SELECT * FROM patients WHERE user_id = $1', [req.user.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No patient record is linked to this account' });
    }
    req.patient = result.rows[0];
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error loading patient record' });
  }
});

// GET /api/portal/me
router.get('/me', (req, res) => {
  res.json({ patient: req.patient });
});

// PUT /api/portal/me — patient updates their own contact info / medical
// history fields (not full_name, date_of_birth, or patient_code — those
// stay staff-managed to keep identity records reliable).
router.put('/me', async (req, res) => {
  const fields = ['phone', 'address', 'blood_group', 'allergies', 'chronic_conditions', 'emergency_contact_name', 'emergency_contact_phone'];
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
  if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });
  values.push(req.patient.id);
  try {
    const result = await db.query(`UPDATE patients SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`, values);
    res.json({ patient: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error updating profile' });
  }
});

// ---------- APPOINTMENTS ----------

// GET /api/portal/appointments?status=
router.get('/appointments', async (req, res) => {
  const { status } = req.query;
  const conditions = ['a.patient_id = $1'];
  const values = [req.patient.id];
  if (status) { conditions.push(`a.status = $2`); values.push(status); }
  try {
    const result = await db.query(
      `SELECT a.*, u.full_name AS doctor_name, sp.specialty
       FROM appointments a
       JOIN users u ON u.id = a.doctor_id
       LEFT JOIN staff_profiles sp ON sp.user_id = u.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY a.scheduled_at DESC`,
      values
    );
    res.json({ appointments: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching appointments' });
  }
});

// POST /api/portal/appointments — self-book, same availability rules staff use
// body: { doctor_id, scheduled_at, reason? }
router.post('/appointments', async (req, res) => {
  const { doctor_id, scheduled_at, reason } = req.body;
  if (!doctor_id || !scheduled_at) {
    return res.status(400).json({ error: 'doctor_id and scheduled_at are required' });
  }

  let warning = null;
  try {
    const taken = await isTimeSlotTaken(doctor_id, scheduled_at);
    if (taken) {
      return res.status(409).json({ error: 'That exact time is already taken. Please pick a different time.' });
    }
    const withinHours = await isWithinWorkingHours(doctor_id, scheduled_at);
    if (!withinHours) {
      warning = "This time is outside the doctor's usual working hours — it will still be booked, but double check with the clinic if you're not sure it's OK.";
    }
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Invalid scheduled_at' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const day = new Date(scheduled_at).toISOString().slice(0, 10);
    const tokenResult = await client.query(
      `SELECT COALESCE(MAX(token_number), 0) + 1 AS next_token
       FROM appointments WHERE doctor_id = $1 AND scheduled_at::date = $2::date`,
      [doctor_id, day]
    );
    const token_number = tokenResult.rows[0].next_token;

    const result = await client.query(
      `INSERT INTO appointments (patient_id, doctor_id, scheduled_at, token_number, reason)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.patient.id, doctor_id, scheduled_at, token_number, reason || null]
    );
    const appointment = result.rows[0];

    await createNotification(client, {
      user_id: doctor_id,
      type: 'appointment_booked',
      title: 'New appointment',
      message: `${req.patient.full_name} booked an appointment with you for ${new Date(scheduled_at).toLocaleString()}.`,
      related_type: 'appointment',
      related_id: appointment.id,
    });

    await client.query('COMMIT');
    res.status(201).json({ appointment, warning });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'That slot was just booked by someone else. Please pick another.' });
    }
    res.status(500).json({ error: 'Server error booking appointment' });
  } finally {
    client.release();
  }
});

// PATCH /api/portal/appointments/:id/cancel — patient cancels their own
// upcoming appointment (only while still 'scheduled', not after check-in).
router.patch('/appointments/:id/cancel', async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE appointments SET status = 'cancelled'
       WHERE id = $1 AND patient_id = $2 AND status = 'scheduled'
       RETURNING *`,
      [req.params.id, req.patient.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Appointment not found, not yours, or can no longer be cancelled' });
    }
    res.json({ appointment: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error cancelling appointment' });
  }
});

// ---------- LAB RESULTS ----------

// GET /api/portal/lab-results
router.get('/lab-results', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT lo.*, u.full_name AS ordered_by_name
       FROM lab_orders lo JOIN users u ON u.id = lo.ordered_by
       WHERE lo.patient_id = $1
       ORDER BY lo.ordered_at DESC`,
      [req.patient.id]
    );
    res.json({ orders: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching lab results' });
  }
});

// GET /api/portal/lab-results/:id — order + result detail (ownership enforced)
router.get('/lab-results/:id', async (req, res) => {
  try {
    const order = await db.query(
      `SELECT lo.*, u.full_name AS ordered_by_name
       FROM lab_orders lo JOIN users u ON u.id = lo.ordered_by
       WHERE lo.id = $1 AND lo.patient_id = $2`,
      [req.params.id, req.patient.id]
    );
    if (order.rows.length === 0) return res.status(404).json({ error: 'Lab order not found' });

    const results = await db.query(
      `SELECT id, result_text, file_name, file_mime, file_size, entered_at
       FROM lab_results WHERE lab_order_id = $1 ORDER BY entered_at DESC`,
      [req.params.id]
    );
    res.json({ order: order.rows[0], results: results.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching lab order' });
  }
});

// ---------- PRESCRIPTIONS ----------

// GET /api/portal/prescriptions
router.get('/prescriptions', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT p.*, u.full_name AS prescribed_by_name
       FROM prescriptions p JOIN users u ON u.id = p.prescribed_by
       WHERE p.patient_id = $1 ORDER BY p.created_at DESC`,
      [req.patient.id]
    );
    res.json({ prescriptions: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching prescriptions' });
  }
});

// GET /api/portal/prescriptions/:id
router.get('/prescriptions/:id', async (req, res) => {
  try {
    const prescription = await db.query(
      `SELECT p.*, u.full_name AS prescribed_by_name
       FROM prescriptions p JOIN users u ON u.id = p.prescribed_by
       WHERE p.id = $1 AND p.patient_id = $2`,
      [req.params.id, req.patient.id]
    );
    if (prescription.rows.length === 0) return res.status(404).json({ error: 'Prescription not found' });

    const items = await db.query(
      `SELECT pi.id, pi.dosage, pi.frequency, pi.duration_days, pi.dispensed, m.name AS medicine_name, m.unit
       FROM prescription_items pi JOIN medicines m ON m.id = pi.medicine_id
       WHERE pi.prescription_id = $1`,
      [req.params.id]
    );
    res.json({ prescription: prescription.rows[0], items: items.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching prescription' });
  }
});

// ---------- BILLING ----------

// GET /api/portal/invoices
router.get('/invoices', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM invoices WHERE patient_id = $1 ORDER BY created_at DESC`,
      [req.patient.id]
    );
    res.json({ invoices: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching invoices' });
  }
});

// GET /api/portal/invoices/:id
router.get('/invoices/:id', async (req, res) => {
  try {
    const invoice = await db.query(
      `SELECT * FROM invoices WHERE id = $1 AND patient_id = $2`,
      [req.params.id, req.patient.id]
    );
    if (invoice.rows.length === 0) return res.status(404).json({ error: 'Invoice not found' });

    const items = await db.query('SELECT * FROM invoice_items WHERE invoice_id = $1', [req.params.id]);
    const payments = await db.query('SELECT * FROM payments WHERE invoice_id = $1 ORDER BY paid_at DESC', [req.params.id]);
    res.json({ invoice: invoice.rows[0], items: items.rows, payments: payments.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching invoice' });
  }
});

module.exports = router;
