PRAGMA foreign_keys = ON;
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  banned INTEGER NOT NULL DEFAULT 0,
  last_sent_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX messages_by_user ON messages(user_id);
CREATE TABLE reports (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
CREATE TABLE room (id INTEGER PRIMARY KEY CHECK (id = 1), revision TEXT NOT NULL);
INSERT INTO room VALUES (1, lower(hex(randomblob(16))));
CREATE TRIGGER message_inserted AFTER INSERT ON messages BEGIN
  UPDATE room SET revision = lower(hex(randomblob(16))) WHERE id = 1;
  DELETE FROM messages WHERE id <= NEW.id - 1000;
END;
CREATE TRIGGER message_deleted AFTER DELETE ON messages BEGIN
  UPDATE room SET revision = lower(hex(randomblob(16))) WHERE id = 1;
END;
