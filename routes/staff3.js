const express = require('express');
const db = require('../config/db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// GET /api/staff?role=doctor&search=bekele
// Any authenticated user can look up staff by name — needed to build
// patient-facing bookings and internal pickers (e.g. "which doctor").
router.get('/', authenticate, async (req, res) => {
  const { role, search } = req.query;
  const conditions = ['u.is_active = TRUE'];
  const values = [];
  let i = 1;

  if (role) { conditions.push(`u.role = $${i++}`); values.push(role); }
  if (search) { conditions.push(`u.full_name ILIKE $${i++}`); values.push(`%${search}%`); }

  try {
    const result = await db.query(
      `SELECT u.id, u.full_name, u.role, u.email, sp.specialty, sp.department, sp.consultation_fee
       FROM users u
       LEFT JOIN staff_profiles sp ON sp.user_id = u.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY u.full_name
       LIMIT 50`,
      values
    );
    res.json({ staff: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching staff' });
  }
});

// ---------- DOCTOR AVAILABILITY ----------
// Admin-only to manage (even for a doctor managing their own hours) — a
// deliberate choice: all scheduling, including a doctor's own working
// hours, goes through admin. Doctors can view but not self-edit.

function canManageAvailability(req) {
  return req.user.role === 'admin';
}

// GET /api/staff/:id/availability — anyone authenticated can view (needed
// by the booking picker and by the "warn if outside hours" check).
router.get('/:id/availability', authenticate, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM doctor_availability WHERE doctor_id = $1 ORDER BY day_of_week, start_time`,
      [req.params.id]
    );
    res.json({ availability: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching availability' });
  }
});

// POST /api/staff/:id/availability — admin only. Doctors can view their
// own hours (see the GET above) but never set them — see the
// canManageAvailability comment above for why.
// body: { day_of_week (0-6, Sun-Sat), start_time ("09:00"), end_time ("13:00"), slot_minutes? }
router.post('/:id/availability', authenticate, async (req, res) => {
  if (!canManageAvailability(req)) {
    return res.status(403).json({ error: 'Only admin can manage doctor availability' });
  }
  const { day_of_week, start_time, end_time, slot_minutes } = req.body;
  if (day_of_week === undefined || !start_time || !end_time) {
    return res.status(400).json({ error: 'day_of_week, start_time, and end_time are required' });
  }
  if (day_of_week < 0 || day_of_week > 6) {
    return res.status(400).json({ error: 'day_of_week must be 0 (Sunday) through 6 (Saturday)' });
  }
  if (start_time >= end_time) {
    return res.status(400).json({ error: 'start_time must be before end_time' });
  }

  try {
    const result = await db.query(
      `INSERT INTO doctor_availability (doctor_id, day_of_week, start_time, end_time, slot_minutes)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.id, day_of_week, start_time, end_time, slot_minutes || 15]
    );
    res.status(201).json({ availability: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error creating availability window' });
  }
});

// DELETE /api/staff/:id/availability/:availabilityId
router.delete('/:id/availability/:availabilityId', authenticate, async (req, res) => {
  if (!canManageAvailability(req)) {
    return res.status(403).json({ error: 'Only admin can manage doctor availability' });
  }
  try {
    const result = await db.query(
      `DELETE FROM doctor_availability WHERE id = $1 AND doctor_id = $2 RETURNING *`,
      [req.params.availabilityId, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Availability window not found' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error deleting availability window' });
  }
});

module.exports = router;
