const express = require('express');
const db = require('../config/db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// GET /api/notifications?unread_only=true — always scoped to req.user.id
router.get('/', authenticate, async (req, res) => {
  const { unread_only } = req.query;
  const conditions = ['user_id = $1'];
  if (unread_only === 'true') conditions.push('read_at IS NULL');

  try {
    const result = await db.query(
      `SELECT * FROM notifications WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    const unreadCount = await db.query(
      `SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
      [req.user.id]
    );
    res.json({ notifications: result.rows, unread_count: parseInt(unreadCount.rows[0].count, 10) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching notifications' });
  }
});

// PATCH /api/notifications/:id/read
router.patch('/:id/read', authenticate, async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE notifications SET read_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Notification not found' });
    res.json({ notification: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error updating notification' });
  }
});

// PATCH /api/notifications/read-all
router.patch('/read-all', authenticate, async (req, res) => {
  try {
    await db.query(`UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL`, [req.user.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error updating notifications' });
  }
});

module.exports = router;
