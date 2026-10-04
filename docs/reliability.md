# Durable event processing and REST checkout recovery

Implemented on 2026-10-04 for existing A01–A12 profiles. REST/event runtime
behavior changed: compare fresh runs from one frozen image, not mixed versions.

## Storage and upgrade

The five public business tables and public HTTP contract remain unchanged.
Services initialize a separate `reliability` schema under a database advisory
lock. Existing pilot/capacity snapshots keep their business checksums.
Evaluator restore and `db:sut:reset` clear technical state so pending events,
deduplication records and inventory tombstones cannot leak between experiments.
Use a fresh benchmark stack when switching to the new image.

Technical tables: `outbox`, `inbox`, `payments`, `inventory_operations`,
`rest_sagas`. Back them up with the business database in long-lived deployments.
Never clear these tables to recover an application crash. Retain deduplication
records for the entire replay window; deleting them can allow duplicate effects.

## Event profiles A09–A12

Order creation and its outgoing event commit together. Each handler atomically
commits its inbox claim, database mutations and outgoing events. Nested domain
transactions use savepoints so failed multi-item reservations roll back every
item before recording their rejection event. Inbox keys are `(consumer queue,
event ID)` and work across replicas/restarts.

Relay workers claim pending rows using `FOR UPDATE SKIP LOCKED`, publish with
broker confirmation, then mark them sent. Delivery is at least once: a crash
after confirmation may resend the same event ID. All production queues are
declared/bound before relay starts, including queues whose consumers start late.

A failed handler gets three retries with a one-second delay, then the original
message is retained in `<consumer>.dead`. Invalid JSON/schema goes directly
there. Retry handoffs are confirmed before the original is acknowledged. Broker
connection loss exits the role with a failure code; rendered Compose stacks use
`on-failure` to recreate channels and consumers. Unacknowledged messages stay
with the broker.

Mock payment results are stored by order ID. Replays return the same result;
conflicting amount/mode is rejected. Notifications remain log-based mocks;
real email delivery requires provider-side idempotency.

## REST profiles A05–A08

Order and saga initialization share a transaction. Stages are persisted before
remote calls:

```text
RESERVING -> PAYING -> COMMITTING -> DONE
                  -> COMPENSATING -> FAILED
DONE -> CANCELLING -> CANCELLED
```

A session advisory lock serializes each order across replicas, without an open
SQL transaction during HTTP calls. Inventory operations persist their order ID,
item set and state. Repeated reserve/commit/release calls do not repeat effects.
Release without a reservation records a tombstone blocking a delayed reserve.
Conflicting item sets are rejected.

The recovery loop resumes unfinished stages once per second. Lost responses
and process crashes recover through idempotent replay. Payment decline and the
mock's explicit timeout compensate stock before marking the order failed.
Ambiguous transport failures remain retryable because payment may already have
succeeded. Cancellation retains the benchmark's mock `REFUNDED` status; a real
payment provider needs idempotent refunds and reconciliation.

## Inspection and dead-letter recovery

Inspect the selected run's database, not evaluator metadata:

```sql
SELECT count(*) FROM reliability.outbox WHERE published_at IS NULL;
SELECT stage, count(*) FROM reliability.rest_sagas GROUP BY stage;
SELECT order_id, stage, failure_code, updated_at FROM reliability.rest_sagas
WHERE stage NOT IN ('DONE','FAILED','CANCELLED');
```

Inspect broker `.retry` and `.dead` queues. Fix the failed dependency or producer
before replaying a bounded number of dead letters:

```powershell
$env:RABBITMQ_URL = 'amqp://127.0.0.1:5672'
npm run events:replay-dead -- inventory.order.created 10
```

The helper checks both queues exist, preserves event IDs, resets the retry count
and confirms each handoff before acknowledging its original. Failures retain
unacknowledged originals. Invalid messages return to the dead queue; the helper
does not edit their contents. Use a reachable broker address: isolated benchmark
brokers are normally accessible only inside their Compose network.

## Verification

`tests/integration/reliability.test.ts` tests the production RabbitMQ client,
transactions, payment ledger, inventory operations and REST saga against real
PostgreSQL/RabbitMQ. `service-recovery.test.ts` launches actual service roles,
kills/restarts processes, and exercises REST/event chains over HTTP/AMQP.
`dataset-reset.test.ts` verifies technical state is cleared when restoring an
older snapshot. These are correctness/recovery checks, not capacity benchmarks.
