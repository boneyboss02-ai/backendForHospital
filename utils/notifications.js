// Shared helper for creating in-app notifications.
//
// Pass `client` when calling this inside an existing transaction (so the
// notification commits/rolls back together with the rest of the operation).
// Pass the plain `db` module when there's no surrounding transaction.
//
// Notifications are look-up only for users who actually have a login
// (user_id). Callers should skip this entirely if the target has no
// account yet — there's nothing to notify.
//
// Also pushes the notification over the websocket (utils/socket.js) so it
// shows up live in the bell instead of waiting for the next 30s poll. If
// the transaction this runs in later rolls back, the push already happened
// — that's an accepted tradeoff (rare, and worst case is a phantom
// notification for something that didn't actually happen, not a security issue).
const { emitToUser } = require('./socket');

async function createNotification(dbOrClient, { user_id, type, title, message, related_type, related_id }) {
  if (!user_id) return null; // no login to notify
  const result = await dbOrClient.query(
    `INSERT INTO notifications (user_id, type, title, message, related_type, related_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [user_id, type, title, message || null, related_type || null, related_id || null]
  );
  const notification = result.rows[0];
  emitToUser(user_id, 'notification', notification);
  return notification;
}

module.exports = { createNotification };
