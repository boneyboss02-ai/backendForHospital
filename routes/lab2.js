const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { createNotification } = require('../utils/notifications');

const router = express.Router();

// ---------- File upload config ----------
// Stored OUTSIDE any statically-served folder — files are only ever handed
// out through the authenticated /results/:id/file route below, never a
// plain public URL. This matters because lab results are sensitive PHI.
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'lab-results');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_MIME = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // Random filename on disk — never trust/use the client-supplied name for
    // the actual path (avoids path traversal / collisions). The original
    // name is preserved separately in lab_results.file_name for display.
    const ext = ALLOWED_MIME[file.mimetype] || '';
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME[file.mimetype]) {
      return cb(new Error('Only PDF, JPG, or PNG files are allowed'));
    }
    cb(null, true);
  },
});

// Wraps multer so its errors come back as normal JSON 400s instead of
// crashing past the central error handler with a raw stack trace.
function handleUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}

// POST /api/lab/orders — doctor orders a test
router.post('/orders', authenticate, authorize('doctor', 'admin'), async (req, res) => {
  const { patient_id, test_name } = req.body;
  if (!patient_id || !test_name) {
    return res.status(400).json({ error: 'patient_id and test_name are required' });
  }

  try {
    const result = await db.query(
      `INSERT INTO lab_orders (patient_id, ordered_by, test_name) VALUES ($1,$2,$3) RETURNING *`,
      [patient_id, req.user.id, test_name]
    );
    res.status(201).json({ order: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error creating lab order' });
  }
});

// GET /api/lab/orders?patient_id=&status=pending
// Staff-only — patient_id is caller-supplied. Patients view their own lab
// results via /api/portal/lab-results instead.
router.get('/orders', authenticate, authorize('admin', 'receptionist', 'doctor', 'nurse'), async (req, res) => {
  const { patient_id, status } = req.query;
  const conditions = [];
  const values = [];
  let i = 1;
  if (patient_id) { conditions.push(`lo.patient_id = $${i++}`); values.push(patient_id); }
  if (status) { conditions.push(`lo.status = $${i++}`); values.push(status); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const result = await db.query(
      `SELECT lo.*, p.full_name AS patient_name, p.patient_code, u.full_name AS ordered_by_name
       FROM lab_orders lo
       JOIN patients p ON p.id = lo.patient_id
       JOIN users u ON u.id = lo.ordered_by
       ${where}
       ORDER BY lo.ordered_at DESC`,
      values
    );
    res.json({ orders: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching lab orders' });
  }
});

// GET /api/lab/orders/:id — order detail plus any result
// Staff-only — patients use /api/portal/lab-results/:id instead, which
// checks ownership server-side rather than trusting the id in the URL.
router.get('/orders/:id', authenticate, authorize('admin', 'receptionist', 'doctor', 'nurse'), async (req, res) => {
  try {
    const order = await db.query(
      `SELECT lo.*, p.full_name AS patient_name, p.patient_code, u.full_name AS ordered_by_name
       FROM lab_orders lo
       JOIN patients p ON p.id = lo.patient_id
       JOIN users u ON u.id = lo.ordered_by
       WHERE lo.id = $1`,
      [req.params.id]
    );
    if (order.rows.length === 0) return res.status(404).json({ error: 'Lab order not found' });

    const result = await db.query(
      `SELECT lr.*, u.full_name AS entered_by_name
       FROM lab_results lr JOIN users u ON u.id = lr.entered_by
       WHERE lr.lab_order_id = $1
       ORDER BY lr.entered_at DESC`,
      [req.params.id]
    );

    res.json({ order: order.rows[0], results: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching lab order' });
  }
});

// POST /api/lab/orders/:id/results — enter a result, marks the order completed
// (No dedicated lab-tech role in this system yet — nurses, doctors, or admin
// can enter results, matching how a small local hospital's lab work is staffed.)
// Accepts multipart/form-data: `result_text` (text field, optional) and
// `file` (optional, PDF/JPG/PNG up to 10MB) — an X-ray or scanned report.
router.post('/orders/:id/results', authenticate, authorize('nurse', 'doctor', 'admin'), handleUpload, async (req, res) => {
  const { result_text } = req.body;
  const file = req.file;

  if (!result_text && !file) {
    return res.status(400).json({ error: 'result_text or a file is required' });
  }
  // (No cleanup needed here: if we reach this point without a file, multer
  // never wrote one to disk.)

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const orderCheck = await client.query('SELECT * FROM lab_orders WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (orderCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      if (file) fs.unlink(file.path, () => {});
      return res.status(404).json({ error: 'Lab order not found' });
    }

    const result = await client.query(
      `INSERT INTO lab_results (lab_order_id, result_text, result_file_url, file_name, file_mime, file_size, entered_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        req.params.id,
        result_text || null,
        file ? file.filename : null, // stored filename on disk, resolved by the download route below
        file ? file.originalname : null,
        file ? file.mimetype : null,
        file ? file.size : null,
        req.user.id,
      ]
    );

    await client.query(`UPDATE lab_orders SET status = 'completed' WHERE id = $1`, [req.params.id]);

    const order = orderCheck.rows[0];
    const patientUser = await client.query('SELECT user_id FROM patients WHERE id = $1', [order.patient_id]);
    if (patientUser.rows[0]?.user_id) {
      await createNotification(client, {
        user_id: patientUser.rows[0].user_id,
        type: 'lab_result',
        title: 'Lab result ready',
        message: `Your results for "${order.test_name}" are ready to view.`,
        related_type: 'lab_order',
        related_id: order.id,
      });
    }

    await client.query('COMMIT');
    res.status(201).json({ result: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    if (file) fs.unlink(file.path, () => {});
    console.error(err);
    res.status(500).json({ error: 'Server error entering lab result' });
  } finally {
    client.release();
  }
});

// GET /api/lab/results/:id/file — authenticated file download.
// Staff can download any result file; a patient can only download their own.
router.get('/results/:id/file', authenticate, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT lr.*, lo.patient_id
       FROM lab_results lr
       JOIN lab_orders lo ON lo.id = lr.lab_order_id
       WHERE lr.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0 || !result.rows[0].result_file_url) {
      return res.status(404).json({ error: 'File not found' });
    }
    const row = result.rows[0];

    if (req.user.role === 'patient') {
      const patient = await db.query('SELECT user_id FROM patients WHERE id = $1', [row.patient_id]);
      if (patient.rows.length === 0 || patient.rows[0].user_id !== req.user.id) {
        return res.status(403).json({ error: 'You do not have permission to view this file' });
      }
    }

    const filePath = path.join(UPLOAD_DIR, row.result_file_url);
    if (!filePath.startsWith(UPLOAD_DIR) || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    res.setHeader('Content-Type', row.file_mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${(row.file_name || 'result').replace(/"/g, '')}"`);
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching file' });
  }
});

module.exports = router;
