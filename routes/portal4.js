const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { isWithinWorkingHours, isTimeSlotTaken } = require('../utils/availability');
const { createNotification } = require('../utils/notifications');

const router = express.Router();

// ---------- Payment proof upload config ----------
// Same pattern as routes/lab.js: stored outside any statically-served
// folder, only ever handed out through an authenticated route.
const PROOF_UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'payment-proofs');
fs.mkdirSync(PROOF_UPLOAD_DIR, { recursive: true });

const PROOF_ALLOWED_MIME = { 'image/jpeg': '.jpg', 'image/png': '.png' };

const proofStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PROOF_UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${PROOF_ALLOWED_MIME[file.mimetype] || ''}`),
});

const uploadProof = multer({
  storage: proofStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (!PROOF_ALLOWED_MIME[file.mimetype]) {
      return cb(new Error('Only JPG or PNG screenshots are allowed'));
    }
    cb(null, true);
  },
});

function handleProofUpload(req, res, next) {
  uploadProof.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}

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
      `SELECT id, dosage, frequency, duration_days, medicine_name
       FROM prescription_items
       WHERE prescription_id = $1`,
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
    const proofs = await db.query(
      `SELECT id, transaction_ref, status, submitted_at, review_note FROM payment_proofs
       WHERE invoice_id = $1 ORDER BY submitted_at DESC`,
      [req.params.id]
    );
    res.json({ invoice: invoice.rows[0], items: items.rows, payments: payments.rows, proofs: proofs.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching invoice' });
  }
});

// ---------- CHAPA (test mode) ----------
// Standard Chapa flow: we initialize a transaction and get back a hosted
// checkout URL, the patient pays there, Chapa redirects them back to
// return_url, and we verify server-side before ever marking anything paid
// — we never trust the redirect alone, only the verify call's response.
const CHAPA_BASE_URL = 'https://api.chapa.co/v1';

// POST /api/portal/invoices/:id/pay/chapa/initialize
router.post('/invoices/:id/pay/chapa/initialize', async (req, res) => {
  if (!process.env.CHAPA_SECRET_KEY) {
    return res.status(503).json({ error: 'Online payment is not configured yet — ask staff for the Chapa test key setup.' });
  }
  try {
    const invoiceResult = await db.query(
      `SELECT * FROM invoices WHERE id = $1 AND patient_id = $2`,
      [req.params.id, req.patient.id]
    );
    if (invoiceResult.rows.length === 0) return res.status(404).json({ error: 'Invoice not found' });
    const invoice = invoiceResult.rows[0];
    if (invoice.status === 'paid') return res.status(400).json({ error: 'This invoice is already paid' });

    const balance = Number(invoice.total_amount) - Number(invoice.amount_paid);
    const tx_ref = `yoma-${invoice.id}-${crypto.randomUUID()}`;
    const [first_name, ...rest] = (req.patient.full_name || 'Patient').split(' ');

    const chapaRes = await fetch(`${CHAPA_BASE_URL}/transaction/initialize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: String(balance),
        currency: 'ETB',
        email: req.patient.email || 'patient@yoma.clinic',
        first_name,
        last_name: rest.join(' ') || 'Patient',
        tx_ref,
        callback_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/portal/billing`,
        return_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/portal/billing?chapa_tx_ref=${tx_ref}`,
        customization: { title: 'Yoma Dental Clinic', description: `Invoice #${invoice.id}` },
      }),
    });
    const chapaData = await chapaRes.json();

    if (chapaData.status !== 'success') {
      return res.status(502).json({ error: chapaData.message || 'Chapa could not start this payment' });
    }

    await db.query(
      `INSERT INTO chapa_transactions (invoice_id, patient_id, tx_ref, amount) VALUES ($1,$2,$3,$4)`,
      [invoice.id, req.patient.id, tx_ref, balance]
    );

    res.json({ checkout_url: chapaData.data.checkout_url, tx_ref });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error starting Chapa payment' });
  }
});

// GET /api/portal/invoices/pay/chapa/verify?tx_ref=...
// Called when the patient lands back on the app after Chapa checkout.
router.get('/invoices/pay/chapa/verify', async (req, res) => {
  const { tx_ref } = req.query;
  if (!tx_ref) return res.status(400).json({ error: 'tx_ref is required' });
  if (!process.env.CHAPA_SECRET_KEY) {
    return res.status(503).json({ error: 'Online payment is not configured yet.' });
  }

  const client = await db.pool.connect();
  try {
    const txResult = await client.query(
      `SELECT * FROM chapa_transactions WHERE tx_ref = $1 AND patient_id = $2`,
      [tx_ref, req.patient.id]
    );
    if (txResult.rows.length === 0) return res.status(404).json({ error: 'Transaction not found' });
    const tx = txResult.rows[0];

    if (tx.status === 'success') {
      return res.json({ status: 'success', already_recorded: true });
    }

    const chapaRes = await fetch(`${CHAPA_BASE_URL}/transaction/verify/${tx_ref}`, {
      headers: { Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}` },
    });
    const chapaData = await chapaRes.json();
    const success = chapaData.status === 'success' && chapaData.data?.status === 'success';

    await client.query('BEGIN');
    await client.query(
      `UPDATE chapa_transactions SET status = $1, verified_at = NOW() WHERE id = $2`,
      [success ? 'success' : 'failed', tx.id]
    );

    if (success) {
      await client.query(
        `INSERT INTO payments (invoice_id, amount, method) VALUES ($1,$2,'chapa')`,
        [tx.invoice_id, tx.amount]
      );
      const invoice = await client.query('SELECT * FROM invoices WHERE id = $1', [tx.invoice_id]);
      const { total_amount, amount_paid } = invoice.rows[0];
      const newPaid = Number(amount_paid) + Number(tx.amount);
      const status = newPaid >= Number(total_amount) ? 'paid' : 'partially_paid';
      await client.query(`UPDATE invoices SET amount_paid = $1, status = $2 WHERE id = $3`, [newPaid, status, tx.invoice_id]);
    }

    await client.query('COMMIT');
    res.json({ status: success ? 'success' : 'failed' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error verifying payment' });
  } finally {
    client.release();
  }
});

// ---------- Manual proof of payment (fallback for interrupted Chapa checkouts) ----------

// POST /api/portal/invoices/:id/pay/proof — multipart: transaction_ref (text) + image (file)
router.post('/invoices/:id/pay/proof', handleProofUpload, async (req, res) => {
  const { transaction_ref } = req.body;
  if (!transaction_ref || !transaction_ref.trim()) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'A transaction reference number is required' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'A screenshot of the payment is required' });
  }

  try {
    const invoiceResult = await db.query(
      `SELECT * FROM invoices WHERE id = $1 AND patient_id = $2`,
      [req.params.id, req.patient.id]
    );
    if (invoiceResult.rows.length === 0) {
      fs.unlink(req.file.path, () => {});
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const result = await db.query(
      `INSERT INTO payment_proofs (invoice_id, patient_id, transaction_ref, image_path)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, req.patient.id, transaction_ref.trim(), req.file.filename]
    );
    res.status(201).json({ proof: result.rows[0] });
  } catch (err) {
    fs.unlink(req.file.path, () => {});
    if (err.code === '23505') { // unique_violation on transaction_ref
      return res.status(409).json({ error: 'This transaction number has already been submitted. If this is a mistake, contact the clinic.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error submitting payment proof' });
  }
});

module.exports = router;
