const express = require('express');
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { createNotification } = require('../utils/notifications');
const { emitToUser } = require('../utils/socket');

const router = express.Router();

const MAX_MESSAGE_LENGTH = 4000;

// Every route here is doctor-or-patient only. Everything is scoped to
// req.user.id / the resolved patient record — never to an id read off the
// request — same trust model as routes/portal.js.
router.use(authenticate, authorize('doctor', 'patient'));

// For a patient, resolves their patients.id once and stashes it on
// req.patientId. Doctors don't need this (their identity for chat purposes
// is just req.user.id), so it's skipped for them.
router.use(async (req, res, next) => {
  if (req.user.role !== 'patient') return next();
  try {
    const result = await db.query('SELECT id FROM patients WHERE user_id = $1', [req.user.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No patient record is linked to this account' });
    }
    req.patientId = result.rows[0].id;
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error loading patient record' });
  }
});

// Loads req.params.id as req.conversation, but only if the logged-in user
// (doctor or patient) is actually one of its two participants. This is the
// one check every message-level route below depends on — get it wrong and
// a patient could read another patient's thread with the same doctor.
async function loadOwnConversation(req, res, next) {
  try {
    const result = await db.query('SELECT * FROM conversations WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    const conversation = result.rows[0];
    const isParticipant =
      (req.user.role === 'doctor' && conversation.doctor_id === req.user.id) ||
      (req.user.role === 'patient' && conversation.patient_id === req.patientId);
    if (!isParticipant) {
      return res.status(403).json({ error: 'You do not have access to this conversation' });
    }
    req.conversation = conversation;
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error loading conversation' });
  }
}

// GET /api/chat/contacts
// Who the current user is allowed to start a new thread with — derived from
// real clinical relationships (a shared appointment or admission), not a
// free-for-all directory. This is what makes conversation creation safe:
// POST /conversations re-checks against the exact same relationship.
router.get('/contacts', async (req, res) => {
  try {
    if (req.user.role === 'doctor') {
      const result = await db.query(
        `SELECT DISTINCT p.id AS patient_id, p.full_name, p.patient_code
         FROM patients p
         WHERE p.id IN (
           SELECT patient_id FROM appointments WHERE doctor_id = $1
           UNION
           SELECT patient_id FROM admissions WHERE attending_doctor_id = $1
         )
         ORDER BY p.full_name`,
        [req.user.id]
      );
      return res.json({ contacts: result.rows });
    }

    const result = await db.query(
      `SELECT DISTINCT u.id AS doctor_id, u.full_name, sp.specialty
       FROM users u
       LEFT JOIN staff_profiles sp ON sp.user_id = u.id
       WHERE u.id IN (
         SELECT doctor_id FROM appointments WHERE patient_id = $1 AND doctor_id IS NOT NULL
         UNION
         SELECT attending_doctor_id FROM admissions WHERE patient_id = $1 AND attending_doctor_id IS NOT NULL
       )
       ORDER BY u.full_name`,
      [req.patientId]
    );
    res.json({ contacts: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching contacts' });
  }
});

// GET /api/chat/conversations — thread list for the current user, newest
// activity first, with a last-message preview and unread count per thread.
router.get('/conversations', async (req, res) => {
  try {
    const isDoctor = req.user.role === 'doctor';
    const result = await db.query(
      `SELECT
         c.id, c.patient_id, c.doctor_id, c.created_at,
         ${isDoctor ? 'p.full_name AS other_name, p.patient_code AS other_detail' : "u.full_name AS other_name, sp.specialty AS other_detail"},
         lm.body AS last_message, lm.created_at AS last_message_at,
         COALESCE(uc.unread_count, 0) AS unread_count
       FROM conversations c
       ${isDoctor ? 'JOIN patients p ON p.id = c.patient_id' : 'JOIN users u ON u.id = c.doctor_id LEFT JOIN staff_profiles sp ON sp.user_id = u.id'}
       LEFT JOIN LATERAL (
         SELECT body, created_at FROM messages m
         WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1
       ) lm ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS unread_count FROM messages m
         WHERE m.conversation_id = c.id AND m.sender_id != $1 AND m.read_at IS NULL
       ) uc ON TRUE
       WHERE ${isDoctor ? 'c.doctor_id = $1' : 'c.patient_id = $2'}
       ORDER BY lm.created_at DESC NULLS LAST, c.created_at DESC`,
      isDoctor ? [req.user.id] : [req.user.id, req.patientId]
    );
    res.json({ conversations: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching conversations' });
  }
});

// POST /api/chat/conversations — get-or-create the thread with a specific
// contact. Body is { patient_id } if you're a doctor, { doctor_id } if
// you're a patient. Re-validates the relationship server-side even though
// /contacts already filtered it — a stale contacts list shouldn't be able
// to open a thread that's no longer justified by any appointment/admission.
router.post('/conversations', async (req, res) => {
  try {
    let patientId, doctorId;

    if (req.user.role === 'doctor') {
      patientId = req.body.patient_id;
      doctorId = req.user.id;
      if (!patientId) return res.status(400).json({ error: 'patient_id is required' });

      const related = await db.query(
        `SELECT 1 FROM appointments WHERE doctor_id = $1 AND patient_id = $2
         UNION SELECT 1 FROM admissions WHERE attending_doctor_id = $1 AND patient_id = $2`,
        [doctorId, patientId]
      );
      if (related.rows.length === 0) {
        return res.status(403).json({ error: 'You have no appointments or admissions with this patient' });
      }
    } else {
      doctorId = req.body.doctor_id;
      patientId = req.patientId;
      if (!doctorId) return res.status(400).json({ error: 'doctor_id is required' });

      const related = await db.query(
        `SELECT 1 FROM appointments WHERE doctor_id = $1 AND patient_id = $2
         UNION SELECT 1 FROM admissions WHERE attending_doctor_id = $1 AND patient_id = $2`,
        [doctorId, patientId]
      );
      if (related.rows.length === 0) {
        return res.status(403).json({ error: 'You have no appointments or admissions with this doctor' });
      }
    }

    const existing = await db.query(
      'SELECT * FROM conversations WHERE patient_id = $1 AND doctor_id = $2',
      [patientId, doctorId]
    );
    if (existing.rows.length > 0) {
      return res.json({ conversation: existing.rows[0] });
    }

    const created = await db.query(
      `INSERT INTO conversations (patient_id, doctor_id) VALUES ($1, $2)
       ON CONFLICT (patient_id, doctor_id) DO NOTHING RETURNING *`,
      [patientId, doctorId]
    );
    const conversation = created.rows[0] || (await db.query(
      'SELECT * FROM conversations WHERE patient_id = $1 AND doctor_id = $2',
      [patientId, doctorId]
    )).rows[0];

    res.status(201).json({ conversation });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error creating conversation' });
  }
});

// GET /api/chat/conversations/:id/messages?before=<messageId>&limit=50
// Cursor-paginated, oldest-to-newest in the response (ready to render
// top-to-bottom). Also marks the other participant's messages as read,
// since opening a thread is what "reading" it means here.
router.get('/conversations/:id/messages', loadOwnConversation, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
  const before = req.query.before ? parseInt(req.query.before, 10) : null;

  try {
    const result = await db.query(
      `SELECT m.*, u.full_name AS sender_name
       FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id = $1 ${before ? 'AND m.id < $3' : ''}
       ORDER BY m.created_at DESC
       LIMIT $2`,
      before ? [req.conversation.id, limit, before] : [req.conversation.id, limit]
    );
    const messages = result.rows.reverse();

    const markedRead = await db.query(
      `UPDATE messages SET read_at = NOW()
       WHERE conversation_id = $1 AND sender_id != $2 AND read_at IS NULL
       RETURNING sender_id`,
      [req.conversation.id, req.user.id]
    );

    // Let the sender's own screen flip to "seen" in real time, if they're
    // connected — purely cosmetic, never relied on for correctness.
    if (markedRead.rows.length > 0) {
      const otherUserId = markedRead.rows[0].sender_id;
      emitToUser(otherUserId, 'chat:read', { conversation_id: req.conversation.id, reader_id: req.user.id });
    }

    res.json({ messages, has_more: result.rows.length === limit });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching messages' });
  }
});

// POST /api/chat/conversations/:id/messages — send a message.
router.post('/conversations/:id/messages', loadOwnConversation, async (req, res) => {
  const body = (req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Message body is required' });
  if (body.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `Message is too long (max ${MAX_MESSAGE_LENGTH} characters)` });
  }

  try {
    const result = await db.query(
      `INSERT INTO messages (conversation_id, sender_id, body) VALUES ($1, $2, $3) RETURNING *`,
      [req.conversation.id, req.user.id, body]
    );
    const message = { ...result.rows[0], sender_name: req.user.full_name };

    // Figure out the other participant's user id so we can push to them.
    // For the doctor side that's just conversation.doctor_id. For the
    // patient side we need patients.user_id — and a patient may not have a
    // portal login at all, in which case there's simply nobody to push to.
    let recipientUserId;
    if (req.user.role === 'doctor') {
      const patientUser = await db.query('SELECT user_id FROM patients WHERE id = $1', [req.conversation.patient_id]);
      recipientUserId = patientUser.rows[0]?.user_id || null;
    } else {
      recipientUserId = req.conversation.doctor_id;
    }

    // Live push to whoever's connected — the sender (other open tabs) and
    // the recipient (instant delivery instead of waiting on a poll).
    emitToUser(req.user.id, 'chat:message', message);
    if (recipientUserId) {
      emitToUser(recipientUserId, 'chat:message', message);
      await createNotification(db, {
        user_id: recipientUserId,
        type: 'chat_message',
        title: `New message from ${req.user.full_name}`,
        message: body.length > 120 ? `${body.slice(0, 117)}...` : body,
        related_type: 'conversation',
        related_id: req.conversation.id,
      });
    }

    res.status(201).json({ message });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error sending message' });
  }
});

module.exports = router;
