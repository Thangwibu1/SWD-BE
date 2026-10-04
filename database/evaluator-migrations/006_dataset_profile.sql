ALTER TABLE experiments ADD COLUMN dataset_profile TEXT NOT NULL DEFAULT 'pilot'
  CHECK (dataset_profile IN ('pilot','main'));
