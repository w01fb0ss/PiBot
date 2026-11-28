ALTER TABLE memory_extractions ADD COLUMN model_fallback TEXT;
ALTER TABLE memory_organizations ADD COLUMN model_fallback TEXT;
ALTER TABLE memory_dream_runs ADD COLUMN model_fallback TEXT;
ALTER TABLE memory_dream_runs ADD COLUMN failure_reason TEXT;
