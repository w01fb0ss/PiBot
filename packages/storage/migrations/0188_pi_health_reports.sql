-- The default Pi's health checks: one row per pi_health_check call, read by the list card under
-- that step and by pi_repair, which refuses an item whose state changed since. Ids, names, states,
-- times and fixed codes only; never message text, file contents or secrets.
CREATE TABLE pi_health_reports (
  id TEXT PRIMARY KEY,
  pi_bot_id TEXT NOT NULL,
  pi_run_id TEXT NOT NULL,
  pi_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL,
  scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
  items_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(items_json)),
  more INTEGER NOT NULL DEFAULT 0 CHECK(more >= 0),
  resolutions_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(resolutions_json)),
  created_at TEXT NOT NULL,
  UNIQUE(pi_run_id, tool_call_id)
);

CREATE INDEX pi_health_reports_message ON pi_health_reports(pi_message_id, created_at);
