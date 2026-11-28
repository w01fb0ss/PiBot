-- Track conversations skipped for exceeding per-record size/token limits so done & history views report them.
ALTER TABLE import_jobs ADD COLUMN skipped_too_long INTEGER NOT NULL DEFAULT 0;
