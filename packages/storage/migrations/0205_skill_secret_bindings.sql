CREATE TABLE IF NOT EXISTS skill_secret_bindings (
  scope TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  variable TEXT NOT NULL,
  secret_name TEXT NOT NULL,
  PRIMARY KEY (scope, skill_id, variable)
);
