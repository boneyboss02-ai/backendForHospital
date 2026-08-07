const express = require('express');
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

// The treatments catalog: fixed-price procedures (e.g. "Tooth extraction —
// 2000") that a doctor picks from during a consultation instead of typing
// a charge and inventory usage by hand every time. Admin manages the
// catalog and its recipe; doctors and receptionists only need to read it
// (doctors to pick from it, reception as a price reference).

// GET /api/treatments — active treatments with their inventory recipe.
// ?include_inactive=true (admin only, for the management page) also
// returns retired treatments so their history/toggle state is visible.
router.get('/', authenticate, authorize('admin', 'doctor', 'receptionist'), async (req, res) => {
  const includeInactive = req.query.include_inactive === 'true' && req.user.role === 'admin';
  try {
    const treatments = await db.query(
      `SELECT * FROM treatments ${includeInactive ? '' : 'WHERE is_active = TRUE'} ORDER BY name`
    );
    const ids = treatments.rows.map((t) => t.id);
    let itemsByTreatment = {};
    if (ids.length > 0) {
      const items = await db.query(
        `SELECT ti.treatment_id, ti.item_id, ti.quantity, i.name AS item_name, i.unit
         FROM treatment_items ti JOIN inventory_items i ON i.id = ti.item_id
         WHERE ti.treatment_id = ANY($1::int[])`,
        [ids]
      );
      itemsByTreatment = items.rows.reduce((acc, item) => {
        (acc[item.treatment_id] = acc[item.treatment_id] || []).push(item);
        return acc;
      }, {});
    }
    const result = treatments.rows.map((t) => ({ ...t, items: itemsByTreatment[t.id] || [] }));
    res.json({ treatments: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching treatments' });
  }
});

// POST /api/treatments — admin only.
// body: { name, price, items?: [{ item_id, quantity }] }
router.post('/', authenticate, authorize('admin'), async (req, res) => {
  const { name, price, items } = req.body;
  if (!name || price === undefined || price === null || Number(price) < 0) {
    return res.status(400).json({ error: 'name and a non-negative price are required' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const created = await client.query(
      `INSERT INTO treatments (name, price) VALUES ($1, $2) RETURNING *`,
      [name, price]
    );
    const treatment = created.rows[0];

    const insertedItems = [];
    if (Array.isArray(items)) {
      for (const item of items) {
        const { item_id, quantity } = item;
        if (!item_id || !quantity || quantity <= 0) continue;
        const inserted = await client.query(
          `INSERT INTO treatment_items (treatment_id, item_id, quantity) VALUES ($1,$2,$3) RETURNING *`,
          [treatment.id, item_id, quantity]
        );
        insertedItems.push(inserted.rows[0]);
      }
    }

    await client.query('COMMIT');
    res.status(201).json({ treatment, items: insertedItems });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error creating treatment' });
  } finally {
    client.release();
  }
});

// PATCH /api/treatments/:id — admin only. Update name/price/active state,
// and optionally replace the whole recipe (if `items` is provided, the old
// recipe is fully replaced rather than merged — simpler to reason about
// than diffing item-by-item, and this is an infrequent admin action).
// body: { name?, price?, is_active?, items?: [{ item_id, quantity }] }
router.patch('/:id', authenticate, authorize('admin'), async (req, res) => {
  const { name, price, is_active, items } = req.body;

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const updates = [];
    const values = [];
    let i = 1;
    if (name !== undefined) { updates.push(`name = $${i++}`); values.push(name); }
    if (price !== undefined) { updates.push(`price = $${i++}`); values.push(price); }
    if (is_active !== undefined) { updates.push(`is_active = $${i++}`); values.push(is_active); }

    let treatment;
    if (updates.length > 0) {
      values.push(req.params.id);
      const updated = await client.query(
        `UPDATE treatments SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`,
        values
      );
      if (updated.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Treatment not found' });
      }
      treatment = updated.rows[0];
    } else {
      const existing = await client.query('SELECT * FROM treatments WHERE id = $1', [req.params.id]);
      if (existing.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Treatment not found' });
      }
      treatment = existing.rows[0];
    }

    let resultItems = null;
    if (Array.isArray(items)) {
      await client.query('DELETE FROM treatment_items WHERE treatment_id = $1', [req.params.id]);
      resultItems = [];
      for (const item of items) {
        const { item_id, quantity } = item;
        if (!item_id || !quantity || quantity <= 0) continue;
        const inserted = await client.query(
          `INSERT INTO treatment_items (treatment_id, item_id, quantity) VALUES ($1,$2,$3) RETURNING *`,
          [req.params.id, item_id, quantity]
        );
        resultItems.push(inserted.rows[0]);
      }
    }

    await client.query('COMMIT');
    res.json({ treatment, items: resultItems });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error updating treatment' });
  } finally {
    client.release();
  }
});

module.exports = router;
