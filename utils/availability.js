const db = require('../config/db');

// Shifts don't carry a slot_minutes value the way doctor_availability rows
// do (rostering doesn't need that granularity) — this is the default slot
// length used when generating bookable times from a shift instead.
const DEFAULT_SHIFT_SLOT_MINUTES = 15;

// A doctor's bookable hours on a given date come from TWO independent
// sources, unioned together:
//  1. doctor_availability — recurring weekly hours ("every Saturday 9-1"),
//     set on the My Schedule page.
//  2. shifts — one-off, date-specific rostering ("on July 18, work 1-6"),
//     set on the Who's on Duty page — but ONLY when the shift belongs to a
//     doctor. Nurses/receptionists/pharmacists get shifts too; those never
//     affect appointment booking, since only doctors take appointments.
// Before this, these were two completely disconnected systems — staffing
// someone for a shift never made that time bookable.
async function getRecurringWindows(doctor_id, dayOfWeek) {
  const result = await db.query(
    `SELECT start_time, end_time, slot_minutes
     FROM doctor_availability
     WHERE doctor_id = $1 AND day_of_week = $2`,
    [doctor_id, dayOfWeek]
  );
  return result.rows;
}

async function getShiftWindows(doctor_id, dateStr) {
  const result = await db.query(
    `SELECT s.start_time, s.end_time
     FROM shifts s
     JOIN users u ON u.id = s.user_id
     WHERE s.user_id = $1 AND s.shift_date = $2 AND u.role = 'doctor'`,
    [doctor_id, dateStr]
  );
  return result.rows.map((row) => ({ ...row, slot_minutes: DEFAULT_SHIFT_SLOT_MINUTES }));
}

// Returns every open, unbooked slot (as ISO timestamps) for a doctor on a
// given date, combining both sources above and removing anything already booked.
async function getAvailableSlots(doctor_id, dateStr) {
  const date = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Invalid date');
  }
  const dayOfWeek = date.getDay();

  const [recurringWindows, shiftWindows] = await Promise.all([
    getRecurringWindows(doctor_id, dayOfWeek),
    getShiftWindows(doctor_id, dateStr),
  ]);
  const windows = [...recurringWindows, ...shiftWindows];

  const bookedResult = await db.query(
    `SELECT scheduled_at FROM appointments
     WHERE doctor_id = $1 AND scheduled_at::date = $2::date
       AND status NOT IN ('cancelled', 'no_show')`,
    [doctor_id, dateStr]
  );
  const booked = new Set(bookedResult.rows.map((r) => new Date(r.scheduled_at).toISOString()));

  // A Set here also naturally de-duplicates the case where a recurring
  // window and a shift window overlap on the same day — no double-booked
  // identical slot times in the result.
  const slotSet = new Set();
  for (const window of windows) {
    const [startH, startM] = window.start_time.split(':').map(Number);
    const [endH, endM] = window.end_time.split(':').map(Number);
    let current = new Date(date);
    current.setHours(startH, startM, 0, 0);
    const end = new Date(date);
    end.setHours(endH, endM, 0, 0);

    while (current < end) {
      const iso = current.toISOString();
      if (!booked.has(iso)) slotSet.add(iso);
      current = new Date(current.getTime() + window.slot_minutes * 60000);
    }
  }

  return Array.from(slotSet).sort();
}

// Is this exact timestamp inside one of the doctor's bookable windows —
// either a recurring weekly window or a same-date shift? Ignores booking
// status entirely (that's isTimeSlotTaken's job) — this is purely "is the
// doctor supposed to be working at this moment".
async function isWithinWorkingHours(doctor_id, scheduledAtISO) {
  const scheduledAt = new Date(scheduledAtISO);
  if (Number.isNaN(scheduledAt.getTime())) return false;

  const dayOfWeek = scheduledAt.getDay();
  const dateStr = scheduledAt.toISOString().slice(0, 10);
  const timeStr = scheduledAt.toTimeString().slice(0, 8); // "HH:MM:SS"

  const recurringMatch = await db.query(
    `SELECT 1 FROM doctor_availability
     WHERE doctor_id = $1 AND day_of_week = $2 AND start_time <= $3 AND end_time > $3
     LIMIT 1`,
    [doctor_id, dayOfWeek, timeStr]
  );
  if (recurringMatch.rows.length > 0) return true;

  const shiftMatch = await db.query(
    `SELECT 1 FROM shifts s
     JOIN users u ON u.id = s.user_id
     WHERE s.user_id = $1 AND s.shift_date = $2 AND u.role = 'doctor'
       AND s.start_time <= $3 AND s.end_time > $3
     LIMIT 1`,
    [doctor_id, dateStr, timeStr]
  );
  return shiftMatch.rows.length > 0;
}

// Is this exact timestamp already taken by another active appointment for
// this doctor? Still the one hard block — two patients can't occupy the
// identical minute with the same doctor, regardless of hours.
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

// Kept for backward compatibility with anything still calling the combined
// check directly — "available" here means both within hours AND not booked.
async function isSlotAvailable(doctor_id, scheduledAtISO) {
  const scheduledAt = new Date(scheduledAtISO);
  if (Number.isNaN(scheduledAt.getTime())) return false;

  const dateStr = scheduledAt.toISOString().slice(0, 10);
  const slots = await getAvailableSlots(doctor_id, dateStr);
  return slots.includes(scheduledAt.toISOString());
}

module.exports = { getAvailableSlots, isSlotAvailable, isWithinWorkingHours, isTimeSlotTaken };
