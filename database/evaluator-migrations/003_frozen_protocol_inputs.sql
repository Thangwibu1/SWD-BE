ALTER TABLE experiments ADD COLUMN score_bounds_version TEXT NOT NULL DEFAULT 'development-v1';
ALTER TABLE experiments ADD COLUMN protocol_version TEXT;
