-- Explicit limits of 3 or 4 are indistinguishable from the old defaults and rise to 8 too.
-- Legacy `limited` includes user cancellations and handoff stops. Neither counter proves
-- which limit was refused, so only new, explicitly recorded round stops are recoverable.
ALTER TABLE group_cycles ADD COLUMN round_limit_id TEXT;

ALTER TABLE groups RENAME COLUMN auto_round_limit TO old_auto_round_limit;
ALTER TABLE groups ADD COLUMN auto_round_limit INTEGER NOT NULL DEFAULT 8 CHECK(auto_round_limit BETWEEN 1 AND 10);
UPDATE groups SET auto_round_limit = old_auto_round_limit WHERE old_auto_round_limit NOT IN (3, 4, 8);
ALTER TABLE groups DROP COLUMN old_auto_round_limit;
