ALTER TABLE experiments RENAME COLUMN dataset_profile TO dataset_profile_legacy;
ALTER TABLE experiments ADD COLUMN dataset_profile TEXT NOT NULL DEFAULT 'pilot'
  CHECK (dataset_profile IN ('pilot','main','capacity'));
UPDATE experiments SET dataset_profile = dataset_profile_legacy;
ALTER TABLE experiments DROP COLUMN dataset_profile_legacy;
