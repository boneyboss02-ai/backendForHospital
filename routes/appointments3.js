const express = require('express');
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { getAvailableSlots, isWithinWorkingHours, isTimeSlotTaken } = require('../utils/availability');
const { createNotification } = require('../utils/notifications');

const router = express.Router();

// GET /api/appointments/availability?doctor_id=&date=YYYY-MM-DD
// Returns the open bookable slots for a doctor on a given date, derived from
// doctor_availability minus anything already booked. Used by both the staff
// booking form and the patient portal so the two can never disagree.
router.get('/availability', authenticate, async (req, res) => {
  const { doctor_id, date } = req.query;
  if (!doctor_id || !date) {
    return res.status(400).json({ error: 'doctor_id and date are required' });
  }
  try {
    const slots = await getAvailableSlots(doctor_id, date);
    res.json({ doctor_id: Number(doctor_id), date, slots });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message || 'Could not compute availability' });
  }
});

// POST /api/appointments — book an appointment (assigns next token number for that doctor/day)
// Checked against doctor_availability, but only as a soft warning — booking
// outside a doctor's usual hours is allowed (hospitals need room for
// walk-ins/emergencies) and comes back with a `warning` field instead of an
// error. The one thing that's still a hard block is two appointments landing
// on the exact same doctor + timestamp (see isTimeSlotTaken below).
router.post('/', authenticate, authorize('admin', 'receptionist'), async (req, res) => {
  const { patient_id, doctor_id, scheduled_at, reason } = req.body;

  if (!patient_id || !doctor_id || !scheduled_at) {
    return res.status(400).json({ error: 'patient_id, doctor_id, and scheduled_at are required' });
  }

  let warning = null;
  try {
    const taken = await isTimeSlotTaken(doctor_id, scheduled_at);
    if (taken) {
      return res.status(409).json({ error: 'This doctor already has an appointment at that exact time. Please pick a different time.' });
    }
    const withinHours = await isWithinWorkingHours(doctor_id, scheduled_at);
    if (!withinHours) {
      // Not a hard stop — reception may be booking a walk-in or emergency
      // slot outside the doctor's usual hours. We just flag it so whoever's
      // booking knows, and it shows up on the appointment for the doctor too.
      warning = "This time is outside the doctor's usual working hours.";
    }
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Invalid scheduled_at' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const day = new Date(scheduled_at).toISOString().slice(0, 10);
    const tokenResult = await client.query(
      `SELECT COALESCE(MAX(token_number), 0) + 1 AS next_token
       FROM appointments
       WHERE doctor_id = $1 AND scheduled_at::date = $2::date`,
      [doctor_id, day]
    );
    const token_number = tokenResult.rows[0].next_token;

    const result = await client.query(
      `INSERT INTO appointments (patient_id, doctor_id, scheduled_at, token_number, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [patient_id, doctor_id, scheduled_at, token_number, reason, req.user.id]
    );
    const appointment = result.rows[0];

    // Notify the patient (if they have a portal login) and the doctor.
    const patientUser = await client.query('SELECT user_id, full_name FROM patients WHERE id = $1', [patient_id]);
    const doctorUser = await client.query('SELECT full_name FROM users WHERE id = $1', [doctor_id]);
    const doctorName = doctorUser.rows[0]?.full_name || 'your doctor';
    const patientName = patientUser.rows[0]?.full_name || 'A patient';
    const when = new Date(scheduled_at).toLocaleString();

    if (patientUser.rows[0]?.user_id) {
      await createNotification(client, {
        user_id: patientUser.rows[0].user_id,
        type: 'appointment_booked',
        title: 'Appointment confirmed',
        message: `Your appointment with ${doctorName} is confirmed for ${when}. Token #${token_number}.`,
        related_type: 'appointment',
        related_id: appointment.id,
      });
    }
    await createNotification(client, {
      user_id: doctor_id,
      type: 'appointment_booked',
      title: 'New appointment',
      message: `${patientName} booked an appointment with you for ${when}.`,
      related_type: 'appointment',
      related_id: appointment.id,
    });

    await client.query('COMMIT');
    res.status(201).json({ appointment, warning });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'That slot was just booked by someone else. Please pick another.' });
    }
    res.status(500).json({ error: 'Server error booking appointment' });
  } finally {
    client.release();
  }
});

