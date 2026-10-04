# Deployment runbook

This is a Linux Docker Engine deployment. It starts the controller API, isolated
experiment worker, React/nginx UI, Prometheus and cAdvisor. The API container does
not receive the Docker socket. Only the trusted worker receives it because it must
create and remove per-run SUT stacks.

## 1. Verify both repositories

```bash
cd architecture-evaluation-backend
npm ci
npm run lint && npm run typecheck && npm run build
npm run test:unit && npm run test:contract && npm run registry:validate

cd ../architecture-evaluation-frontend
npm ci
npm run lint && npm run test && npm run build && npm run test:e2e
```

Run backend integration tests on a machine where Docker is active:

```bash
cd ../architecture-evaluation-backend
npm run test:integration
```

## 2. Install deterministic datasets before building the backend image

The checked-in pilot snapshot is immediately usable. A main campaign requires a
main snapshot produced from the fixed seed; the API deliberately refuses to queue
`datasetProfile=main` until both dump and manifest exist.

```bash
docker compose -f infra/dev/postgres.compose.yaml up -d --wait
npm run db:sut:seed -- --profile main --seed 20261001 --snapshot
docker compose -f infra/dev/postgres.compose.yaml down -v
```

The snapshot is baked into the backend/SUT image. Rebuild the image after creating
or changing a snapshot, catalog, score bounds or protocol input.

## 3. Build and pin images

```bash
docker build -t architecture-evaluation-backend:0.1.0 .
docker build -t architecture-evaluation-frontend:0.1.0 ../architecture-evaluation-frontend
docker image inspect architecture-evaluation-backend:0.1.0 --format '{{index .RepoDigests 0}}'
docker image inspect architecture-evaluation-frontend:0.1.0 --format '{{index .RepoDigests 0}}'
cp infra/deploy/deploy.env.example infra/deploy/deploy.env
```

For a publication campaign, set `BACKEND_IMAGE`, `SUT_IMAGE`, and
`FRONTEND_IMAGE` in `deploy.env` to immutable registry digests. `SUT_IMAGE` is
the image used for every generated architecture role.

## 4. Start and verify

```bash
docker compose --env-file infra/deploy/deploy.env -f infra/deploy/compose.yaml up -d
docker compose --env-file infra/deploy/deploy.env -f infra/deploy/compose.yaml ps
curl -fsS http://localhost:8088/api/v1/health
curl -fsS http://localhost:8088/api/v1/ready
```

Open `http://localhost:8088/architectures`, choose any A01–A12 card, click
**Stress test**, freeze the workload/SLO/protocol fields, and queue it. The detail
page receives state transitions and metric snapshots by SSE and falls back to
polling if the stream disconnects.

## 5. Operations and security

- Put TLS and authentication in front of port 8088 before exposing it outside a
  private admin network. The evaluator intentionally has no end-user auth.
- Restrict SSH and firewall access. Per-run SUT ports are temporary and bind on
  the Docker host so Prometheus/load generation can reach them.
- Treat the worker as privileged infrastructure: Docker socket access is
  effectively host-root. Do not run untrusted candidates; candidates select only
  registry profiles and never provide Compose, image or shell input.
- Back up the `evaluator-data` and `evaluator-results` volumes. Raw run evidence
  includes SHA-256 manifests and is needed for deterministic report rebuilds.
- `docker compose ... down` preserves named data volumes. Use `down -v` only when
  intentionally deleting evaluator metadata, evidence and Prometheus history.

## 6. Rollback

Set the three image variables in `deploy.env` back to their previous digests and
run `docker compose ... up -d`. Database migrations are additive. Preserve a
volume backup before upgrading.
