const express = require('express');
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { createNotification } = require('../utils/notifications');

const router = express.Router();

// ---------- MEDICINE INVENTORY ----------

// GET /api/pharmacy/medicines?search=&low_stock=true
router.get('/medicines', authenticate, async (req, res) => {
  const { search, low_stock } = req.query;
  const conditions = [];
  const values = [];
  let i = 1;
  if (search) { conditions.push(`name ILIKE $${i++}`); values.push(`%${search}%`); }
  if (low_stock === 'true') { conditions.push(`stock_quantity <= reorder_level`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const result = await db.query(`SELECT * FROM medicines ${where} ORDER BY name`, values);
    res.json({ medicines: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching medicines' });
  }
});

// POST /api/pharmacy/medicines — add a medicine to inventory (pharmacist/admin)
router.post('/medicines', authenticate, authorize('admin', 'pharmacist'), async (req, res) => {
  const { name, unit, stock_quantity, reorder_level, unit_price } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  try {
    const result = await db.query(
      `INSERT INTO medicines (name, unit, stock_quantity, reorder_level, unit_price)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, unit, stock_quantity || 0, reorder_level || 10, unit_price]
    );
    res.status(201).json({ medicine: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error creating medicine' });
  }
});

// PATCH /api/pharmacy/medicines/:id/stock — adjust stock (restock: positive delta, correction: negative)
router.patch('/medicines/:id/stock', authenticate, authorize('admin', 'pharmacist'), async (req, res) => {
  const { delta } = req.body;
  if (typeof delta !== 'number') {
    return res.status(400).json({ error: 'delta must be a number (e.g. 50 to restock, -5 to correct)' });
  }

  try {
    const result = await db.query(
      `UPDATE medicines SET stock_quantity = stock_quantity + $1 WHERE id = $2 RETURNING *`,
      [delta, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Medicine not found' });
    if (result.rows[0].stock_quantity < 0) {
      return res.status(409).json({ error: 'Adjustment would result in negative stock' });
    }
    res.json({ medicine: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error adjusting stock' });
  }
});

// ---------- PRESCRIPTIONS ----------

// POST /api/pharmacy/prescriptions — doctor prescribes one or more medicines
// body: { patient_id, appointment_id?, admission_id?, items: [{ medicine_id, dosage, frequency, duration_days }] }
router.post('/prescriptions', authenticate, authorize('doctor'), async (req, res) => {
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

// GET /api/pharmacy/prescriptions?patient_id=&pending=true
// pending=true returns prescriptions that still have undispensed items (the pharmacy queue)
// Staff-only — patient_id is caller-supplied. Patients use /api/portal/prescriptions.
router.get('/prescriptions', authenticate, authorize('admin', 'receptionist', 'doctor', 'nurse', 'pharmacist'), async (req, res) => {
  const { patient_id, pending } = req.query;
  const conditions = [];
  const values = [];
  let i = 1;
  if (patient_id) { conditions.push(`p.patient_id = $${i++}`); values.push(patient_id); }
  if (pending === 'true') {
    conditions.push(`EXISTS (SELECT 1 FROM prescription_items pi WHERE pi.prescription_id = p.id AND pi.dispensed = FALSE)`);
  }
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

// GET /api/pharmacy/prescriptions/:id — full detail with items
// Staff-only — patients use /api/portal/prescriptions/:id, which checks
// ownership server-side rather than trusting the id in the URL.
router.get('/prescriptions/:id', authenticate, authorize('admin', 'receptionist', 'doctor', 'nurse', 'pharmacist'), async (req, res) => {
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
      `SELECT pi.*, m.name AS medicine_name, m.unit, m.unit_price, m.stock_quantity
       FROM prescription_items pi
       JOIN medicines m ON m.id = pi.medicine_id
       WHERE pi.prescription_id = $1`,
      [req.params.id]
    );

    res.json({ prescription: prescription.rows[0], items: items.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching prescription' });
  }
});

// PATCH /api/pharmacy/prescription-items/:id/dispense
// Marks an item dispensed and decrements medicine stock. Also creates/updates
// a billing line so dispensed medicine shows up on the patient's invoice.
router.patch('/prescription-items/:id/dispense', authenticate, authorize('pharmacist', 'admin'), async (req, res) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const itemResult = await client.query(
      `SELECT pi.*, p.patient_id, p.appointment_id, p.admission_id, m.name AS medicine_name, m.unit_price, m.stock_quantity
       FROM prescription_items pi
       JOIN prescriptions p ON p.id = pi.prescription_id
       JOIN medicines m ON m.id = pi.medicine_id
       WHERE pi.id = $1 FOR UPDATE OF pi`,
      [req.params.id]
    );

    if (itemResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Prescription item not found' });
    }
    const item = itemResult.rows[0];

    if (item.dispensed) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Item already dispensed' });
    }

    // Reasonable default: dispense enough for the full course, 1 unit/dose as a simple stand-in
    // since dosage parsing (e.g. "1 tablet TID x5d") isn't standardized. Quantity can be
    // overridden by the pharmacist via req.body.quantity.
    const quantity = req.body.quantity && req.body.quantity > 0 ? req.body.quantity : 1;

    if (item.stock_quantity < quantity) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Not enough stock to dispense this quantity' });
    }

    await client.query(
      `UPDATE medicines SET stock_quantity = stock_quantity - $1 WHERE id = $2`,
      [quantity, item.medicine_id]
    );
    await client.query(`UPDATE prescription_items SET dispensed = TRUE WHERE id = $1`, [item.id]);

    // Find or create an open invoice for this patient/visit, then add a line item
    let invoiceResult = await client.query(
      `SELECT * FROM invoices
       WHERE patient_id = $1 AND status = 'unpaid'
         AND (appointment_id IS NOT DISTINCT FROM $2 OR admission_id IS NOT DISTINCT FROM $3)
       ORDER BY created_at DESC LIMIT 1`,
      [item.patient_id, item.appointment_id, item.admission_id]
    );

    let invoice;
    if (invoiceResult.rows.length > 0) {
      invoice = invoiceResult.rows[0];
    } else {
      const newInvoice = await client.query(
        `INSERT INTO invoices (patient_id, appointment_id, admission_id) VALUES ($1,$2,$3) RETURNING *`,
        [item.patient_id, item.appointment_id, item.admission_id]
      );
      invoice = newInvoice.rows[0];
    }

    const lineTotal = Number(item.unit_price) * quantity;
    await client.query(
      `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, line_total)
       VALUES ($1,$2,$3,$4,$5)`,
      [invoice.id, item.medicine_name, quantity, item.unit_price, lineTotal]
    );
    await client.query(
      `UPDATE invoices SET total_amount = total_amount + $1 WHERE id = $2`,
      [lineTotal, invoice.id]
    );

    await client.query('COMMIT');
    res.json({ dispensed: true, invoice_id: invoice.id });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error dispensing medicine' });
  } finally {
    client.release();
  }
});

module.exports = router;
