const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

// Shared by routes/chat.js and routes/staff-chat.js. Same pattern as
// lab-results and payment-proofs: stored outside any statically-served
// folder, only ever handed out through an authenticated route that checks
// the requester actually has access to the conversation.
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'chat-attachments');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Maps mimetype -> our simplified attachment_type, used both to validate
// what's allowed and to tell the frontend how to render it (image preview,
// <video> player, <audio> player for voice notes, or a plain file link).
const MIME_TO_TYPE = {
  'image/jpeg': 'image', 'image/png': 'image', 'image/gif': 'image', 'image/webp': 'image',
  'video/mp4': 'video', 'video/webm': 'video', 'video/quicktime': 'video',
  'audio/webm': 'audio', 'audio/mpeg': 'audio', 'audio/mp3': 'audio', 'audio/ogg': 'audio', 'audio/wav': 'audio', 'audio/mp4': 'audio',
  'application/pdf': 'pdf',
};

const EXT_BY_MIME = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  'audio/webm': '.webm', 'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/ogg': '.ogg', 'audio/wav': '.wav', 'audio/mp4': '.m4a',
  'application/pdf': '.pdf',
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${EXT_BY_MIME[file.mimetype] || ''}`),
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB — generous enough for a short voice note or a phone photo
  fileFilter: (req, file, cb) => {
    if (!MIME_TO_TYPE[file.mimetype]) {
      return cb(new Error('Only images, videos, audio (voice notes), and PDFs are allowed'));
    }
    cb(null, true);
  },
});

function attachmentTypeFor(mimetype) {
  return MIME_TO_TYPE[mimetype] || 'file';
}

// Wraps multer so its errors come back as normal JSON 400s instead of an
// unhandled exception.
function handleChatUpload(req, res, next) {
  upload.single('attachment')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}

module.exports = { UPLOAD_DIR, attachmentTypeFor, handleChatUpload };
