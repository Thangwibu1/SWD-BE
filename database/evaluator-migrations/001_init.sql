CREATE TABLE candidates (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  model_name TEXT,
  prompt_id TEXT,
  raw_json TEXT NOT NULL,
  normalized_json TEXT,
  validation_status TEXT NOT NULL,
  validation_errors_json TEXT,
  architecture_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE experiments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  candidate_id TEXT NOT NULL REFERENCES candidates(id),
  workload_profile TEXT NOT NULL,
  load_levels_json TEXT NOT NULL,
  slo_json TEXT NOT NULL,
  cost_catalog_version TEXT NOT NULL,
  repetitions INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE experiment_runs (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(id),
  run_number INTEGER NOT NULL,
  load_rps INTEGER NOT NULL,
  state TEXT NOT NULL,
  lease_owner TEXT,
  lease_until DATETIME,
  started_at DATETIME,
  completed_at DATETIME,
  failure_code TEXT,
  failure_message TEXT,
  metrics_json TEXT,
  cost_json TEXT,
  gates_json TEXT,
  scores_json TEXT
);

CREATE TABLE state_transitions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES experiment_runs(id),
  from_state TEXT,
  to_state TEXT NOT NULL,
  reason TEXT,
  occurred_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES experiment_runs(id),
  type TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL
);
