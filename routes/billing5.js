const express = require('express');
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

async function recalculateInvoiceStatus(client, invoiceId) {
  const result = await client.query(
    `SELECT total_amount, amount_paid FROM invoices WHERE id = $1`,
    [invoiceId]
  );
  if (result.rows.length === 0) return;
  const { total_amount, amount_paid } = result.rows[0];

  let status = 'unpaid';
  if (Number(amount_paid) >= Number(total_amount) && Number(total_amount) > 0) {
    status = 'paid';
  } else if (Number(amount_paid) > 0) {
    status = 'partially_paid';
  }
  await client.query(`UPDATE invoices SET status = $1 WHERE id = $2`, [status, invoiceId]);
}

// ---------- INVOICES ----------

// POST /api/billing/invoices — create an invoice, optionally with initial line items
// body: { patient_id, appointment_id?, admission_id?, items?: [{description, quantity, unit_price}] }
router.post('/invoices', authenticate, authorize('admin', 'receptionist'), async (req, res) => {
  const { patient_id, appointment_id, admission_id, items, due_date } = req.body;
  if (!patient_id) return res.status(400).json({ error: 'patient_id is required' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const invoiceResult = await client.query(
      `INSERT INTO invoices (patient_id, appointment_id, admission_id, due_date) VALUES ($1,$2,$3,$4) RETURNING *`,
      [patient_id, appointment_id || null, admission_id || null, due_date || null]
    );
    let invoice = invoiceResult.rows[0];

    let total = 0;
    if (Array.isArray(items)) {
      for (const item of items) {
        const { description, quantity, unit_price } = item;
        if (!description || !unit_price) continue;
        const qty = quantity || 1;
        const lineTotal = qty * unit_price;
        total += lineTotal;
        await client.query(
          `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, line_total)
           VALUES ($1,$2,$3,$4,$5)`,
          [invoice.id, description, qty, unit_price, lineTotal]
        );
      }
    }

    if (total > 0) {
      const updated = await client.query(
        `UPDATE invoices SET total_amount = total_amount + $1 WHERE id = $2 RETURNING *`,
        [total, invoice.id]
      );
      invoice = updated.rows[0];
    }

    await client.query('COMMIT');
    res.status(201).json({ invoice });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error creating invoice' });
  } finally {
    client.release();
  }
});

// PATCH /api/billing/invoices/:id/due-date — set or clear a payment deadline.
// Separate from invoice creation since reception often decides this after
// the fact (e.g. "give them until Friday" once they know the patient can't
// pay today).
router.patch('/invoices/:id/due-date', authenticate, authorize('admin', 'receptionist'), async (req, res) => {
  const { due_date } = req.body;
  try {
    const result = await db.query(
      'UPDATE invoices SET due_date = $1 WHERE id = $2 RETURNING *',
      [due_date || null, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Invoice not found' });
    res.json({ invoice: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error updating due date' });
  }
});

// GET /api/billing/invoices?patient_id=&status=&from=&to=&overdue=true
// Admin/receptionist see everything (patient_id is caller-supplied). A
// doctor can view this too — read-only, and only for patients they
// actually treat (same relationship check used everywhere else a doctor
// touches patient data) — they can't create invoices, add items, take
// payments, or review payment proofs; that stays reception/admin work.
// Patients use /api/portal/invoices instead.
router.get('/invoices', authenticate, authorize('admin', 'receptionist', 'doctor'), async (req, res) => {
  const { patient_id, status, from, to, overdue } = req.query;
  const conditions = [];
  const values = [];
  let i = 1;
  if (req.user.role === 'doctor') {
    conditions.push(
      `i.patient_id IN (SELECT patient_id FROM appointments WHERE doctor_id = $${i++}
                        UNION SELECT patient_id FROM admissions WHERE attending_doctor_id = $${i - 1})`
    );
    values.push(req.user.id);
  }
  if (patient_id) { conditions.push(`i.patient_id = $${i++}`); values.push(patient_id); }
  if (status) { conditions.push(`i.status = $${i++}`); values.push(status); }
  if (from) { conditions.push(`i.created_at::date >= $${i++}::date`); values.push(from); }
  if (to) { conditions.push(`i.created_at::date <= $${i++}::date`); values.push(to); }
  if (overdue === 'true') {
    conditions.push(`i.due_date IS NOT NULL AND i.due_date < CURRENT_DATE AND i.status IN ('unpaid', 'partially_paid')`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const result = await db.query(
      `SELECT i.*, p.full_name AS patient_name, p.patient_code,
              (i.due_date IS NOT NULL AND i.due_date < CURRENT_DATE AND i.status IN ('unpaid', 'partially_paid')) AS is_overdue
       FROM invoices i
       JOIN patients p ON p.id = i.patient_id
       ${where}
       ORDER BY i.created_at DESC`,
      values
    );
    res.json({ invoices: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching invoices' });
  }
});

// GET /api/billing/invoices/:id — full detail with line items and payments.
// Same doctor-scoping as the list above.
router.get('/invoices/:id', authenticate, authorize('admin', 'receptionist', 'doctor'), async (req, res) => {
  try {
    const invoice = await db.query(
      `SELECT i.*, p.full_name AS patient_name, p.patient_code
       FROM invoices i JOIN patients p ON p.id = i.patient_id
       WHERE i.id = $1`,
      [req.params.id]
    );
    if (invoice.rows.length === 0) return res.status(404).json({ error: 'Invoice not found' });

    if (req.user.role === 'doctor') {
      const related = await db.query(
        `SELECT 1 FROM appointments WHERE doctor_id = $1 AND patient_id = $2
         UNION SELECT 1 FROM admissions WHERE attending_doctor_id = $1 AND patient_id = $2`,
        [req.user.id, invoice.rows[0].patient_id]
      );
      if (related.rows.length === 0) {
        return res.status(403).json({ error: 'You have no appointments or admissions with this patient' });
      }
    }

    const items = await db.query('SELECT * FROM invoice_items WHERE invoice_id = $1', [req.params.id]);
    const payments = await db.query('SELECT * FROM payments WHERE invoice_id = $1 ORDER BY paid_at DESC', [req.params.id]);

    res.json({ invoice: invoice.rows[0], items: items.rows, payments: payments.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching invoice' });
  }
});

// POST /api/billing/invoices/:id/items — add a line item to an existing invoice
router.post('/invoices/:id/items', authenticate, authorize('admin', 'receptionist'), async (req, res) => {
  const { description, quantity, unit_price } = req.body;
  if (!description || !unit_price) {
    return res.status(400).json({ error: 'description and unit_price are required' });
  }
  const qty = quantity || 1;
  const lineTotal = qty * unit_price;

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const item = await client.query(
      `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, line_total)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.id, description, qty, unit_price, lineTotal]
    );
    const invoiceUpdate = await client.query(
      `UPDATE invoices SET total_amount = total_amount + $1 WHERE id = $2 RETURNING *`,
      [lineTotal, req.params.id]
    );
    if (invoiceUpdate.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Invoice not found' });
    }
    await recalculateInvoiceStatus(client, req.params.id);
    await client.query('COMMIT');
    res.status(201).json({ item: item.rows[0], invoice: invoiceUpdate.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error adding invoice item' });
  } finally {
    client.release();
  }
});

// ---------- PAYMENTS ----------

// POST /api/billing/invoices/:id/payments — record a payment against an invoice
router.post('/invoices/:id/payments', authenticate, authorize('admin', 'receptionist'), async (req, res) => {
  const { amount, method } = req.body;
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const invoiceCheck = await client.query('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (invoiceCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const payment = await client.query(
      `INSERT INTO payments (invoice_id, amount, method) VALUES ($1,$2,$3) RETURNING *`,
      [req.params.id, amount, method || 'cash']
    );

    const updatedInvoice = await client.query(
      `UPDATE invoices SET amount_paid = amount_paid + $1 WHERE id = $2 RETURNING *`,
      [amount, req.params.id]
    );

    await recalculateInvoiceStatus(client, req.params.id);

    const finalInvoice = await client.query('SELECT * FROM invoices WHERE id = $1', [req.params.id]);

    await client.query('COMMIT');
    res.status(201).json({ payment: payment.rows[0], invoice: finalInvoice.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error recording payment' });
  } finally {
    client.release();
  }
});

module.exports = router;
