-- A parked approval still describes the runner chosen by its run, even after a folder rebind.
ALTER TABLE runs ADD COLUMN runner_device_id TEXT REFERENCES remote_devices(id) ON DELETE SET NULL;
