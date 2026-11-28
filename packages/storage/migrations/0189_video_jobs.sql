CREATE TABLE IF NOT EXISTS video_jobs (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('queued', 'generating', 'downloading', 'done', 'failed', 'cancelled')),
  created_at INTEGER NOT NULL,
  record_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS video_jobs_active ON video_jobs(created_at, id)
  WHERE status IN ('queued', 'generating', 'downloading');
