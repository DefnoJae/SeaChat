ALTER TABLE messages ADD COLUMN spoiler INTEGER NOT NULL DEFAULT 0;
CREATE TABLE presence (user_id INTEGER PRIMARY KEY REFERENCES users(id), seen_at INTEGER NOT NULL);
CREATE INDEX presence_by_seen ON presence(seen_at);
