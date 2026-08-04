const express = require('express');
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

const CATEGORIES = ['salary', 'rent', 'utilities', 'security', 'supplies', 'other'];

// Admin-only, deliberately separate from Billing (which is patient revenue —
// money coming IN). This is money going OUT: staff salaries, rent,
// utilities, security, and anything else the clinic pays for.

// POST /api/expenses
// body: { category, description, amount, staff_id?, expense_date? }
router.post('/', authenticate, authorize('admin'), async (req, res) => {
  const { category, description, amount, staff_id, expense_date } = req.body;
  if (!category || !description || !amount || amount <= 0) {
    return res.status(400).json({ error: 'category, description, and a positive amount are required' });
  }
  if (!CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(', ')}` });
  }

  try {
    const result = await db.query(
      `INSERT INTO expenses (category, description, amount, staff_id, recorded_by, expense_date)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6, CURRENT_DATE)) RETURNING *`,
      [category, description, amount, staff_id || null, req.user.id, expense_date || null]
    );
    res.status(201).json({ expense: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error creating expense' });
  }
});

// GET /api/expenses?from=&to=&category=
router.get('/', authenticate, authorize('admin'), async (req, res) => {
  const { from, to, category } = req.query;
  const conditions = [];
  const values = [];
  let i = 1;
  if (from) { conditions.push(`e.expense_date >= $${i++}`); values.push(from); }
  if (to) { conditions.push(`e.expense_date <= $${i++}`); values.push(to); }
  if (category) { conditions.push(`e.category = $${i++}`); values.push(category); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const result = await db.query(
      `SELECT e.*, u.full_name AS staff_name, r.full_name AS recorded_by_name
       FROM expenses e
       LEFT JOIN users u ON u.id = e.staff_id
       LEFT JOIN users r ON r.id = e.recorded_by
       ${where}
       ORDER BY e.expense_date DESC, e.created_at DESC`,
      values
    );
    res.json({ expenses: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching expenses' });
  }
});

// DELETE /api/expenses/:id — for correcting mistakes
router.delete('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const result = await db.query('DELETE FROM expenses WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Expense not found' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error deleting expense' });
  }
});

module.exports = router;
