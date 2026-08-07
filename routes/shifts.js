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
router.get('/', authenticate, authorize('admin', 'doctor', 'nurse', 'receptionist'), async (req, res) => {
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

// POST /api/shifts/patterns — admin sets up a recurring weekly plan.
// body: { week_start: 'YYYY-MM-DD' (any date in the target week — used only
//         to compute each entry's actual date), entries: [{ user_id, ward_id?,
//         day_of_week (0-6), start_time, end_time, note? }] }
// For each entry, this stores the template (shift_patterns) AND immediately
// generates concrete `shifts` rows for every matching weekday from that
// week through December 31st of that year — "fill one week, it continues
// for the rest of the year" per the brief. It does not run again later on
// its own; there's no cron regenerating anything past that year boundary.
router.post('/patterns', authenticate, authorize('admin'), async (req, res) => {
  const { week_start, entries } = req.body;
  if (!week_start || !Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ error: 'week_start and at least one entry are required' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const createdPatterns = [];
    let totalShiftsCreated = 0;

    for (const entry of entries) {
      const { user_id, ward_id, day_of_week, start_time, end_time, note } = entry;
      if (
        !user_id || day_of_week === undefined || day_of_week === null ||
        day_of_week < 0 || day_of_week > 6 || !start_time || !end_time
      ) {
        continue; // skip incomplete rows rather than fail the whole plan
      }
      if (start_time >= end_time) continue;

      // The first date on/after week_start that lands on this day_of_week.
      const anchor = new Date(week_start + 'T00:00:00');
      const anchorDow = anchor.getDay();
      let offset = day_of_week - anchorDow;
      if (offset < 0) offset += 7;
      const firstDate = new Date(anchor);
      firstDate.setDate(firstDate.getDate() + offset);
      const effectiveFrom = firstDate.toISOString().slice(0, 10);
      const yearEnd = new Date(firstDate.getFullYear(), 11, 31);

      const patternResult = await client.query(
        `INSERT INTO shift_patterns (user_id, ward_id, day_of_week, start_time, end_time, note, effective_from, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [user_id, ward_id || null, day_of_week, start_time, end_time, note || null, effectiveFrom, req.user.id]
      );
      const pattern = patternResult.rows[0];
      createdPatterns.push(pattern);

      // Generate every occurrence, weekly, from firstDate through Dec 31.
      let cursor = new Date(firstDate);
      while (cursor <= yearEnd) {
        await client.query(
          `INSERT INTO shifts (user_id, ward_id, pattern_id, shift_date, start_time, end_time, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [user_id, ward_id || null, pattern.id, cursor.toISOString().slice(0, 10), start_time, end_time, note || null]
        );
        totalShiftsCreated += 1;
        cursor.setDate(cursor.getDate() + 7);
      }
    }

    if (createdPatterns.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No valid entries to save' });
    }

    await client.query('COMMIT');
    res.status(201).json({ patterns: createdPatterns, shifts_created: totalShiftsCreated });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error creating weekly plan' });
  } finally {
    client.release();
  }
});

// DELETE /api/shifts/patterns/:id?from=YYYY-MM-DD — admin removes a
// recurring assignment. Only affects shift_date >= from (default: today) —
// past occurrences are left alone as history. This is the "ask the admin"
// step in practice: the frontend offers "just this day" (plain DELETE
// /api/shifts/:id, unchanged) vs "from here onward" (this endpoint), and
// the admin picks. If `from` is on/before the pattern's own effective_from,
// the whole pattern was really just cancelled outright, so the pattern row
// itself is removed too rather than left as a dangling template.
router.delete('/patterns/:id', authenticate, authorize('admin'), async (req, res) => {
  const from = req.query.from || new Date().toISOString().slice(0, 10);
  try {
    const pattern = await db.query('SELECT * FROM shift_patterns WHERE id = $1', [req.params.id]);
    if (pattern.rows.length === 0) return res.status(404).json({ error: 'Pattern not found' });

    const removed = await db.query(
      'DELETE FROM shifts WHERE pattern_id = $1 AND shift_date >= $2 RETURNING id',
      [req.params.id, from]
    );

    if (from <= pattern.rows[0].effective_from) {
      await db.query('DELETE FROM shift_patterns WHERE id = $1', [req.params.id]);
    }

    res.json({ success: true, shifts_removed: removed.rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error removing weekly plan' });
  }
});

module.exports = router;
