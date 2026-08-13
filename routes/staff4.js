const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { sendMail } = require('../utils/mailer');
const { isBranchScoped } = require('../utils/branchScope');

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

// ---------- STAFF MANAGEMENT (branch-aware) ----------
// Separate from the GET / above on purpose — that one is a broad,
// lightweight lookup any staff role can use for booking pickers. These are
// admin-only management endpoints with fuller detail (branch, contact
// info, active status) and branch scoping.

// GET /api/staff/directory — admin only. A general admin sees every
// branch's staff; a branch admin sees only their own branch's.
router.get('/directory', authenticate, authorize('admin'), async (req, res) => {
  const conditions = [];
  const values = [];
  let i = 1;
  if (isBranchScoped(req)) {
    conditions.push(`u.branch_id = $${i++}`);
    values.push(req.user.branch_id);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const result = await db.query(
      `SELECT u.id, u.full_name, u.email, u.phone, u.role, u.branch_id, u.is_active, u.created_at,
              b.name AS branch_name, sp.specialty, sp.department, sp.consultation_fee
       FROM users u
       LEFT JOIN branches b ON b.id = u.branch_id
       LEFT JOIN staff_profiles sp ON sp.user_id = u.id
       ${where}
       ORDER BY u.full_name`,
      values
    );
    res.json({ staff: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching staff directory' });
  }
});

// POST /api/staff — create a new staff account. There was previously no
// in-app way to do this at all (staff accounts had to be inserted
// directly in the database) — this is also the first time that gap gets
// closed, not just a branch-aware version of something that existed.
//
// A general admin can create any staff role, including another admin
// (general or branch-scoped), at any branch.
// A branch admin can only create doctor/nurse/receptionist, and only
// within their own branch — branch_id is forced to their own regardless
// of what's sent, rather than trusting the request.
//
// Password: same pattern as inviting a patient to the portal (see
// routes/patients.js) — auto-generate one if not supplied, email it
// best-effort, and also return it in the response so staff can relay it
// in person if email isn't set up or doesn't arrive.
router.post('/', authenticate, authorize('admin'), async (req, res) => {
  const { full_name, email, phone, role, specialty, department, consultation_fee } = req.body;
  let { password, branch_id } = req.body;

  if (!full_name || !email || !role) {
    return res.status(400).json({ error: 'full_name, email, and role are required' });
  }

  const callerIsGeneralAdmin = !isBranchScoped(req);
  if (!callerIsGeneralAdmin) {
    if (role !== 'doctor' && role !== 'nurse' && role !== 'receptionist') {
      return res.status(403).json({ error: 'A branch admin can only create doctor, nurse, or receptionist accounts' });
    }
    branch_id = req.user.branch_id; // forced, not trusted from the request
  } else {
    if (!['admin', 'doctor', 'nurse', 'receptionist'].includes(role)) {
      return res.status(400).json({ error: 'role must be admin, doctor, nurse, or receptionist' });
    }
    if (role !== 'admin' && !branch_id) {
      return res.status(400).json({ error: 'branch_id is required for this role' });
    }
    // An admin with no branch_id is a general admin — allowed, but every
    // other role must belong to exactly one branch.
  }

  let generatedPassword = null;
  if (!password) {
    generatedPassword = crypto.randomBytes(6).toString('base64url');
    password = generatedPassword;
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const password_hash = await bcrypt.hash(password, 10);
    const userResult = await client.query(
      `INSERT INTO users (full_name, email, phone, password_hash, role, branch_id, must_change_password)
       VALUES ($1,$2,$3,$4,$5,$6,TRUE)
       RETURNING id, full_name, email, phone, role, branch_id`,
      [full_name, email, phone || null, password_hash, role, branch_id || null]
    );
    const user = userResult.rows[0];

    if (role === 'doctor' && (specialty || department || consultation_fee !== undefined)) {
      await client.query(
        `INSERT INTO staff_profiles (user_id, specialty, department, consultation_fee) VALUES ($1,$2,$3,$4)`,
        [user.id, specialty || null, department || null, consultation_fee || null]
      );
    }

    await client.query('COMMIT');

    if (generatedPassword) {
      await sendMail({
        to: email,
        subject: 'Your Yoma staff account',
        text: `Hi ${full_name},\n\nAn account has been created for you on Yoma.\n\nEmail: ${email}\nTemporary password: ${generatedPassword}\n\nYou'll be asked to set your own password the first time you log in.`,
      });
    }

    res.status(201).json({
      user,
      temporary_password: generatedPassword,
      note: 'Share this password with them now — it will not be shown again. They will be required to change it on first login.',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error creating staff account' });
  } finally {
    client.release();
  }
});

// PATCH /api/staff/:id/branch — move an existing staff member to a
// different branch, or (for an admin only) promote/demote between general
// admin and branch admin by setting/clearing branch_id. General-admin-only
// — moving someone between branches, or changing whether someone IS a
// general admin, is an org-level call, not something a branch admin makes
// even about their own staff.
router.patch('/:id/branch', authenticate, authorize('admin'), async (req, res) => {
  if (isBranchScoped(req)) {
    return res.status(403).json({ error: 'Only a general admin can reassign staff between branches' });
  }
  const { branch_id } = req.body;

  try {
    const target = await db.query('SELECT id, role FROM users WHERE id = $1', [req.params.id]);
    if (target.rows.length === 0) return res.status(404).json({ error: 'Staff account not found' });
    if (target.rows[0].role !== 'admin' && !branch_id) {
      return res.status(400).json({ error: 'Only an admin account can have no branch' });
    }

    const result = await db.query(
      'UPDATE users SET branch_id = $1 WHERE id = $2 RETURNING id, full_name, role, branch_id',
      [branch_id || null, req.params.id]
    );
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error reassigning branch' });
  }
});


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
