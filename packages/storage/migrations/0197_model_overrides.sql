ALTER TABLE conversations ADD COLUMN model_override TEXT CHECK (model_override IS NULL OR json_valid(model_override));
ALTER TABLE group_tasks ADD COLUMN model_override TEXT CHECK (model_override IS NULL OR json_valid(model_override));
