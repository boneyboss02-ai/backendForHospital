const express = require('express');
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { createNotification } = require('../utils/notifications');

const router = express.Router();

// Prescriptions are pure documentation now — the doctor writes what the
// patient should take, the patient sees it in their portal (and can show it
// to any outside pharmacy). There's no in-house dispense/auto-bill step
// anymore (see migration_005_inventory.sql for why), so prescription_items
// no longer has a meaningful "pending" state — every item created here is
// just part of the record from the moment it's written.

// POST /api/prescriptions — doctor prescribes one or more medicines
// body: { patient_id, appointment_id?, admission_id?, items: [{ medicine_id, dosage, frequency, duration_days }] }
router.post('/', authenticate, authorize('doctor'), async (req, res) => {
  const { patient_id, appointment_id, admission_id, items } = req.body;

  if (!patient_id || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'patient_id and a non-empty items array are required' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const prescriptionResult = await client.query(
      `INSERT INTO prescriptions (patient_id, appointment_id, admission_id, prescribed_by)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [patient_id, appointment_id || null, admission_id || null, req.user.id]
    );
    const prescription = prescriptionResult.rows[0];

    const insertedItems = [];
    for (const item of items) {
      const { medicine_id, dosage, frequency, duration_days } = item;
      if (!medicine_id) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Each item requires a medicine_id' });
      }
      const itemResult = await client.query(
        `INSERT INTO prescription_items (prescription_id, medicine_id, dosage, frequency, duration_days)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [prescription.id, medicine_id, dosage, frequency, duration_days]
      );
      insertedItems.push(itemResult.rows[0]);
    }

    const patientUser = await client.query('SELECT user_id FROM patients WHERE id = $1', [patient_id]);
    if (patientUser.rows[0]?.user_id) {
      await createNotification(client, {
        user_id: patientUser.rows[0].user_id,
        type: 'prescription',
        title: 'New prescription',
        message: `A new prescription with ${insertedItems.length} item(s) has been added to your record.`,
        related_type: 'prescription',
        related_id: prescription.id,
      });
    }

    await client.query('COMMIT');
    res.status(201).json({ prescription, items: insertedItems });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error creating prescription' });
  } finally {
    client.release();
  }
});

// GET /api/prescriptions?patient_id=
// Staff-only — patient_id is caller-supplied. Patients use /api/portal/prescriptions.
router.get('/', authenticate, authorize('admin', 'doctor', 'nurse'), async (req, res) => {
  const { patient_id, date } = req.query;
  const conditions = [];
  const values = [];
  let i = 1;
  if (patient_id) { conditions.push(`p.patient_id = $${i++}`); values.push(patient_id); }
  if (date) { conditions.push(`p.created_at::date = $${i++}::date`); values.push(date); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const result = await db.query(
      `SELECT p.*, pat.full_name AS patient_name, pat.patient_code, u.full_name AS prescribed_by_name
       FROM prescriptions p
       JOIN patients pat ON pat.id = p.patient_id
       JOIN users u ON u.id = p.prescribed_by
       ${where}
       ORDER BY p.created_at DESC`,
      values
    );
    res.json({ prescriptions: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching prescriptions' });
  }
});

// GET /api/prescriptions/:id — full detail with items
// Staff-only — patients use /api/portal/prescriptions/:id, which checks
// ownership server-side rather than trusting the id in the URL.
router.get('/:id', authenticate, authorize('admin', 'doctor', 'nurse'), async (req, res) => {
  try {
    const prescription = await db.query(
      `SELECT p.*, pat.full_name AS patient_name, pat.patient_code, u.full_name AS prescribed_by_name
       FROM prescriptions p
       JOIN patients pat ON pat.id = p.patient_id
       JOIN users u ON u.id = p.prescribed_by
       WHERE p.id = $1`,
      [req.params.id]
    );
    if (prescription.rows.length === 0) return res.status(404).json({ error: 'Prescription not found' });

    const items = await db.query(
      `SELECT pi.*, m.name AS medicine_name, m.unit
       FROM prescription_items pi
       JOIN inventory_items m ON m.id = pi.medicine_id
       WHERE pi.prescription_id = $1`,
      [req.params.id]
    );

    res.json({ prescription: prescription.rows[0], items: items.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching prescription' });
  }
});

module.exports = router;
