ALTER TABLE memory_dream_runs ADD COLUMN budget_update TEXT
  CHECK (budget_update IN ('saved', 'continue', 'retry'));
