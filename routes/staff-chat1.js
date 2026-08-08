const express = require('express');
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { createNotification } = require('../utils/notifications');
const { emitToUser } = require('../utils/socket');

const router = express.Router();

const MAX_MESSAGE_LENGTH = 4000;
const STAFF_ROLES = ['admin', 'doctor', 'nurse', 'receptionist'];

// Team chat — any staff member can message any other staff member.
// Deliberately not gated by any relationship check (unlike the
// doctor<->patient chat in routes/chat.js) — an admin and a receptionist
// don't need a shared appointment to talk to each other.
router.use(authenticate, authorize(...STAFF_ROLES));

// Orders a pair of user ids to match the CHECK(user_a_id < user_b_id)
// constraint, so the same two people always land on the same thread
// regardless of who started it.
function orderPair(idA, idB) {
  return idA < idB ? [idA, idB] : [idB, idA];
}

async function loadOwnConversation(req, res, next) {
  try {
    const result = await db.query('SELECT * FROM staff_conversations WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    const conversation = result.rows[0];
    if (conversation.user_a_id !== req.user.id && conversation.user_b_id !== req.user.id) {
      return res.status(403).json({ error: 'You do not have access to this conversation' });
    }
    req.conversation = conversation;
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error loading conversation' });
  }
}

// GET /api/staff-chat/contacts — every other staff member, for the "new
// conversation" picker. No relationship gating, just "is staff, isn't me".
router.get('/contacts', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, full_name, role FROM users WHERE role = ANY($1::text[]) AND id != $2 ORDER BY full_name`,
      [STAFF_ROLES, req.user.id]
    );
    res.json({ contacts: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching contacts' });
  }
});

// GET /api/staff-chat/conversations — thread list, newest activity first.
router.get('/conversations', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT
         c.id, c.user_a_id, c.user_b_id, c.created_at,
         u.full_name AS other_name, u.role AS other_role,
         lm.body AS last_message, lm.created_at AS last_message_at,
         COALESCE(uc.unread_count, 0) AS unread_count
       FROM staff_conversations c
       JOIN users u ON u.id = (CASE WHEN c.user_a_id = $1 THEN c.user_b_id ELSE c.user_a_id END)
       LEFT JOIN LATERAL (
         SELECT body, created_at FROM staff_messages m
         WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1
       ) lm ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS unread_count FROM staff_messages m
         WHERE m.conversation_id = c.id AND m.sender_id != $1 AND m.read_at IS NULL
       ) uc ON TRUE
       WHERE c.user_a_id = $1 OR c.user_b_id = $1
       ORDER BY lm.created_at DESC NULLS LAST, c.created_at DESC`,
      [req.user.id]
    );
    res.json({ conversations: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching conversations' });
  }
});

// POST /api/staff-chat/conversations — get-or-create a thread with a
// specific colleague. body: { other_user_id }
router.post('/conversations', async (req, res) => {
  const { other_user_id } = req.body;
  if (!other_user_id) return res.status(400).json({ error: 'other_user_id is required' });
  if (Number(other_user_id) === req.user.id) return res.status(400).json({ error: "You can't message yourself" });

  try {
    const otherUser = await db.query('SELECT id FROM users WHERE id = $1 AND role = ANY($2::text[])', [other_user_id, STAFF_ROLES]);
    if (otherUser.rows.length === 0) return res.status(404).json({ error: 'Staff member not found' });

    const [userA, userB] = orderPair(req.user.id, Number(other_user_id));
    const existing = await db.query('SELECT * FROM staff_conversations WHERE user_a_id = $1 AND user_b_id = $2', [userA, userB]);
    if (existing.rows.length > 0) return res.json({ conversation: existing.rows[0] });

    const created = await db.query(
      `INSERT INTO staff_conversations (user_a_id, user_b_id) VALUES ($1,$2)
       ON CONFLICT (user_a_id, user_b_id) DO NOTHING RETURNING *`,
      [userA, userB]
    );
    const conversation = created.rows[0] || (await db.query(
      'SELECT * FROM staff_conversations WHERE user_a_id = $1 AND user_b_id = $2', [userA, userB]
    )).rows[0];

    res.status(201).json({ conversation });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error creating conversation' });
  }
});

// GET /api/staff-chat/conversations/:id/messages?before=&limit=
router.get('/conversations/:id/messages', loadOwnConversation, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
  const before = req.query.before ? parseInt(req.query.before, 10) : null;

  try {
    const result = await db.query(
      `SELECT m.*, u.full_name AS sender_name
       FROM staff_messages m JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id = $1 ${before ? 'AND m.id < $3' : ''}
       ORDER BY m.created_at DESC
       LIMIT $2`,
      before ? [req.conversation.id, limit, before] : [req.conversation.id, limit]
    );
    const messages = result.rows.reverse();

    const markedRead = await db.query(
      `UPDATE staff_messages SET read_at = NOW()
       WHERE conversation_id = $1 AND sender_id != $2 AND read_at IS NULL
       RETURNING sender_id`,
      [req.conversation.id, req.user.id]
    );
    if (markedRead.rows.length > 0) {
      emitToUser(markedRead.rows[0].sender_id, 'staff_chat:read', { conversation_id: req.conversation.id, reader_id: req.user.id });
    }

    res.json({ messages, has_more: result.rows.length === limit });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching messages' });
  }
});

// POST /api/staff-chat/conversations/:id/messages
router.post('/conversations/:id/messages', loadOwnConversation, async (req, res) => {
  const body = (req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Message body is required' });
  if (body.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `Message is too long (max ${MAX_MESSAGE_LENGTH} characters)` });
  }

  try {
    const result = await db.query(
      `INSERT INTO staff_messages (conversation_id, sender_id, body) VALUES ($1,$2,$3) RETURNING *`,
      [req.conversation.id, req.user.id, body]
    );
    const message = { ...result.rows[0], sender_name: req.user.full_name };

    const recipientId = req.conversation.user_a_id === req.user.id ? req.conversation.user_b_id : req.conversation.user_a_id;

    emitToUser(req.user.id, 'staff_chat:message', message);
    emitToUser(recipientId, 'staff_chat:message', message);
    await createNotification(db, {
      user_id: recipientId,
      type: 'staff_chat_message',
      title: `New message from ${req.user.full_name}`,
      message: body.length > 120 ? `${body.slice(0, 117)}...` : body,
      related_type: 'staff_conversation',
      related_id: req.conversation.id,
    });

    res.status(201).json({ message });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error sending message' });
  }
});

module.exports = router;
