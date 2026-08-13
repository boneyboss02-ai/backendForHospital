const express = require('express');
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { isBranchScoped } = require('../utils/branchScope');

const router = express.Router();

// General clinic inventory — medicines AND dental supplies (gloves, anesthesia,
// filling material, etc.) live in one table (`inventory_items`, formerly
// `medicines` — see migration_005_inventory.sql). There's no pharmacist role
// anymore; a dental clinic doesn't run its own in-house dispensary, so this
// is purely internal stock tracking with no connection to billing.
//
// Each branch stocks and manages its own inventory — not a shared catalog
// (the client's explicit call when this feature was designed). A
// branch-scoped user only ever sees/touches their own branch's items; a
// general admin sees everything and must specify branch_id when creating.

// GET /api/inventory/items?search=&low_stock=true&category=medicine|supply&branch_id=
// branch_id is only honored for a general admin — a branch-scoped caller
// is always filtered to their own branch regardless of what's passed.
router.get('/items', authenticate, async (req, res) => {
  const { search, low_stock, category } = req.query;
  let { branch_id } = req.query;
  if (isBranchScoped(req)) branch_id = req.user.branch_id;

  const conditions = [];
  const values = [];
  let i = 1;
  if (branch_id) { conditions.push(`i.branch_id = $${i++}`); values.push(branch_id); }
  if (search) { conditions.push(`i.name ILIKE $${i++}`); values.push(`%${search}%`); }
  if (low_stock === 'true') { conditions.push(`i.stock_quantity <= i.reorder_level`); }
  if (category) { conditions.push(`i.category = $${i++}`); values.push(category); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const result = await db.query(
      `SELECT i.*, b.name AS branch_name FROM inventory_items i JOIN branches b ON b.id = i.branch_id ${where} ORDER BY i.category, i.name`,
      values
    );
    res.json({ items: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching inventory' });
  }
});

// POST /api/inventory/items — add a medicine or supply to inventory.
// Admin only (general or branch) — see the migration_013/reports comments
// elsewhere for why this was tightened to admin-only a while back.
router.post('/items', authenticate, authorize('admin'), async (req, res) => {
  const { name, category, unit, stock_quantity, reorder_level, unit_price } = req.body;
  let { branch_id } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (category && !['medicine', 'supply'].includes(category)) {
    return res.status(400).json({ error: "category must be 'medicine' or 'supply'" });
  }
  if (isBranchScoped(req)) {
    branch_id = req.user.branch_id;
  } else if (!branch_id) {
    return res.status(400).json({ error: 'branch_id is required' });
  }

  try {
    const result = await db.query(
      `INSERT INTO inventory_items (name, category, unit, stock_quantity, reorder_level, unit_price, branch_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [name, category || 'medicine', unit, stock_quantity || 0, reorder_level || 10, unit_price, branch_id]
    );
    res.status(201).json({ item: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error creating inventory item' });
  }
});

// PATCH /api/inventory/items/:id/stock — adjust stock (restock: positive
// delta, correction: negative). A branch admin can only adjust their own
// branch's items.
router.patch('/items/:id/stock', authenticate, authorize('admin'), async (req, res) => {
  const { delta } = req.body;
  if (typeof delta !== 'number') {
    return res.status(400).json({ error: 'delta must be a number (e.g. 50 to restock, -5 to correct)' });
  }

  try {
    if (isBranchScoped(req)) {
      const item = await db.query('SELECT branch_id FROM inventory_items WHERE id = $1', [req.params.id]);
      if (item.rows.length === 0) return res.status(404).json({ error: 'Inventory item not found' });
      if (item.rows[0].branch_id !== req.user.branch_id) {
        return res.status(403).json({ error: 'This item is not at your branch' });
      }
    }

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
