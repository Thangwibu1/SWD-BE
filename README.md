# architecture-evaluation-backend

Evaluator API, experiment worker and e-commerce SUT roles for the AI Architecture
Evaluation System. One `package.json`, one Docker image; the process role is chosen
at runtime with `APP_ROLE`.

## Requirements

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
