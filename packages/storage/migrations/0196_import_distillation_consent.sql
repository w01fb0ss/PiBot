-- Consent and outcome belong to one import job. No conversation text is recorded here.
ALTER TABLE import_jobs ADD COLUMN distillation_consent TEXT;
ALTER TABLE import_jobs ADD COLUMN distillation_result TEXT;
ALTER TABLE conversations ADD COLUMN import_memory_excluded INTEGER NOT NULL DEFAULT 0
  CHECK (import_memory_excluded IN (0, 1));

CREATE INDEX IF NOT EXISTS messages_import_conversation
  ON messages(import_id, conversation_id) WHERE import_id IS NOT NULL;
