CREATE TRIGGER message_updated AFTER UPDATE OF text ON messages BEGIN
  UPDATE room SET revision = lower(hex(randomblob(16))) WHERE id = 1;
END;
