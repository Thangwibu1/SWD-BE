import type { Database } from './db.js';

/** Technical state is separate from the five public business tables. */
export async function ensureReliabilitySchema(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    // Serialize DDL when several services boot against the same database.
    await tx.query('reliability.migrate.lock', "SELECT pg_advisory_xact_lock(731042001)");
    await tx.query('reliability.migrate', `
      CREATE SCHEMA IF NOT EXISTS reliability;
      CREATE TABLE IF NOT EXISTS reliability.outbox (
        event_id uuid PRIMARY KEY, routing_key text NOT NULL, envelope jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz
      );
      CREATE INDEX IF NOT EXISTS outbox_pending ON reliability.outbox(created_at) WHERE published_at IS NULL;
      CREATE TABLE IF NOT EXISTS reliability.inbox (
        consumer text NOT NULL, event_id uuid NOT NULL, processed_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(consumer, event_id)
      );
      CREATE TABLE IF NOT EXISTS reliability.payments (
        order_id uuid PRIMARY KEY, request jsonb NOT NULL, result jsonb NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reliability.inventory_operations (
        order_id uuid PRIMARY KEY, items jsonb NOT NULL,
        state text NOT NULL CHECK(state IN ('RESERVED','COMMITTED','RELEASED'))
      );
      CREATE TABLE IF NOT EXISTS reliability.rest_sagas (
        order_id uuid PRIMARY KEY,
        request jsonb NOT NULL, stage text NOT NULL,
        failure_code text, updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS reliability.queue_jobs (
        order_id uuid PRIMARY KEY, request jsonb NOT NULL,
        state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','PROCESSING','DONE')),
        attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
        lease_until timestamptz, lease_token uuid, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS queue_pending ON reliability.queue_jobs(available_at,created_at) WHERE state<>'DONE';
      CREATE TABLE IF NOT EXISTS reliability.carts (user_id uuid PRIMARY KEY, items jsonb NOT NULL);
    `);
  });
}

export async function clearReliabilityState(db: Database): Promise<void> {
  await ensureReliabilitySchema(db);
  await db.query('reliability.reset', `TRUNCATE reliability.outbox, reliability.inbox,
    reliability.payments, reliability.inventory_operations, reliability.rest_sagas,
    reliability.queue_jobs, reliability.carts`);
}
