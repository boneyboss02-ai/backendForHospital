-- ============================================
-- Migration 012: Chat attachments (voice, image, video, PDF, file)
-- Run once against an existing database, in order after migration_011.
-- ============================================

-- body becomes optional: a message can now be JUST an attachment (e.g. a
-- voice note or a photo) with no caption text. The CHECK constraint makes
-- sure it's never neither — every message has to have something.
ALTER TABLE messages ALTER COLUMN body DROP NOT NULL;
ALTER TABLE messages ADD COLUMN attachment_url VARCHAR(255);
ALTER TABLE messages ADD COLUMN attachment_type VARCHAR(20); -- 'image' | 'video' | 'audio' | 'pdf' | 'file'
ALTER TABLE messages ADD COLUMN attachment_name VARCHAR(255);
ALTER TABLE messages ADD CONSTRAINT messages_body_or_attachment
  CHECK (body IS NOT NULL OR attachment_url IS NOT NULL);

ALTER TABLE staff_messages ALTER COLUMN body DROP NOT NULL;
ALTER TABLE staff_messages ADD COLUMN attachment_url VARCHAR(255);
ALTER TABLE staff_messages ADD COLUMN attachment_type VARCHAR(20);
ALTER TABLE staff_messages ADD COLUMN attachment_name VARCHAR(255);
ALTER TABLE staff_messages ADD CONSTRAINT staff_messages_body_or_attachment
  CHECK (body IS NOT NULL OR attachment_url IS NOT NULL);
