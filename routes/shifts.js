const express = require('express');
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

// POST /api/shifts — admin assigns a staff member to a shift
// body: { user_id, shift_date, start_time, end_time, ward_id?, note? }
router.post('/', authenticate, authorize('admin'), async (req, res) => {
  const { user_id, ward_id, shift_date, start_time, end_time, note } = req.body;
  if (!user_id || !shift_date || !start_time || !end_time) {
    return res.status(400).json({ error: 'user_id, shift_date, start_time, and end_time are required' });
  }
  if (start_time >= end_time) {
    return res.status(400).json({ error: 'start_time must be before end_time' });
  }

  try {
    const result = await db.query(
      `INSERT INTO shifts (user_id, ward_id, shift_date, start_time, end_time, note)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [user_id, ward_id || null, shift_date, start_time, end_time, note || null]
    );
    res.status(201).json({ shift: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error creating shift' });
  }
});

// GET /api/shifts?date=&user_id=&ward_id= — "who's on duty" view.
// Any staff role can view this (not patients) — knowing which nurse is on
// duty isn't sensitive, and reception/doctors need it day-to-day too.
router.get('/', authenticate, authorize('admin', 'doctor', 'nurse', 'receptionist', 'pharmacist'), async (req, res) => {
  const { date, user_id, ward_id } = req.query;
  const conditions = [];
  const values = [];
  let i = 1;
  if (date) { conditions.push(`s.shift_date = $${i++}`); values.push(date); }
  if (user_id) { conditions.push(`s.user_id = $${i++}`); values.push(user_id); }
  if (ward_id) { conditions.push(`s.ward_id = $${i++}`); values.push(ward_id); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const result = await db.query(
      `SELECT s.*, u.full_name AS staff_name, u.role AS staff_role, w.name AS ward_name
       FROM shifts s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN wards w ON w.id = s.ward_id
       ${where}
       ORDER BY s.shift_date, s.start_time`,
      values
    );
    res.json({ shifts: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching shifts' });
  }
});

// DELETE /api/shifts/:id — admin removes a shift assignment
router.delete('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const result = await db.query('DELETE FROM shifts WHERE id = $1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Shift not found' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error deleting shift' });
  }
});

module.exports = router;