// GET /api/appointments?doctor_id=&patient_id=&date=&status=
// Staff-only: patient_id is caller-supplied, so this must never be reachable
// by a patient login. Patients get their own appointments via /api/portal.
router.get('/', authenticate, authorize('admin', 'receptionist', 'doctor', 'nurse'), async (req, res) => {
  const { patient_id, date, status } = req.query;
  let { doctor_id } = req.query;
  // A doctor can only ever see their own appointments — regardless of what
  // doctor_id they pass (or don't). This is enforced here, not just hidden
  // in the UI, since the UI alone wouldn't stop a crafted request.
  if (req.user.role === 'doctor') {
    doctor_id = req.user.id;
  }

  const conditions = [];
  const values = [];
  let i = 1;

  if (doctor_id) { conditions.push(`a.doctor_id = $${i++}`); values.push(doctor_id); }
  if (patient_id) { conditions.push(`a.patient_id = $${i++}`); values.push(patient_id); }
  if (date) { conditions.push(`a.scheduled_at::date = $${i++}::date`); values.push(date); }
  if (status) { conditions.push(`a.status = $${i++}`); values.push(status); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const result = await db.query(
      `SELECT a.*, p.full_name AS patient_name, p.patient_code, u.full_name AS doctor_name
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       JOIN users u ON u.id = a.doctor_id
       ${where}
       ORDER BY a.scheduled_at ASC`,
      values
    );
    res.json({ appointments: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching appointments' });
  }
});

// PATCH /api/appointments/:id/status — update status (checked_in, in_progress, completed, cancelled, no_show)
router.patch('/:id/status', authenticate, authorize('admin', 'receptionist', 'doctor', 'nurse'), async (req, res) => {
  const { status } = req.body;
  const valid = ['scheduled', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show'];
  if (!valid.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${valid.join(', ')}` });
  }

  try {
    // Receptionists can see every appointment, but can only cancel the
    // ones they personally booked — a colleague's booking is off-limits.
    // Other roles (admin/doctor/nurse) aren't restricted by this check.
    if (status === 'cancelled' && req.user.role === 'receptionist') {
      const owner = await db.query('SELECT created_by FROM appointments WHERE id = $1', [req.params.id]);
      if (owner.rows.length === 0) {
        return res.status(404).json({ error: 'Appointment not found' });
      }
      if (owner.rows[0].created_by !== req.user.id) {
        return res.status(403).json({ error: 'You can only cancel appointments you booked yourself.' });
      }
    }

    const result = await db.query(
      'UPDATE appointments SET status = $1 WHERE id = $2 RETURNING *',
      [status, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Appointment not found' });
    }
    const appointment = result.rows[0];

    const patientUser = await db.query('SELECT user_id FROM patients WHERE id = $1', [appointment.patient_id]);
    if (patientUser.rows[0]?.user_id) {
      const STATUS_COPY = {
        checked_in: 'You have been checked in.',
        in_progress: 'Your consultation has started.',
        completed: 'Your visit has been completed.',
        cancelled: 'Your appointment has been cancelled.',
        no_show: 'You were marked as a no-show for your appointment.',
      };
      if (STATUS_COPY[status]) {
        await createNotification(db, {
          user_id: patientUser.rows[0].user_id,
          type: 'appointment_status',
          title: 'Appointment update',
          message: STATUS_COPY[status],
          related_type: 'appointment',
          related_id: appointment.id,
        });
      }
    }

    res.json({ appointment });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error updating appointment' });
  }
});

// POST /api/appointments/:id/consultation — doctor adds diagnosis/notes, marks
// the visit complete, bills the consultation fee (if the doctor has one set),
// bills any procedure charges the doctor enters (e.g. "Tooth extraction —
// 1500"), and decrements inventory for anything used during the visit (e.g.
// "2x Aspirin"). Charges and inventory use are two separate things: charges
// go on the patient's invoice, inventory use does not (it's just stock
// tracking) — this clinic doesn't bill patients for consumables directly,
// per the earlier inventory-removal decision.
// body: { diagnosis, doctor_notes, charges?: [{description, amount}], items_used?: [{item_id, quantity}] }
router.post('/:id/consultation', authenticate, authorize('doctor'), async (req, res) => {
  const { diagnosis, doctor_notes, charges, items_used } = req.body;

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const consultation = await client.query(
      `INSERT INTO consultations (appointment_id, diagnosis, doctor_notes)
       VALUES ($1, $2, $3) RETURNING *`,
      [req.params.id, diagnosis, doctor_notes]
    );

    const appointmentResult = await client.query(
      `UPDATE appointments SET status = 'completed' WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (appointmentResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Appointment not found' });
    }
    const appointment = appointmentResult.rows[0];

    // Find-or-create the invoice for this visit — shared by the consultation
    // fee (below) and any procedure charges, so everything from one visit
    // lands on one invoice instead of several.
    async function findOrCreateInvoice() {
      const existing = await client.query(
        `SELECT * FROM invoices
         WHERE patient_id = $1 AND appointment_id = $2 AND status != 'paid'
         ORDER BY created_at DESC LIMIT 1`,
        [appointment.patient_id, appointment.id]
      );
      if (existing.rows.length > 0) return existing.rows[0];
      const created = await client.query(
        `INSERT INTO invoices (patient_id, appointment_id) VALUES ($1,$2) RETURNING *`,
        [appointment.patient_id, appointment.id]
      );
      return created.rows[0];
    }

    let invoice_id = null;

    // Bill the consultation fee, if the doctor's profile has one set.
    const feeResult = await client.query(
      `SELECT sp.consultation_fee, u.full_name AS doctor_name
       FROM staff_profiles sp JOIN users u ON u.id = sp.user_id
       WHERE sp.user_id = $1`,
      [appointment.doctor_id]
    );

    if (feeResult.rows.length > 0 && feeResult.rows[0].consultation_fee > 0) {
      const { consultation_fee, doctor_name } = feeResult.rows[0];
      const invoice = await findOrCreateInvoice();
      await client.query(
        `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, line_total)
         VALUES ($1,$2,1,$3,$3)`,
        [invoice.id, `Consultation - Dr. ${doctor_name}`, consultation_fee]
      );
      await client.query(
        `UPDATE invoices SET total_amount = total_amount + $1 WHERE id = $2`,
        [consultation_fee, invoice.id]
      );
      invoice_id = invoice.id;
    }

    // Bill any procedures the doctor enters — e.g. "Tooth extraction — 1500".
    // This is manual/case-by-case, unlike the fixed consultation_fee above.
    if (Array.isArray(charges) && charges.length > 0) {
      const invoice = await findOrCreateInvoice();
      invoice_id = invoice.id;
      for (const charge of charges) {
        const { description, amount } = charge;
        if (!description || !amount || amount <= 0) continue;
        await client.query(
          `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, line_total)
           VALUES ($1,$2,1,$3,$3)`,
          [invoice.id, description, amount]
        );
        await client.query(
          `UPDATE invoices SET total_amount = total_amount + $1 WHERE id = $2`,
          [amount, invoice.id]
        );
      }
    }

    if (invoice_id) {
      const finalInvoice = await client.query('SELECT * FROM invoices WHERE id = $1', [invoice_id]);
      const { total_amount, amount_paid } = finalInvoice.rows[0];
      let status = 'unpaid';
      if (Number(amount_paid) >= Number(total_amount) && Number(total_amount) > 0) status = 'paid';
      else if (Number(amount_paid) > 0) status = 'partially_paid';
      await client.query('UPDATE invoices SET status = $1 WHERE id = $2', [status, invoice_id]);
    }

    // Decrement inventory for anything used during the visit. This is
    // purely internal stock tracking — not billed, per the earlier decision
    // that a dental clinic doesn't charge patients for consumables
    // directly. Doctors can only consume through this path; they can't add
    // stock or restock (that's admin-only, in routes/inventory.js).
    const usageLog = [];
    if (Array.isArray(items_used) && items_used.length > 0) {
      for (const usage of items_used) {
        const { item_id, quantity } = usage;
        if (!item_id || !quantity || quantity <= 0) continue;

        const updated = await client.query(
          `UPDATE inventory_items SET stock_quantity = stock_quantity - $1 WHERE id = $2 RETURNING *`,
          [quantity, item_id]
        );
        if (updated.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: `Inventory item ${item_id} not found` });
        }
        if (updated.rows[0].stock_quantity < 0) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: `Not enough stock of "${updated.rows[0].name}" for this quantity` });
        }

        const logged = await client.query(
          `INSERT INTO inventory_usage (appointment_id, item_id, quantity, used_by)
           VALUES ($1,$2,$3,$4) RETURNING *`,
          [appointment.id, item_id, quantity, req.user.id]
        );
        usageLog.push(logged.rows[0]);
      }
    }

    await client.query('COMMIT');
    res.status(201).json({ consultation: consultation.rows[0], invoice_id, items_used: usageLog });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error saving consultation' });
  } finally {
    client.release();
  }
});

module.exports = router;
