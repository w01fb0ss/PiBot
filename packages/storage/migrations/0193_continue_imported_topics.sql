DROP TRIGGER IF EXISTS import_message_owner;
DROP TRIGGER IF EXISTS import_run_read_only;
DROP TRIGGER IF EXISTS import_topic_read_only;

-- Imported rows still belong to their original batch. Live messages may join a published topic.
CREATE TRIGGER import_message_owner BEFORE INSERT ON messages
WHEN (NEW.import_id IS NOT NULL AND (
    NEW.import_id IS NOT (SELECT import_id FROM conversations WHERE id=NEW.conversation_id)
    OR NOT EXISTS (SELECT 1 FROM import_jobs WHERE id=NEW.import_id AND state='running' AND cleanup_phase IS NULL)
  ))
  OR (NEW.import_id IS NULL AND EXISTS (
    SELECT 1 FROM conversations c JOIN import_jobs j ON j.id=c.import_id
    WHERE c.id=NEW.conversation_id AND (j.state<>'completed' OR j.cleanup_phase IS NOT NULL)
  ))
BEGIN
  SELECT RAISE(ABORT, 'import_topic_unavailable');
END;

CREATE TRIGGER import_run_owner BEFORE INSERT ON runs
WHEN EXISTS (
  SELECT 1 FROM conversations c JOIN import_jobs j ON j.id=c.import_id
  WHERE c.id=NEW.conversation_id AND (j.state<>'completed' OR j.cleanup_phase IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'import_topic_unavailable');
END;

-- Undo detaches a continued topic after removing the imported rows and its old session.
CREATE TRIGGER import_topic_owner_update
BEFORE UPDATE OF id,kind,bot_id,group_id,thread_of,import_id,import_source ON conversations
WHEN (OLD.import_id IS NOT NULL OR NEW.import_id IS NOT NULL) AND (
  OLD.id IS NOT NEW.id OR OLD.kind IS NOT NEW.kind OR OLD.bot_id IS NOT NEW.bot_id
  OR OLD.group_id IS NOT NEW.group_id OR OLD.thread_of IS NOT NEW.thread_of
  OR OLD.import_source IS NOT NEW.import_source
  OR (OLD.import_id IS NOT NEW.import_id AND NOT (
    OLD.import_id IS NOT NULL AND NEW.import_id IS NULL
    AND EXISTS (SELECT 1 FROM import_jobs WHERE id=OLD.import_id AND cleanup_phase='undoing')
  ))
)
BEGIN
  SELECT RAISE(ABORT, 'import_topic_unavailable');
END;

ALTER TABLE messages ADD COLUMN import_history_parts TEXT;
