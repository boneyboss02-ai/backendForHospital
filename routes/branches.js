const express = require('express');
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { isBranchScoped } = require('../utils/branchScope');

const router = express.Router();

// GET /api/branches — every authenticated staff member can see the list
// (needed for dropdowns: the staff-creation form's branch picker, filters,
// etc). Just names/contact info, not sensitive — every OTHER
// branch-scoped endpoint in the app still only ever shows a branch-admin
// their own branch's actual data.
router.get('/', authenticate, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT b.*,
              (SELECT COUNT(*) FROM users u WHERE u.branch_id = b.id AND u.is_active = TRUE) AS staff_count
       FROM branches b ORDER BY b.name`
    );
    res.json({ branches: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching branches' });
  }
});

// POST /api/branches — general admin only. Opening a new physical
// location is an org-wide decision, not something a branch admin does —
// authorize('admin') alone isn't a fine enough check since it also
// matches branch admins, so isBranchScoped narrows it further.
router.post('/', authenticate, authorize('admin'), async (req, res) => {
  if (isBranchScoped(req)) {
    return res.status(403).json({ error: 'Only a general admin can create branches' });
  }
  const { name, address, phone } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

  try {
    const result = await db.query(
      `INSERT INTO branches (name, address, phone) VALUES ($1,$2,$3) RETURNING *`,
      [name.trim(), address || null, phone || null]
    );
    res.status(201).json({ branch: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error creating branch' });
  }
});

// PATCH /api/branches/:id — general admin only.
router.patch('/:id', authenticate, authorize('admin'), async (req, res) => {
  if (isBranchScoped(req)) {
    return res.status(403).json({ error: 'Only a general admin can edit branches' });
  }
  const { name, address, phone } = req.body;
  const updates = [];
  const values = [];
  let i = 1;
  if (name !== undefined) { updates.push(`name = $${i++}`); values.push(name); }
  if (address !== undefined) { updates.push(`address = $${i++}`); values.push(address); }
  if (phone !== undefined) { updates.push(`phone = $${i++}`); values.push(phone); }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

  values.push(req.params.id);
  try {
    const result = await db.query(`UPDATE branches SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`, values);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Branch not found' });
    res.json({ branch: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error updating branch' });
  }
});

// Deliberately no DELETE — every branch-scoped table CASCADE deletes when
// its branch goes away (wards, appointments, inventory, invoices,
// expenses), so a delete endpoint here would be a one-click way to wipe a
// branch's entire operational and financial history. If a branch actually
// closes, that's a decision to handle deliberately (e.g. exporting its
// data first), not an API call.

module.exports = router;
