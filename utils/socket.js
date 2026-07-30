const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const db = require('../config/db');

let io = null;

// Called once from server.js with the underlying http.Server. Notifications
// are pushed to a per-user room (`user:<id>`) so a user only ever receives
// their own — same trust boundary as the REST API, just over a socket.
function init(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: '*' }, // fine for local/dev; tighten if this ever leaves your network
  });

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('Missing auth token'));
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = decoded;
      next();
    } catch (err) {
      next(new Error('Invalid or expired token'));
    }
  });

  io.on('connection', (socket) => {
    socket.join(`user:${socket.user.id}`);

    // Ephemeral, never persisted — just relayed to the other participant
    // while both happen to be connected. Payload: { conversation_id, is_typing }.
    // We re-check that this socket's user is actually a participant of the
    // conversation on every event rather than trusting the client, since
    // otherwise anyone could fire a typing indicator into an arbitrary
    // conversation id.
    socket.on('chat:typing', async ({ conversation_id, is_typing }) => {
      if (!conversation_id) return;
      try {
        const result = await db.query(
          `SELECT c.doctor_id, p.user_id AS patient_user_id
           FROM conversations c JOIN patients p ON p.id = c.patient_id
           WHERE c.id = $1`,
          [conversation_id]
        );
        const convo = result.rows[0];
        if (!convo) return;

        const isParticipant = convo.doctor_id === socket.user.id || convo.patient_user_id === socket.user.id;
        if (!isParticipant) return;

        const otherUserId = convo.doctor_id === socket.user.id ? convo.patient_user_id : convo.doctor_id;
        if (otherUserId) {
          emitToUser(otherUserId, 'chat:typing', {
            conversation_id,
            user_id: socket.user.id,
            is_typing: !!is_typing,
          });
        }
      } catch (err) {
        console.error('chat:typing relay failed', err);
      }
    });
  });

  return io;
}

// Used by utils/notifications.js right after a notification row is inserted.
// If nobody's connected (io not initialized, or that user isn't online),
// this is a harmless no-op — the notification still exists in the DB and
// shows up next time they load/poll the bell.
function emitToUser(userId, event, payload) {
  if (!io) return;
  io.to(`user:${userId}`).emit(event, payload);
}

module.exports = { init, emitToUser };
