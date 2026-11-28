-- Keep Pi's approval scope through queue recovery and group-plan retries.
CREATE TABLE pi_dispatch_models (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  route TEXT NOT NULL CHECK(json_valid(route)),
  PRIMARY KEY (conversation_id, scope)
);

CREATE TABLE chat_notices_v10 (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('browser_handback', 'auto_check', 'auto_check_proposal',
    'computer_handoff', 'continuation_stopped', 'connection_needed', 'workplace_move_proposal',
    'agent_warning', 'attachment_delivery_missing', 'browser_extension', 'dispatch_model_switch')),
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO chat_notices_v10 (id, conversation_id, bot_id, kind, detail, created_at)
  SELECT id, conversation_id, bot_id, kind, detail, created_at FROM chat_notices;
DROP TABLE chat_notices;
ALTER TABLE chat_notices_v10 RENAME TO chat_notices;
CREATE INDEX IF NOT EXISTS chat_notices_conversation ON chat_notices(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS chat_notices_bot ON chat_notices(bot_id);
CREATE INDEX IF NOT EXISTS chat_notices_kind ON chat_notices(kind, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS chat_notices_connection_run ON chat_notices(json_extract(detail, '$.runId'), json_extract(detail, '$.availability.connection')) WHERE kind='connection_needed';
-- The agent repeats the same warning every turn: one line per conversation and text.
CREATE UNIQUE INDEX IF NOT EXISTS chat_notices_agent_warning ON chat_notices(conversation_id, json_extract(detail, '$.text')) WHERE kind='agent_warning';

CREATE INDEX run_events_dispatch_model_failure ON run_events(at) WHERE kind='model.startup_failed';
