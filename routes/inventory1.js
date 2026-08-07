const express = require('express');
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

// General clinic inventory — medicines AND dental supplies (gloves, anesthesia,
// filling material, etc.) live in one table (`inventory_items`, formerly
// `medicines` — see migration_005_inventory.sql). There's no pharmacist role
// anymore; a dental clinic doesn't run its own in-house dispensary, so this
// is purely internal stock tracking with no connection to billing.

// GET /api/inventory/items?search=&low_stock=true&category=medicine|supply
router.get('/items', authenticate, async (req, res) => {
  const { search, low_stock, category } = req.query;
  const conditions = [];
  const values = [];
  let i = 1;
  if (search) { conditions.push(`name ILIKE $${i++}`); values.push(`%${search}%`); }
  if (low_stock === 'true') { conditions.push(`stock_quantity <= reorder_level`); }
  if (category) { conditions.push(`category = $${i++}`); values.push(category); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const result = await db.query(`SELECT * FROM inventory_items ${where} ORDER BY category, name`, values);
    res.json({ items: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching inventory' });
  }
});

// POST /api/inventory/items — add a medicine or supply to inventory (admin/nurse)
router.post('/items', authenticate, authorize('admin', 'nurse'), async (req, res) => {
  const { name, category, unit, stock_quantity, reorder_level, unit_price } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (category && !['medicine', 'supply'].includes(category)) {
    return res.status(400).json({ error: "category must be 'medicine' or 'supply'" });
  }

  try {
    const result = await db.query(
      `INSERT INTO inventory_items (name, category, unit, stock_quantity, reorder_level, unit_price)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name, category || 'medicine', unit, stock_quantity || 0, reorder_level || 10, unit_price]
    );
    res.status(201).json({ item: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error creating inventory item' });
  }
});

// PATCH /api/inventory/items/:id/stock — adjust stock (restock: positive delta, correction: negative)
router.patch('/items/:id/stock', authenticate, authorize('admin', 'nurse'), async (req, res) => {
  const { delta } = req.body;
  if (typeof delta !== 'number') {
    return res.status(400).json({ error: 'delta must be a number (e.g. 50 to restock, -5 to correct)' });
  }

  try {
    const result = await db.query(
      `UPDATE inventory_items SET stock_quantity = stock_quantity + $1 WHERE id = $2 RETURNING *`,
      [delta, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Inventory item not found' });
    if (result.rows[0].stock_quantity < 0) {
      return res.status(409).json({ error: 'Adjustment would result in negative stock' });
    }
    res.json({ item: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error adjusting stock' });
  }
});

module.exports = router;
