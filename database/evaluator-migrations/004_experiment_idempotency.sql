ALTER TABLE experiments ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX ux_experiments_idempotency_key ON experiments(idempotency_key) WHERE idempotency_key IS NOT NULL;
