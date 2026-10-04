# Stability validation — 2026-10-03

## Checks completed

- Unit/contract/golden suites: 143 tests passed.
- Integration suites: 60 tests passed.
- ESLint, script/source typecheck, Docker image build: passed.
- All 12 registry profiles validated.
- All four k6 workloads parsed successfully with the runtime image's k6.
- Base + Ubuntu + SSH load-host Compose configuration validated.
- Ubuntu preflight shell syntax checked under Linux; an actual Ubuntu host preflight is still required.
- Local UI at http://localhost:4188 returned HTTP 200; API reported ready.

## Real short regression runs

Both used CHECKOUT_V1, pilot inventory, 25 offered operations/s, one second of warm-up and 20 seconds of measurement. These are functional regression evidence, not publication measurements.

| Profile | Experiment | Completed operations/s | HTTP failure fraction | Dropped iterations | Gates |
| --- | --- | ---: | ---: | ---: | --- |
| A01 | df7f2366-3763-49c0-b661-769cebeb44e6 | 25.0425 | 0 | 0 | all passed |
| A10 | 82c0f0a6-8699-4e47-889c-253f2a0684cb | 10.7254 | 0.57317 | 100 | latency, error, dropped iterations and achieved rate failed |

The A10 logs recorded order-service connection-pool acquisition timeouts. This does not establish the underlying bottleneck or Ubuntu capacity. Failed capacity evidence remains COMPLETED with infeasible gates, rather than being retried away. Raw evidence was copied to `results/stability-regression/` and remains in the Docker results volume. Confirmation samples (3 for A01, 1 for A10) are too small for inference.

## Packaged capacity input

The generated immutable snapshot contains 50,000 users, 20,000 products, 20,000 inventory rows, 200,000 orders and 600,000 order items. Its generated and restored-database checksums matched during snapshot creation. SHA-256 was checked again inside the deployed worker:

`18d51f8532de8ff34e3b4049db727b93e7ab45b6dd63392fa672440c16070331`

File: `database/snapshots/capacity-20261001.dump`, 45,643,430 bytes. The dump is ignored by Git; archive or regenerate it before deployment from a clean checkout. The runtime image includes it.

Latest local image: `architecture-evaluation-backend:stability-20261003`, image manifest digest `sha256:1aba55712105a3503a7fd35227576e9f3a41b5a8e45705aae1600fde37997ce3`. The local deployment was updated after the regression runs to include measurement schema 2.0.0, bounded SUT logs and the capacity snapshot. Historical regression artifacts retain their original configuration.

## Pending target-host evidence

No Ubuntu SSH host was provided and no 10,000 operations/s campaign was executed. Follow `ubuntu-capacity.md`, perform target-host preflight, inspect generator headroom and collect repeated measurements before making publication claims. The runner executes the registered 12 profiles; arbitrary AI-produced architectures remain outside that executable scope.
