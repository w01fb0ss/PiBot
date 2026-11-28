-- The shared search index is unavailable while its old pages are cleared and its
-- redacted documents are replayed. The phase and cursor commit with each page.
CREATE TABLE IF NOT EXISTS chat_search_rebuild (
  id INTEGER PRIMARY KEY CHECK (id=1),
  phase TEXT NOT NULL CHECK (phase IN ('clearing','deleting','replaying')),
  after_id INTEGER NOT NULL DEFAULT 0,
  through_id INTEGER NOT NULL DEFAULT 0
);

-- A rebuild already drops postings from all jobs that were hidden at replay start.
CREATE TABLE IF NOT EXISTS chat_search_pruned_imports (
  import_id TEXT PRIMARY KEY NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE
);

DROP TRIGGER IF EXISTS chat_search_fts_insert;
DROP TRIGGER IF EXISTS chat_search_fts_delete;
DROP TRIGGER IF EXISTS chat_search_fts_update;
CREATE TRIGGER chat_search_fts_insert AFTER INSERT ON chat_search_documents
WHEN NEW.body<>'' AND NOT EXISTS (SELECT 1 FROM chat_search_rebuild WHERE phase<>'replaying') BEGIN
  INSERT INTO chat_search_fts(rowid,scope,body)
    SELECT NEW.rowid,NEW.scope,NEW.body WHERE NOT EXISTS (
      SELECT 1 FROM messages m JOIN import_jobs j ON j.id=m.import_id
      WHERE m.id=NEW.message_id AND j.cleanup_phase IS NOT NULL);
END;
CREATE TRIGGER chat_search_fts_delete AFTER DELETE ON chat_search_documents
WHEN OLD.body<>'' AND NOT EXISTS (SELECT 1 FROM chat_search_rebuild WHERE phase<>'replaying')
  AND EXISTS (SELECT 1 FROM chat_search_fts_docsize WHERE id=OLD.rowid) BEGIN
  INSERT INTO chat_search_fts(chat_search_fts,rowid,scope,body)
    VALUES('delete',OLD.rowid,OLD.scope,OLD.body);
END;
CREATE TRIGGER chat_search_fts_update AFTER UPDATE OF scope,body ON chat_search_documents
WHEN (OLD.scope IS NOT NEW.scope OR OLD.body IS NOT NEW.body)
  AND NOT EXISTS (SELECT 1 FROM chat_search_rebuild WHERE phase<>'replaying') BEGIN
  INSERT INTO chat_search_fts(chat_search_fts,rowid,scope,body)
    SELECT 'delete',OLD.rowid,OLD.scope,OLD.body WHERE OLD.body<>'' AND EXISTS (
      SELECT 1 FROM chat_search_fts_docsize WHERE id=OLD.rowid);
  INSERT INTO chat_search_fts(rowid,scope,body)
    SELECT NEW.rowid,NEW.scope,NEW.body WHERE NEW.body<>'' AND NOT EXISTS (
      SELECT 1 FROM messages m JOIN import_jobs j ON j.id=m.import_id
      WHERE m.id=NEW.message_id AND j.cleanup_phase IS NOT NULL);
END;

-- SQLite checks these child keys for every deleted message or topic, even when
-- the imported rows have no matching children.
CREATE INDEX IF NOT EXISTS scoped_memory_proposals_message ON scoped_memory_proposals(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS scoped_memories_source_message ON scoped_memories(source_message_id) WHERE source_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS group_workflow_steps_decision_message ON group_workflow_steps(decision_message_id) WHERE decision_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS group_workflow_runs_source_message ON group_workflow_runs(source_message_id);
CREATE INDEX IF NOT EXISTS group_memory_proposals_message ON group_memory_proposals(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS group_memories_source_message ON group_memories(source_message_id) WHERE source_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS routine_proposals_message ON routine_proposals(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS memory_proposals_message ON memory_proposals(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS memories_source_message ON memories(source_message_id) WHERE source_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS external_agent_sessions_conversation ON external_agent_sessions(conversation_id);
CREATE INDEX IF NOT EXISTS personal_todos_source_conversation ON personal_todos(source_conversation_id) WHERE source_conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS group_topic_creations_conversation ON group_topic_creations(conversation_id);
CREATE INDEX IF NOT EXISTS group_member_workspaces_source_conversation ON group_member_workspaces(source_conversation_id);
CREATE INDEX IF NOT EXISTS execution_plan_archive_conversation ON execution_plan_archive(conversation_id);
CREATE INDEX IF NOT EXISTS delivery_evidence_conversation ON delivery_evidence(conversation_id);
CREATE INDEX IF NOT EXISTS review_executions_conversation ON review_executions(conversation_id);
CREATE INDEX IF NOT EXISTS task_attempts_internal_conversation ON task_attempts(internal_conversation_id);
CREATE INDEX IF NOT EXISTS task_instances_source_conversation ON task_instances(source_conversation_id);
CREATE INDEX IF NOT EXISTS execution_todo_conversation ON execution_todo(conversation_id);
CREATE INDEX IF NOT EXISTS execution_settings_conversation ON execution_settings(conversation_id);
CREATE INDEX IF NOT EXISTS conversations_thread_of ON conversations(thread_of) WHERE thread_of IS NOT NULL;
CREATE INDEX IF NOT EXISTS approvals_conversation ON approvals(conversation_id) WHERE conversation_id IS NOT NULL;

-- Undo checks active work before changing visibility, so admission scales with
-- live work rather than the number of imported conversations.
CREATE INDEX IF NOT EXISTS task_instances_live_sources ON task_instances(source_conversation_id)
  WHERE status IN ('queued','running','stopping');
CREATE INDEX IF NOT EXISTS approvals_pending_messages ON approvals(message_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS conversations_routine ON conversations(routine_id) WHERE routine_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS conversations_import_bot ON conversations(import_id,bot_id) WHERE import_id IS NOT NULL;
