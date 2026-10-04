# IMPLEMENTATION_STATUS — architecture-evaluation-backend

Last verified: 2026-10-03. Reference: `../AGENT_IMPLEMENTATION_GUIDE.md`.

The implementation for Phases 0–10 is present. Phase 10's automation is complete,
but a publication-scale main campaign is an external execution deliverable and has
not been fabricated or marked as run. It requires pilot-derived frozen inputs, a
dated regional cost catalog, a generated main snapshot and roughly 520 hours for
the default matrix.

## Phase 0 — Bootstrap

### Implemented
- Independent backend/frontend repositories, strict TypeScript, pinned runtime and
  images, lint/test/build scripts, CI and production Dockerfiles.

### Files changed
- `package.json`, `Dockerfile`, `.github/workflows/ci.yml`, `.env.example`,
  `versions.env`, and the corresponding frontend files.

### Verification
- Backend lint/typecheck/build and frontend lint/test/build pass.

### Remaining blockers
- None in code.

## Phase 1 — Data and contract

### Implemented
- Exactly five SUT business tables; deterministic pilot/main generators;
  checksum, snapshot, restore and reset; SUT/evaluator OpenAPI; request IDs and
  stable error envelopes.
- Experiment requests select `pilot` or `main`; missing snapshots fail before a
  candidate or run is queued.

### Files changed
- `database/`, `schemas/`, `src/sut/shared/database/`, API middleware/controllers.

### Verification
- Contract tests pass; the checked-in pilot snapshot restores and verifies by
  SHA-256 and logical dataset checksum during real smoke runs.

### Remaining blockers
- Generate `main-20261001.dump` before a main campaign.

## Phase 2 — A01/A02

### Implemented
- Modular monolith roles, PostgreSQL transactions, Redis cache/cart, idempotent
  order creation and INV-01…INV-07 oracle coverage.

### Files changed
- `src/sut/monolith/`, shared HTTP/database code and monolith templates.

### Verification
- Unit/contract/integration coverage and real A01 Docker smoke completed.

### Remaining blockers
- None.

## Phase 3 — A03/A04

### Implemented
- Stateless replicas, proxy-compatible routing, shared state, cache correctness
  and asynchronous notification behavior.

### Files changed
- Registry A03/A04, compose templates and SUT bootstrap modules.

### Verification
- Registry validation, parity/integration tests and deterministic compose render.

### Remaining blockers
- None.

## Phase 4 — A05–A08

### Implemented
- REST gateway/services, propagated request IDs, timeouts/error envelopes and
  catalog/order scaling variants with the same 15-endpoint contract.

### Files changed
- `src/sut/gateway/`, `src/sut/services/`, REST templates and registry profiles.

### Verification
- API parity integration suite and all 12 registry profiles validate.

### Remaining blockers
- None.

## Phase 5 — A09–A12

### Implemented
- RabbitMQ publisher confirms, manual ack, durable messages, consumer idempotency,
  deterministic payment reference, redelivery and compensation/replay.
- `order.created` is published only after database commit; pending sagas can be
  replayed without duplicate stock or payment effects.

### Files changed
- `src/sut/shared/events/`, `src/sut/shared/messaging/`, event services/templates,
  event JSON schemas and event integration tests.

### Verification
- Duplicate/redelivery/failure tests pass. Real A10 Docker smoke passed all
  INV-01…INV-07 after the transaction/event race fix.

### Remaining blockers
- None.

## Phase 6 — Evaluator core

### Implemented
- SQLite metadata/migrations, two-layer validator, immutable registry, worker state
  machine, leases/heartbeats, idempotent API, dynamic ports, exact Compose cleanup,
  cancellation, crash recovery and one infrastructure-only retry.
- Controller and worker are separate processes. Production API has no Docker socket.
- Direct `POST /architectures/:id/experiments` path enables testing any A01–A12
  without an AI prompt.

### Files changed
- `src/metadata/`, `src/evaluator/`, `src/worker/`, evaluator API/routes and deploy compose.

### Verification
- Contract and lease tests pass; A01/A10 real smoke experiments reached terminal
  states and cleaned their exact Compose projects.

### Remaining blockers
- None.

## Phase 7 — Measurement

### Implemented
- Four k6 constant-arrival-rate workloads, five-way error breakdown, local/SSH
  runner, generator CPU guard, duration/sample/coverage validity gates,
  Prometheus file discovery, app metrics and cAdvisor/container evidence.
- Raw k6, Prometheus, app, container, logs and environment evidence are archived.

### Files changed
- `workloads/k6/`, load runner, metrics collector, observation compose/config.

### Verification
- Measurement parser/unit tests pass; real smoke saved Prometheus evidence and
  reported 100% metric coverage with zero dropped iterations at its smoke load.

### Remaining blockers
- Publication pilot loads must be calibrated on the target hosts.

## Phase 8 — Evaluation engines

### Implemented
- INV-01…INV-07 oracle, Decimal cost engine, hard/measurement-validity gates,
  p5/p95 scoring, confidence intervals, Pareto, regret, sensitivity and
  deterministic HTML/JSON/CSV report plus SHA-256 artifact manifest.

### Files changed
- Oracle/cost/score/statistics/report modules and evaluator golden tests.

### Verification
- Golden/unit tests pass; archived reports rebuild deterministically.

### Remaining blockers
- Publication conclusions require dated prices and completed evidence.

## Phase 9 — React UI

### Implemented
- Dashboard, seven-step New Experiment, Experiments, eight-tab Detail, Comparison,
  Architectures and Settings pages; SSE reconnect with polling fallback; cancel
  confirmation; checksummed artifact links.
- Every architecture card has a Stress test action and uses the direct backend path.
  Official cost/scores remain backend-owned.

### Files changed
- Independent `architecture-evaluation-frontend` application and E2E tests.

### Verification
- Frontend unit tests and 4/4 Playwright tests pass, including direct A01 queueing.

### Remaining blockers
- None.

## Phase 10 — Pilot and main experiment

### Implemented
- Seeded block-randomized 48-job pilot/main protocols, three/five repetitions,
  frozen-input persistence, retry policy, pilot calibration, main preflight and
  aggregate CI/Pareto/regret/model-metrics/limitations report.
- Main non-dry-run is blocked until 4–6 pilot-derived loads, a non-development
  bounds version, a dated non-research catalog and the main snapshot are installed.

### Files changed
- `protocols/`, `scripts/run-protocol.ts`, `scripts/calibrate-pilot.ts`,
  `scripts/aggregate-protocol.ts`, `docs/phase10-protocol.md`.

### Verification
- Both protocol dry runs validate 48 randomized jobs; pilot snapshot is present.

### Remaining blockers
- Execute pilot on the deployment hosts, freeze its outputs, provide the real
  regional catalog, generate the main snapshot, run the long main campaign and
  archive its evidence. These are experiment operations, not missing runtime code.

## Current verification snapshot

- Backend: typecheck PASS; lint PASS after final re-run; unit 52/52; contract 18/18;
  registry 12/12; protocol dry-runs PASS.
- Frontend: Playwright 4/4; unit/lint/build PASS after final re-run.
- Docker integration was last fully verified at 138/138 and real A01/A10 smoke runs
  completed. Docker Desktop was unavailable during the final 2026-10-03 re-check,
  so the final static change set could not be re-run against a live engine.
