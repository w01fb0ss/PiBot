CREATE TABLE chat_notices_v11 (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('browser_handback', 'auto_check', 'auto_check_proposal',
    'computer_handoff', 'continuation_stopped', 'connection_needed', 'workplace_move_proposal',
    'agent_warning', 'attachment_delivery_missing', 'browser_extension', 'dispatch_model_switch', 'group_verification')),
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO chat_notices_v11 (id, conversation_id, bot_id, kind, detail, created_at)
  SELECT id, conversation_id, bot_id, kind, detail, created_at FROM chat_notices;
DROP TABLE chat_notices;
ALTER TABLE chat_notices_v11 RENAME TO chat_notices;
CREATE INDEX IF NOT EXISTS chat_notices_conversation ON chat_notices(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS chat_notices_bot ON chat_notices(bot_id);
CREATE INDEX IF NOT EXISTS chat_notices_kind ON chat_notices(kind, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS chat_notices_connection_run ON chat_notices(json_extract(detail, '$.runId'), json_extract(detail, '$.availability.connection')) WHERE kind='connection_needed';
-- The agent repeats the same warning every turn: one line per conversation and text.
CREATE UNIQUE INDEX IF NOT EXISTS chat_notices_agent_warning ON chat_notices(conversation_id, json_extract(detail, '$.text')) WHERE kind='agent_warning';

CREATE INDEX pi_dispatches_finished_group ON pi_dispatches(target_id, id)
  WHERE target_kind='group' AND finished_at IS NOT NULL;
