# architecture-evaluation-backend

Evaluator API, experiment worker and e-commerce SUT roles for the AI Architecture
Evaluation System. One `package.json`, one Docker image; the process role is chosen
at runtime with `APP_ROLE`.

## Ubuntu and research capacity runs

See [Ubuntu capacity runbook](docs/ubuntu-capacity.md) for a dedicated SSH load
host, bounded logs, frozen measurement settings, and the discovery protocol up
to 10,000 operations/second. Submit to a Docker deployment with
`EVALUATOR_API_URL=http://localhost:8088 npm run experiment:capacity` after
generating and packaging the capacity snapshot. This queues discovery runs;
publication runs require frozen catalogs, repeated measurements and documented
hardware. The evaluator currently executes the 12 registered profiles.

## Requirements

For durable outbox/inbox processing, REST saga recovery and dead-letter replay,
see [reliability runbook](docs/reliability.md).

- Node.js 22.19.0 (see `versions.env`)
- Docker Engine + Docker Compose plugin
- k6 (local load-runner mode)

## Local development

```bash
cp .env.example .env
npm ci
npm run lint
npm run build
npm run test
npm run dev:api        # http://localhost:4000/api/v1/health
npm run dev:worker     # second terminal (Phase 6+)
```

## SUT database (5 tables)

```bash
set -a; . ./versions.env; set +a
docker compose -f infra/dev/postgres.compose.yaml up -d --wait   # 127.0.0.1:25432
npm run db:sut:seed -- --profile pilot --snapshot   # migrate + seed 20261001 + checksum + pg_dump
npm run db:sut:reset                                # restore snapshot + verify checksum
```

- Seed is deterministic (default `20261001`, Zipf product popularity). The checksum
  is written to `database/seed/<profile>-<seed>.checksum.json`; snapshots and their
  manifests (sha256, size, dataset checksum) go to `database/snapshots/`.
- `pg_dump`/`pg_restore` run inside the postgres container via `docker exec`, so
  the host needs no PostgreSQL client. Reset refuses a tampered dump (sha256) and
  fails if the restored data checksum differs from the snapshot.
- `db:sut:migrate` only runs on an empty database; there is no migration table so
  the SUT keeps exactly five business tables.
- Windows note: ports 55381–55480 are often reserved by Hyper-V, so the dev port is 25432
  (override with `DEV_POSTGRES_PORT`).

## Contracts

`schemas/sut-openapi.json` (OpenAPI 3.1) defines the 15 SUT endpoints, the error
envelope `{code,message,details,requestId}` and required headers (`X-Request-Id`,
`Idempotency-Key` on `POST /orders`). `npm run test:contract` checks it against
`src/sut/shared/contracts/routes.ts` and compiles every schema with Ajv strict mode.

## Roles

`controller-api`, `experiment-worker`, `sut-monolith`, `api-gateway`, `user-service`,
`catalog-service`, `inventory-service`, `order-service`, `payment-mock`,
`notification-mock`, `event-worker`. `src/main.ts` dispatches on `APP_ROLE`; an
unregistered role exits with code 1.

## Docker image

```bash
set -a; . ./versions.env; set +a
docker build --build-arg NODE_IMAGE="$NODE_IMAGE" -t architecture-evaluation-backend:0.1.0 .
docker run --rm -e APP_ROLE=controller-api -e API_HOST=0.0.0.0 -p 4000:4000 \
  architecture-evaluation-backend:0.1.0
```

The image runs as non-root user `node`. `better-sqlite3` is compiled against the
headers bundled in the Node image (`npm_config_nodedir=/usr/local`), so the build
does not download headers from `unofficial-builds.nodejs.org`.

Image digest: before the main experiment, set `BACKEND_IMAGE_DIGEST` in
`versions.env` to the immutable `repo@sha256:...` reference.

## Versions

All image/tool versions are pinned in `versions.env`. Never use `latest`.

## Smoke and frozen experiment protocols

```bash
docker build -t architecture-evaluation-backend:0.1.0 .
npm run experiment:smoke -- A01
npm run experiment:smoke -- A10
npm run experiment:pilot -- --dry-run
npm run experiment:main -- --dry-run
```

Remove `--dry-run` to enqueue the seeded, randomized protocol in the evaluator
database. Pilot uses three repetitions; main uses five. Before a publication run,
freeze load levels from pilot evidence, use an immutable backend image digest, and
replace the development cost catalog with a dated regional catalog. See
`docs/phase10-protocol.md`.

## Deploy the complete UI + evaluator

The production Compose topology keeps the controller API away from the Docker
socket and gives orchestration access only to the worker. Build both independent
repositories, copy `infra/deploy/deploy.env.example`, and start
`infra/deploy/compose.yaml`. See [`docs/deployment.md`](docs/deployment.md) for the
fresh-machine runbook, dataset preparation, digest pinning, health checks,
security boundary, backup and rollback.

After deployment, open `/architectures`. Every registry card A01–A12 has a
**Stress test** action. It creates a candidate from the immutable registry on the
backend, validates it through the same schema/semantic path, then runs the normal
worker pipeline. AI-generated Candidate JSON remains available from
`/experiments/new`; it is not required for direct architecture testing.

## Backend-only Docker smoke test (A01-A12)

Build the backend image, then start only the API, experiment worker and
observation services. The override publishes the API on loopback port 4100 by
default (configurable with `BACKEND_PORT`);
the frontend service is not started and no credentials or local `.env` file
are required.

```powershell
docker build -t architecture-evaluation-backend:0.1.0 .
docker compose --env-file infra/deploy/backend-local.env.example `
  -f infra/deploy/compose.yaml `
  -f infra/deploy/backend-only.compose.yaml `
  up -d backend worker prometheus cadvisor

Invoke-RestMethod http://localhost:4100/api/v1/ready
./scripts/smoke-all-architectures.ps1
```

The helper queues one short, 1 RPS `MIXED_V1` pilot experiment for every immutable
registry profile A01-A12 and waits for all results. Its 1-second warm-up and
10-second measurement window verify deployability and execution only; they are
not valid performance evidence. Use the frozen pilot/main protocols for
statistical comparison.

Rebuild a report deterministically from one archived run:

```bash
npm run report:rebuild -- results/<experiment-id>/<run-id>
```
