const db = require('../config/db');

// Builds the list of bookable slot start-times (as ISO strings, in the
// server's local time) for a given doctor on a given calendar date, based
// on their recurring weekly availability, minus slots that are already
// booked (any appointment not cancelled/no_show).
async function getAvailableSlots(doctor_id, dateStr) {
  const date = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Invalid date');
  }
  const dayOfWeek = date.getDay(); // 0=Sunday ... 6=Saturday, matches schema

  const availabilityResult = await db.query(
    `SELECT start_time, end_time, slot_minutes
     FROM doctor_availability
     WHERE doctor_id = $1 AND day_of_week = $2
     ORDER BY start_time`,
    [doctor_id, dayOfWeek]
  );

  if (availabilityResult.rows.length === 0) {
    return []; // doctor doesn't work this day of week at all
  }

  const bookedResult = await db.query(
    `SELECT scheduled_at FROM appointments
     WHERE doctor_id = $1 AND scheduled_at::date = $2::date
       AND status NOT IN ('cancelled', 'no_show')`,
    [doctor_id, dateStr]
  );
  const bookedTimes = new Set(
    bookedResult.rows.map((r) => new Date(r.scheduled_at).getTime())
  );

  const now = new Date();
  const slots = [];

  for (const window of availabilityResult.rows) {
    const [startH, startM] = window.start_time.split(':').map(Number);
    const [endH, endM] = window.end_time.split(':').map(Number);
    const stepMinutes = window.slot_minutes || 15;

    let cursor = new Date(date);
    cursor.setHours(startH, startM, 0, 0);
    const windowEnd = new Date(date);
    windowEnd.setHours(endH, endM, 0, 0);

    while (cursor < windowEnd) {
      const isPast = cursor < now;
      const isBooked = bookedTimes.has(cursor.getTime());
      if (!isPast && !isBooked) {
        slots.push(new Date(cursor).toISOString());
      }
      cursor = new Date(cursor.getTime() + stepMinutes * 60000);
    }
  }

  return slots;
}

// Is this exact timestamp inside one of the doctor's configured working-hour
// windows for that day? Ignores booking status entirely — this is purely
// "is the doctor supposed to be working at this moment".
async function isWithinWorkingHours(doctor_id, scheduledAtISO) {
  const scheduledAt = new Date(scheduledAtISO);
  if (Number.isNaN(scheduledAt.getTime())) return false;
  const dayOfWeek = scheduledAt.getDay();
  const timeStr = scheduledAt.toTimeString().slice(0, 8); // "HH:MM:SS"

  const result = await db.query(
    `SELECT 1 FROM doctor_availability
     WHERE doctor_id = $1 AND day_of_week = $2 AND start_time <= $3 AND end_time > $3
     LIMIT 1`,
    [doctor_id, dayOfWeek, timeStr]
  );
  return result.rows.length > 0;
}

// Is this exact timestamp already taken by another active appointment for
// this doctor? This is the one thing we still hard-block on — two patients
// literally cannot occupy the identical minute with the same doctor. Working
// outside configured hours is allowed (with a warning); double-booking the
// same instant is not, regardless of hours.
async function isTimeSlotTaken(doctor_id, scheduledAtISO) {
  const scheduledAt = new Date(scheduledAtISO);
  const result = await db.query(
    `SELECT 1 FROM appointments
     WHERE doctor_id = $1 AND scheduled_at = $2 AND status NOT IN ('cancelled', 'no_show')
     LIMIT 1`,
    [doctor_id, scheduledAt.toISOString()]
  );
  return result.rows.length > 0;
}

// Kept for backward compatibility with the slot-generation logic below —
// "available" in the getAvailableSlots sense means both within hours AND
// not already booked (that's what makes a slot worth offering as a button).
async function isSlotAvailable(doctor_id, scheduledAtISO) {
  const scheduledAt = new Date(scheduledAtISO);
  if (Number.isNaN(scheduledAt.getTime())) return false;

  const dateStr = scheduledAt.toISOString().slice(0, 10);
  const slots = await getAvailableSlots(doctor_id, dateStr);
  return slots.includes(scheduledAt.toISOString());
}

module.exports = { getAvailableSlots, isSlotAvailable, isWithinWorkingHours, isTimeSlotTaken };
