ALTER TABLE knowledge_sources ADD COLUMN writable INTEGER NOT NULL DEFAULT 0 CHECK(writable IN (0, 1));
