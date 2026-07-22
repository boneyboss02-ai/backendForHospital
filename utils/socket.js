const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

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
