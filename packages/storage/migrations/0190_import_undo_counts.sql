-- Keep undo totals after the memory links have been cleared and file receipts have been scrubbed.
ALTER TABLE import_jobs ADD COLUMN removed_memories INTEGER NOT NULL DEFAULT 0;
ALTER TABLE import_project_notes ADD COLUMN removed INTEGER NOT NULL DEFAULT 0 CHECK(removed IN (0,1));
