# Ubuntu capacity benchmark runbook

## Topology

Use two Ubuntu hosts on the same private network:

- **Evaluator/SUT host:** runs the API, worker, Prometheus, cAdvisor, and one isolated SUT deployment at a time.
- **Load host:** runs only k6 over SSH. It must reach the evaluator host's published SUT port range `20000-21000`.

For screening, allocate at least 8 logical CPUs, 16 GiB RAM, SSD storage, and 1 Gbit/s networking to each host. The evaluator still enforces each architecture's declared CPU and memory budget. Dedicated hosts reduce scheduler and network noise; record the exact machines in the study.

## Host preparation

Install Docker Engine with the Compose plugin on the evaluator host. Install k6 `v1.3.0` on the load host so it matches the image build argument. Run the read-only preflight:

```bash
sh scripts/ubuntu-preflight.sh
```

Use a dedicated SSH account on the load host. Create the work directory and verify noninteractive access from the evaluator host:

```bash
sudo install -d -o bench -g bench /opt/architecture-benchmark
mkdir -p infra/deploy/secrets
ssh-keyscan -H 10.0.0.20 > infra/deploy/secrets/known_hosts
chmod 600 infra/deploy/secrets/load-host-ed25519 infra/deploy/secrets/known_hosts
ssh -i infra/deploy/secrets/load-host-ed25519 bench@10.0.0.20 'k6 version && test -w /opt/architecture-benchmark'
```

Restrict the firewall to SSH between the evaluator and load host, the public UI port as needed, and TCP `20000-21000` from the load host to the evaluator host.

For a dedicated benchmark machine, these are useful starting values. Apply them through the host's managed sysctl and limits configuration, then reboot before collecting evidence:

```text
fs.file-max = 1048576
net.core.somaxconn = 65535
net.ipv4.ip_local_port_range = 10240 65535
net.ipv4.tcp_fin_timeout = 15
```

Set `nofile` to at least `65535` for Docker and the benchmark account. Validate changes with the preflight script. Keep CPU frequency policy, kernel, Docker version, network path, and background services fixed for every architecture.

## Deploy with the remote load host

Copy `infra/deploy/deploy.env.example` to an environment file and replace all addresses and image tags. Pin publication images by digest.

```bash
docker compose \
  --env-file infra/deploy/deploy.env \
  -f infra/deploy/compose.yaml \
  -f infra/deploy/ubuntu.compose.yaml \
  -f infra/deploy/load-host.compose.yaml \
  up -d
```

The worker replaces `host.docker.internal` in the SUT URL with `LOAD_HOST_SUT_HOST` before invoking remote k6. SSH host-key checking stays enabled. Full k6 JSON time series are retained through 500 RPS by default; higher loads retain the summary and evaluator evidence to avoid disk and serialization becoming the bottleneck.

## Dataset and campaign flow

The `capacity` dataset uses the same entity counts as `main` and gives every product enough inventory for a 10,000 operation RPS screening run. Generate its immutable snapshot once:

```bash
npm ci
npm run db:sut:seed -- --profile capacity --snapshot
```

Run the capacity protocol to locate saturation regions:

```bash
EVALUATOR_API_URL=http://localhost:8088 npm run experiment:capacity
```

This protocol covers all 12 profiles, four workloads, and ten load levels from 25 to 10,000 operation RPS with one repetition. Treat it as discovery evidence. Use its results to select four to six informative loads, freeze those values in `main-v1.yaml`, then run five randomized repetitions for inferential analysis.

At each point, the evaluator now records:

- offered and achieved operation RPS from k6 iterations;
- HTTP RPS separately, including sampled event-status polling;
- checkout acceptance and stockout rates, plus sampled confirmed and unsettled rates with the sample count;
- load-host CPU, dropped iterations, measurement coverage, correctness, and container health.

`GATE_ACHIEVED_RATE` marks a run below 95% of its offered operation rate as infeasible. Dropped iterations and SUT crashes also remain archived as capacity or stability failures. They cannot by themselves establish that the generator is the cause. `GATE_LOAD_GENERATOR_CPU` invalidates a run when average load-host CPU exceeds 70%; inspect per-core CPU and network utilization separately because this average cannot detect every generator bottleneck.

## Tuning knobs

`K6_EXPECTED_ITERATION_SECONDS` drives initial VU allocation. Start at `0.30`, inspect iteration duration and dropped iterations, then freeze one value for the campaign. `K6_VU_HEADROOM=1.5` and `K6_MAX_VUS_MULTIPLIER=2` leave controlled headroom; `K6_MAX_VUS_CAP=20000` prevents runaway allocation.

Checkout confirmation polling uses a fixed 1% sample across load levels. Freeze `K6_E2E_POLL_SAMPLE_RATE` for the campaign. HTTP 202 means accepted, not confirmed. The confirmation sample includes rejected and unsettled requests; confirmed latency only includes observed confirmations. The primary-operation latency population excludes polling. `raw/load-configuration.json` archives these definitions and the actual VU and polling settings. Use `K6_TIMESERIES_MODE=full` only for short diagnostic runs because full JSON output grows with every metric sample.

The Ubuntu override enables process reaping, a 60-second shutdown grace period, bounded container logs, and 65,535 file descriptors. Run only one evaluator stack per benchmark host: the control network and Prometheus target file are shared. Export all artifacts before upgrading images. Snapshot generation must precede building the runtime image; main and capacity snapshots are runtime inputs. Set `EVALUATOR_API_URL` when submitting from the host to the Docker deployment. Identical protocol submissions use stable idempotency keys and resume existing experiments. Local SQLite submission without that variable is intended for a worker running against that same database.

10,000 RPS is an offered-load ceiling, not a guaranteed capacity claim. Report the highest level that passes latency, errors, achieved rate, correctness, stability, and measurement-validity gates on the documented hardware.

## Publication boundaries

New runs declare measurement schema `2.0.0`. Use a new protocol version after changing measurement definitions; aggregation rejects evidence with mixed schemas. Existing legacy runs remain available as historical evidence.

The current workload selects 50 active product IDs and 20 customer IDs from the restored database; flash sale uses the first 20 selected products. The full dataset size does not imply uniformly distributed access to every entity. Document this hotspot population and the polling sample rate. Resource coverage currently checks sampled container stats and availability of Prometheus/application metrics; it does not establish complete time-series coverage for every service. The current runner randomizes architecture submission order within workload blocks, not the order of every repetition. Record actual run timestamps and use a counterbalanced schedule before claiming that temporal effects have been controlled.

Capacity inventory is deliberately abundant. A stockout study requires a separate frozen inventory profile. Set the main protocol's datasetProfile to capacity when studying successful checkout capacity, and regenerate the main snapshot only for a deliberately different study. Do not silently refill inventory during measured runs. Cost and score catalogs marked development/research are exploratory; main protocol submission remains blocked until they are replaced with frozen study inputs.
