const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { generatePatientCode } = require('../utils/patientCode');
const { sendMail } = require('../utils/mailer');

const router = express.Router();

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user.id, role: user.role, full_name: user.full_name, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        role: user.role,
        must_change_password: user.must_change_password,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during login' });
  }
});

// POST /api/auth/register-staff  (admin only — creates doctor/nurse/receptionist/pharmacist accounts)
router.post('/register-staff', authenticate, authorize('admin'), async (req, res) => {
  const { full_name, email, phone, password, role, specialty, department, consultation_fee } = req.body;

  if (!full_name || !email || !password || !role) {
    return res.status(400).json({ error: 'full_name, email, password, and role are required' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const password_hash = await bcrypt.hash(password, 10);
    const userResult = await client.query(
      `INSERT INTO users (full_name, email, phone, password_hash, role)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, full_name, email, role`,
      [full_name, email, phone, password_hash, role]
    );
    const user = userResult.rows[0];

    if (['doctor', 'nurse', 'pharmacist'].includes(role)) {
      await client.query(
        `INSERT INTO staff_profiles (user_id, specialty, department, consultation_fee)
         VALUES ($1, $2, $3, $4)`,
        [user.id, specialty || null, department || null, consultation_fee || null]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ user });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A user with this email already exists' });
    }
    res.status(500).json({ error: 'Server error during registration' });
  } finally {
    client.release();
  }
});

// POST /api/auth/register-patient — patient self-signup
// Two cases:
//  1. New patient (no existing record): body = { full_name, email, password,
//     phone?, date_of_birth?, gender?, address? } — creates both the patient
//     record and the login together.
//  2. Existing patient record from a past visit: body also includes
//     `patient_code` — we verify it against `date_of_birth` before linking,
//     so a stranger can't claim someone else's record just by guessing a
//     patient code (codes are sequential and not secret).
router.post('/register-patient', async (req, res) => {
  const {
    full_name, email, password, phone, date_of_birth, gender, address,
    patient_code,
  } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'password must be at least 8 characters' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    let patient;
    if (patient_code) {
      // Claiming an existing record — require the code, date of birth, AND
      // phone number to all match. Code + DOB alone is a reasonable bar for
      // a small clinic, but codes are sequential (guessable) and DOB isn't
      // exactly secret either; requiring phone too raises the bar without
      // needing any paid verification service. Failed attempts are rate
      // limited per patient record so this can't be brute-forced.
      if (!date_of_birth || !phone) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'date_of_birth and phone are both required to link an existing patient record' });
      }

      const lookup = await client.query(
        `SELECT * FROM patients WHERE patient_code = $1 FOR UPDATE`,
        [patient_code]
      );
      if (lookup.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'No matching patient record found for that code and details' });
      }
      const candidate = lookup.rows[0];

      if (candidate.portal_claim_locked_until && new Date(candidate.portal_claim_locked_until) > new Date()) {
        await client.query('ROLLBACK');
        const minutesLeft = Math.ceil((new Date(candidate.portal_claim_locked_until) - new Date()) / 60000);
        return res.status(429).json({ error: `Too many failed attempts. Please try again in about ${minutesLeft} minute(s), or ask reception for an invite instead.` });
      }

      const dobMatches = candidate.date_of_birth && new Date(candidate.date_of_birth).toISOString().slice(0, 10) === date_of_birth;
      const phoneMatches = candidate.phone && candidate.phone.replace(/\s+/g, '') === phone.replace(/\s+/g, '');

      if (!dobMatches || !phoneMatches) {
        const attempts = candidate.portal_claim_attempts + 1;
        if (attempts >= 5) {
          await client.query(
            `UPDATE patients SET portal_claim_attempts = 0, portal_claim_locked_until = NOW() + INTERVAL '30 minutes' WHERE id = $1`,
            [candidate.id]
          );
        } else {
          await client.query(`UPDATE patients SET portal_claim_attempts = $1 WHERE id = $2`, [attempts, candidate.id]);
        }
        await client.query('COMMIT'); // commit the attempt-counter update even though the claim itself failed
        return res.status(404).json({ error: 'No matching patient record found for that code and details' });
      }

      if (candidate.user_id) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'That patient record already has a portal account' });
      }

      // Successful match — reset the attempt counter.
      await client.query(`UPDATE patients SET portal_claim_attempts = 0, portal_claim_locked_until = NULL WHERE id = $1`, [candidate.id]);
      patient = candidate;
    }

    if (!patient && !full_name) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'full_name is required for a new patient' });
    }

    const password_hash = await bcrypt.hash(password, 10);
    const userResult = await client.query(
      `INSERT INTO users (full_name, email, phone, password_hash, role)
       VALUES ($1,$2,$3,$4,'patient') RETURNING id, full_name, email, role, must_change_password`,
      [patient ? patient.full_name : full_name, email, phone || (patient ? patient.phone : null), password_hash]
    );
    const user = userResult.rows[0];

    if (patient) {
      await client.query('UPDATE patients SET user_id = $1 WHERE id = $2', [user.id, patient.id]);
    } else {
      const code = await generatePatientCode(client);
      const newPatient = await client.query(
        `INSERT INTO patients (user_id, patient_code, full_name, date_of_birth, gender, phone, address)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [user.id, code, full_name, date_of_birth || null, gender || null, phone || null, address || null]
      );
      patient = newPatient.rows[0];
    }

    await client.query('COMMIT');

    const token = jwt.sign(
      { id: user.id, role: user.role, full_name: user.full_name, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    res.status(201).json({
      token,
      user: { id: user.id, full_name: user.full_name, email: user.email, role: user.role, must_change_password: user.must_change_password },
      patient,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A user with this email already exists' });
    }
    res.status(500).json({ error: 'Server error during registration' });
  } finally {
    client.release();
  }
});

// PATCH /api/auth/me/password — change your own password
// Requires the current password (including a staff-issued temporary one),
// which also clears must_change_password once satisfied.
router.patch('/me/password', authenticate, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'current_password and new_password are required' });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ error: 'new_password must be at least 8 characters' });
  }

  try {
    const result = await db.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    const validPassword = await bcrypt.compare(current_password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const password_hash = await bcrypt.hash(new_password, 10);
    await db.query(
      'UPDATE users SET password_hash = $1, must_change_password = FALSE WHERE id = $2',
      [password_hash, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error changing password' });
  }
});

// GET /api/auth/me — return current logged-in user
router.get('/me', authenticate, async (req, res) => {
  try {
    const result = await db.query('SELECT must_change_password FROM users WHERE id = $1', [req.user.id]);
    res.json({ user: { ...req.user, must_change_password: result.rows[0]?.must_change_password || false } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching profile' });
  }
});

// POST /api/auth/forgot-password — request a reset link
// Always responds the same way whether or not the email exists, so this
// can't be used to enumerate registered accounts.
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });

  const genericResponse = { message: 'If that email has an account, a reset link has been sent.' };

  try {
    const result = await db.query('SELECT id, full_name FROM users WHERE email = $1 AND is_active = TRUE', [email]);
    if (result.rows.length === 0) {
      return res.json(genericResponse); // don't reveal whether the email exists
    }
    const user = result.rows[0];

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await db.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
      [user.id, tokenHash, expiresAt]
    );

    const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/reset-password?token=${rawToken}`;
    await sendMail({
      to: email,
      subject: 'Reset your Wardline password',
      text: `Hi ${user.full_name},\n\nSomeone (hopefully you) requested a password reset. This link expires in 1 hour:\n\n${resetUrl}\n\nIf you didn't request this, you can ignore this email — your password won't change.`,
    });

    res.json(genericResponse);
  } catch (err) {
    console.error(err);
    // Still return the generic message — don't leak server errors that could
    // hint at whether the email exists.
    res.json(genericResponse);
  }
});

// POST /api/auth/reset-password — complete a reset with the emailed token
router.post('/reset-password', async (req, res) => {
  const { token, new_password } = req.body;
  if (!token || !new_password) {
    return res.status(400).json({ error: 'token and new_password are required' });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ error: 'new_password must be at least 8 characters' });
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `SELECT * FROM password_reset_tokens WHERE token_hash = $1 FOR UPDATE`,
      [tokenHash]
    );
    const record = result.rows[0];

    if (!record || record.used_at || new Date(record.expires_at) < new Date()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
    }

    const password_hash = await bcrypt.hash(new_password, 10);
    await client.query(
      'UPDATE users SET password_hash = $1, must_change_password = FALSE WHERE id = $2',
      [password_hash, record.user_id]
    );
    await client.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1', [record.id]);

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error resetting password' });
  } finally {
    client.release();
  }
});

module.exports = router;
