ALTER TABLE messages ADD COLUMN reply_to_id INTEGER;
ALTER TABLE messages ADD COLUMN reply_to_user_id INTEGER;
CREATE INDEX messages_by_reply_recipient ON messages(reply_to_user_id,id);
