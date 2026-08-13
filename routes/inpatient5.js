const express = require('express');
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { isBranchScoped } = require('../utils/branchScope');

const router = express.Router();

// ---------- WARDS & BEDS ----------

// GET /api/inpatient/beds — bed board, optionally filter by status/ward
router.get('/beds', authenticate, async (req, res) => {
  const { status, ward_id } = req.query;
  const conditions = [];
  const values = [];
  let i = 1;
  if (status) { conditions.push(`b.status = $${i++}`); values.push(status); }
  if (ward_id) { conditions.push(`b.ward_id = $${i++}`); values.push(ward_id); }
  // Beds don't have their own branch_id — they belong to a ward, which
  // does. A branch-scoped caller only sees beds in wards at their branch.
  if (isBranchScoped(req)) {
    conditions.push(`w.branch_id = $${i++}`);
    values.push(req.user.branch_id);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const result = await db.query(
      `SELECT b.*, w.name AS ward_name
       FROM beds b JOIN wards w ON w.id = b.ward_id
       ${where}
       ORDER BY w.name, b.bed_number`,
      values
    );
    res.json({ beds: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching beds' });
  }
});

// PATCH /api/inpatient/beds/:id/status — manually move a bed to a new
// status once it's ready again (e.g. cleaning finished, maintenance done).
// This is the piece that was missing: discharge() sets a bed to 'cleaning'
// but nothing ever moved it back to 'available'. Deliberately can't be
// used to free an 'occupied' bed directly — that only happens through
// discharge, so the bed and the admission record can't get out of sync
// (e.g. marking a bed "available" while a patient is still actually in it).
router.patch('/beds/:id/status', authenticate, authorize('admin', 'nurse', 'receptionist'), async (req, res) => {
  const { status } = req.body;
  const allowed = ['available', 'cleaning', 'maintenance'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
  }

  try {
    const bedCheck = await db.query('SELECT status FROM beds WHERE id = $1', [req.params.id]);
    if (bedCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Bed not found' });
    }
    if (bedCheck.rows[0].status === 'occupied') {
      return res.status(409).json({ error: 'This bed is occupied — discharge the patient first.' });
    }

    const result = await db.query('UPDATE beds SET status = $1 WHERE id = $2 RETURNING *', [status, req.params.id]);
    res.json({ bed: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error updating bed status' });
  }
});

// GET /api/inpatient/wards — simple ward list (e.g. for the shift-assignment
// ward dropdown). Wards themselves aren't sensitive, so any authenticated
// staff can view this.
router.get('/wards', authenticate, async (req, res) => {
  const conditions = [];
  const values = [];
  if (isBranchScoped(req)) {
    conditions.push('branch_id = $1');
    values.push(req.user.branch_id);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  try {
    const result = await db.query(`SELECT * FROM wards ${where} ORDER BY name`, values);
    res.json({ wards: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching wards' });
  }
});

// POST /api/inpatient/wards — create a ward. A branch admin's ward is
// forced to their own branch; a general admin must specify which branch.
router.post('/wards', authenticate, authorize('admin'), async (req, res) => {
  const { name, floor } = req.body;
  let { branch_id } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (isBranchScoped(req)) {
    branch_id = req.user.branch_id;
  } else if (!branch_id) {
    return res.status(400).json({ error: 'branch_id is required' });
  }
  try {
    const result = await db.query(
      'INSERT INTO wards (name, floor, branch_id) VALUES ($1, $2, $3) RETURNING *',
      [name, floor, branch_id]
    );
    res.status(201).json({ ward: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error creating ward' });
  }
});

// POST /api/inpatient/beds — add a bed to a ward (admin). A branch admin
// can only add beds to wards in their own branch.
router.post('/beds', authenticate, authorize('admin'), async (req, res) => {
  const { ward_id, bed_number } = req.body;
  if (!ward_id || !bed_number) {
    return res.status(400).json({ error: 'ward_id and bed_number are required' });
  }
  try {
    if (isBranchScoped(req)) {
      const ward = await db.query('SELECT branch_id FROM wards WHERE id = $1', [ward_id]);
      if (ward.rows.length === 0) return res.status(404).json({ error: 'Ward not found' });
      if (ward.rows[0].branch_id !== req.user.branch_id) {
        return res.status(403).json({ error: 'This ward is not at your branch' });
      }
    }
    const result = await db.query(
      'INSERT INTO beds (ward_id, bed_number) VALUES ($1, $2) RETURNING *',
      [ward_id, bed_number]
    );
    res.status(201).json({ bed: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error creating bed' });
  }
});

// ---------- ADMISSIONS ----------
// Despite the medical-sounding name (kept for now to avoid a bigger schema
// rename), for this clinic these are really just "which chair is this
// patient sitting in while they wait" — not a real hospital admission. So
// receptionist can seat/free a chair same as admin/nurse, since reception
// is who's actually managing the waiting area day to day.

// POST /api/inpatient/admissions — admit a patient to a bed
router.post('/admissions', authenticate, authorize('admin', 'doctor', 'nurse', 'receptionist'), async (req, res) => {
  const { patient_id, bed_id, attending_doctor_id, admission_reason } = req.body;
  if (!patient_id || !bed_id) {
    return res.status(400).json({ error: 'patient_id and bed_id are required' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const bedCheck = await client.query(
      `SELECT b.status, w.branch_id FROM beds b JOIN wards w ON w.id = b.ward_id WHERE b.id = $1 FOR UPDATE OF b`,
      [bed_id]
    );
    if (bedCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Bed not found' });
    }
    if (isBranchScoped(req) && bedCheck.rows[0].branch_id !== req.user.branch_id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'This chair is not at your branch' });
    }
    if (bedCheck.rows[0].status !== 'available') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Bed is not available' });
    }

    const admission = await client.query(
      `INSERT INTO admissions (patient_id, bed_id, attending_doctor_id, admission_reason)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [patient_id, bed_id, attending_doctor_id, admission_reason]
    );

    await client.query(`UPDATE beds SET status = 'occupied' WHERE id = $1`, [bed_id]);

    await client.query('COMMIT');
    res.status(201).json({ admission: admission.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error admitting patient' });
  } finally {
    client.release();
  }
});

// PATCH /api/inpatient/admissions/:id/discharge — discharge a patient, free the bed
router.patch('/admissions/:id/discharge', authenticate, authorize('admin', 'doctor', 'receptionist'), async (req, res) => {
  const { discharge_summary } = req.body;

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const admissionResult = await client.query(
      `UPDATE admissions
       SET status = 'discharged', discharged_at = NOW(), discharge_summary = $1
       WHERE id = $2 AND status = 'admitted'
       RETURNING *`,
      [discharge_summary, req.params.id]
    );

    if (admissionResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Active admission not found' });
    }

    const bed_id = admissionResult.rows[0].bed_id;
    await client.query(`UPDATE beds SET status = 'cleaning' WHERE id = $1`, [bed_id]);

    await client.query('COMMIT');
    res.json({ admission: admissionResult.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error discharging patient' });
  } finally {
    client.release();
  }
});

// GET /api/inpatient/admissions?status=admitted — list admissions
router.get('/admissions', authenticate, async (req, res) => {
  const { status, patient_id } = req.query;
  const conditions = [];
  const values = [];
  let i = 1;
  if (status) { conditions.push(`ad.status = $${i++}`); values.push(status); }
  if (patient_id) { conditions.push(`ad.patient_id = $${i++}`); values.push(patient_id); }
  // Admissions don't carry their own branch_id — inherited through
  // bed -> ward -> branch, same reasoning as the beds endpoint above.
  if (isBranchScoped(req)) {
    conditions.push(`w.branch_id = $${i++}`);
    values.push(req.user.branch_id);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const result = await db.query(
      `SELECT ad.*, p.full_name AS patient_name, p.patient_code,
              b.bed_number, w.name AS ward_name, u.full_name AS doctor_name
       FROM admissions ad
       JOIN patients p ON p.id = ad.patient_id
       LEFT JOIN beds b ON b.id = ad.bed_id
       LEFT JOIN wards w ON w.id = b.ward_id
       LEFT JOIN users u ON u.id = ad.attending_doctor_id
       ${where}
       ORDER BY ad.admitted_at DESC`,
      values
    );
    res.json({ admissions: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching admissions' });
  }
});

// POST /api/inpatient/admissions/:id/vitals — nurse logs vitals
router.post('/admissions/:id/vitals', authenticate, authorize('nurse', 'doctor'), async (req, res) => {
  const { temperature_c, blood_pressure, heart_rate, respiratory_rate, oxygen_saturation } = req.body;
  try {
    const result = await db.query(
      `INSERT INTO vitals_log
        (admission_id, recorded_by, temperature_c, blood_pressure, heart_rate, respiratory_rate, oxygen_saturation)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.id, req.user.id, temperature_c, blood_pressure, heart_rate, respiratory_rate, oxygen_saturation]
    );
    res.status(201).json({ vitals: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error logging vitals' });
  }
});

// GET /api/inpatient/admissions/:id/vitals — vitals history for an admission
router.get('/admissions/:id/vitals', authenticate, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM vitals_log WHERE admission_id = $1 ORDER BY recorded_at DESC',
      [req.params.id]
    );
    res.json({ vitals: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching vitals' });
  }
});

module.exports = router;
