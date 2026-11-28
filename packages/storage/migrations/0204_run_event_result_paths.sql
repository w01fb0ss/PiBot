-- Retention checks file references before unlinking, including when a cleanup is retried.
CREATE INDEX IF NOT EXISTS run_events_result_path
ON run_events(json_extract(payload,'$.result.path'), run_id)
WHERE json_type(payload,'$.result.path')='text';
