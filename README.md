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
hardware. The evaluator supports 52 registered profiles (A01–A52): 13 executable
topologies with four Redis modes each (none, product, cart, product + cart).

## Ask another AI for a runnable architecture

For bulk model/prompt testing, see the [Vietnamese AI batch runbook](docs/ai-batch.vi.md).
`npm run ai:batch -- prepare` exports 12 frozen prompts and a 108-generation plan
for OpenAI, Claude and Gemini; the runner validates responses, resumes generation,
submits valid selections idempotently, and exports generation/run CSV evidence.

Open `/architectures` in the UI and download **AI prompt** and **JSON schema**.
Replace the requirements placeholder in the prompt, send it to your AI, then paste
the returned candidate JSON into a new experiment. The runtime API
`GET /api/v1/architectures/ai-contract` generates the contract from the registry.
For local files, run `npm run registry:export-ai`; see [the Vietnamese prompt](docs/ai-contract/prompt.vi.txt).

A13–A16 add a PostgreSQL job queue, durable mock payments, shared PostgreSQL carts,
one/two API replicas and one/two workers. A15/A16 cache products in Redis.
The validator rejects mismatched roles, messaging, cache targets and unsupported
TTL values before executing. These are fixed benchmark topologies: accepting a
candidate does not guarantee a workload's latency SLO or support arbitrary designs.
See [supported architecture guide](docs/supported-architectures.md) for the Vietnamese workflow and queue semantics.
See the [complete matrix](docs/architecture-matrix.md) for each Redis variant and
the [AI response schema](docs/ai-contract/ai-selection.schema.json) for supported
candidates or explicit unsupported-requirement errors. Existing pilot/main/capacity
protocols retain their original 12-profile cohort; supply the desired architecture
IDs in a separate protocol for a new study. The registry smoke script runs all
currently registered profiles by default.

See the [full catalog audit (06/10/2026)](docs/architecture-audit-20261006.md)
for deployment checks, payment/idempotency fixes, runtime evidence and research limits.
The [16/10/2026 runtime verification](docs/architecture-runtime-verification-20261016.md)
confirms all 52 profiles have a completed smoke with seven passing business invariants
and zero HTTP errors; original invalid measurements and all rechecks remain archived.
See the [runtime measurement fixes](docs/architecture-runtime-fixes-20261016.md)
for the versioned 5s resource sampler, timing validity, pagination correction and post-fix regression evidence.
Smoke completion does not establish production SLO or capacity.
All monolith profiles now share durable mock payment state through PostgreSQL.

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
`notification-mock`, `event-worker`, `pg-queue-worker`. `src/main.ts` dispatches on `APP_ROLE`; an
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

On Windows, with Docker Desktop running and both repositories checked out as
siblings, run `./scripts/start-local.ps1`. It creates local `deploy.env` defaults
if missing, builds both images and starts the stack at `http://localhost:8088`.
Use `-SkipBuild` when the configured images are already available.

The production Compose topology keeps the controller API away from the Docker
socket and gives orchestration access only to the worker. Build both independent
repositories, copy `infra/deploy/deploy.env.example`, and start
`infra/deploy/compose.yaml`. See [`docs/deployment.md`](docs/deployment.md) for the
fresh-machine runbook, dataset preparation, digest pinning, health checks,
security boundary, backup and rollback.

After deployment, open `/architectures`. Every supported registry card has a
**Stress test** action. It creates a candidate from the immutable registry on the
backend, validates it through the same schema/semantic path, then runs the normal
worker pipeline. AI-generated Candidate JSON remains available from
`/experiments/new`; it is not required for direct architecture testing.

## Backend-only Docker smoke test (all supported profiles)

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

The helper queues one 1 RPS `MIXED_V1` pilot experiment for every immutable
supported registry profile and waits for all results. Its 10-second warm-up and
120-second measurement window verify deployability and execution only; they are
not valid performance evidence. Use the frozen pilot/main protocols for
statistical comparison.
The all-profile wait defaults to four hours. Short 10–20 second windows can fail
the unchanged 95% resource-sample coverage gate on Docker Desktop; retain those
invalid attempts and recheck with a longer window instead of relaxing the gate.

Rebuild a report deterministically from one archived run:

```bash
npm run report:rebuild -- results/<experiment-id>/<run-id>
```
