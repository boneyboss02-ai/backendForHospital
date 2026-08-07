const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

const PROOF_UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'payment-proofs');

// GET /api/payments/proofs?status=pending
router.get('/proofs', authenticate, authorize('admin', 'receptionist'), async (req, res) => {
  const { status } = req.query;
  const conditions = [];
  const values = [];
  let i = 1;
  if (status) { conditions.push(`pp.status = $${i++}`); values.push(status); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const result = await db.query(
      `SELECT pp.*, pat.full_name AS patient_name, pat.patient_code,
              inv.total_amount, inv.amount_paid, r.full_name AS reviewed_by_name
       FROM payment_proofs pp
       JOIN patients pat ON pat.id = pp.patient_id
       JOIN invoices inv ON inv.id = pp.invoice_id
       LEFT JOIN users r ON r.id = pp.reviewed_by
       ${where}
       ORDER BY pp.submitted_at DESC`,
      values
    );
    res.json({ proofs: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching payment proofs' });
  }
});

// GET /api/payments/proofs/:id/image — authenticated staff only, same
// pattern as lab result files: never served as a plain static file.
router.get('/proofs/:id/image', authenticate, authorize('admin', 'receptionist'), async (req, res) => {
  try {
    const result = await db.query('SELECT image_path FROM payment_proofs WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });

    const filePath = path.join(PROOF_UPLOAD_DIR, result.rows[0].image_path);
    if (!filePath.startsWith(PROOF_UPLOAD_DIR) || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    res.sendFile(filePath);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching image' });
  }
});

// PATCH /api/payments/proofs/:id/approve — records the payment and marks the proof approved
router.patch('/proofs/:id/approve', authenticate, authorize('admin', 'receptionist'), async (req, res) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const proofResult = await client.query('SELECT * FROM payment_proofs WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (proofResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Payment proof not found' });
    }
    const proof = proofResult.rows[0];
    if (proof.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `This proof was already ${proof.status}` });
    }

    const invoiceResult = await client.query('SELECT * FROM invoices WHERE id = $1', [proof.invoice_id]);
    const invoice = invoiceResult.rows[0];
    const amount = req.body.amount ? Number(req.body.amount) : Number(invoice.total_amount) - Number(invoice.amount_paid);

    await client.query(`INSERT INTO payments (invoice_id, amount, method) VALUES ($1,$2,'chapa_manual')`, [proof.invoice_id, amount]);

    const newPaid = Number(invoice.amount_paid) + amount;
    const status = newPaid >= Number(invoice.total_amount) ? 'paid' : 'partially_paid';
    await client.query(`UPDATE invoices SET amount_paid = $1, status = $2 WHERE id = $3`, [newPaid, status, proof.invoice_id]);

    await client.query(
      `UPDATE payment_proofs SET status = 'approved', reviewed_by = $1, reviewed_at = NOW() WHERE id = $2`,
      [req.user.id, req.params.id]
    );

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error approving payment proof' });
  } finally {
    client.release();
  }
});

// PATCH /api/payments/proofs/:id/reject
router.patch('/proofs/:id/reject', authenticate, authorize('admin', 'receptionist'), async (req, res) => {
  const { note } = req.body;
  try {
    const result = await db.query(
      `UPDATE payment_proofs SET status = 'rejected', reviewed_by = $1, reviewed_at = NOW(), review_note = $2
       WHERE id = $3 AND status = 'pending' RETURNING *`,
      [req.user.id, note || null, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Payment proof not found or already reviewed' });
    res.json({ proof: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error rejecting payment proof' });
  }
});

module.exports = router;
