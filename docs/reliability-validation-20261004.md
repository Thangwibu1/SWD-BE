# Reliability implementation validation — 2026-10-04

## Changes

- Transactional outbox for order creation, event handler output and user cancellation.
- Durable inbox claims in the same transaction as handler effects, scoped by consumer/event ID.
- Savepoints for nested domain transactions and partial-reservation rollback.
- Three delayed retries, confirmed retry/dead-letter handoffs, invalid-message isolation and bounded manual replay.
- Durable payment mock ledger and idempotent reserve/commit/release state.
- Persisted REST checkout/cancellation sagas, automatic recovery and per-order locks across replicas.
- Known payment failures compensate inventory; ambiguous HTTP failures retain a retryable stage.
- Late order events cannot resurrect terminal orders. Compensation payloads conform to their event schema.
- Technical state resets with business snapshots; existing five-table datasets remain compatible.
- Payment/notification dependencies and application restart behavior wired into the SUT templates/renderer.

## Completed checks

| Check | Result |
| --- | --- |
| Source/script/test typecheck | Passed |
| ESLint | Passed |
| TypeScript production build | Passed |
| Unit, contract, golden suites | 83 tests passed across 11 files |
| Full integration suite | 74 tests passed across 8 files |
| Expanded reliability + actual service regression suites | 15 tests passed across 2 files after additional cancellation/payment-outage coverage |
| A01–A12 registry/schema/resource validation | Passed |
| A01–A12 rendered Docker Compose configuration | Passed |
| Docker runtime image build | Passed |
| Git whitespace check | Passed |

The final integration cases total 75: the 60 existing cases plus 15 new
reliability/service cases. The targeted final run covers the latest transport
error mapping, late-event guard, cancellation event and additional fault cases.

New tests use actual PostgreSQL and RabbitMQ containers. Production service
roles run as independent Node processes and communicate over HTTP/AMQP. Tests
kill and recreate order/inventory/payment roles, check compensation after
decline/timeout, replay lost reserve/commit/release responses, verify durable
payment/event deduplication, roll back partial multi-item reservations, and
recover messages from dead-letter storage.

## Build artifact

Local image: `architecture-evaluation-backend:reliability-20261004`.

Manifest-list digest:
`sha256:e948f54d7c875a545cfb2b0b9291249cd2ab70b91b05bc3b5e324f06aac8ddec`.

Rendered configuration evidence is under
`results/reliability-validation-20261004/A01` through `A12`.

## Scope

No target-host capacity campaign, publication benchmark or deployment to an
existing environment was performed. The Docker image is built locally. Fresh
benchmark measurements must use a frozen image and cannot be combined with
historical A05–A12 measurements from an earlier implementation. Real financial
refunds and email delivery remain outside the mock SUT contract. Operational
inspection and replay instructions are in `docs/reliability.md`.
