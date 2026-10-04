# Phase 10 experiment protocol

`protocols/pilot-v1.yaml` and `protocols/main-v1.yaml` are seeded protocol inputs.
Copy/version a protocol rather than editing one that has already produced evidence.
Validate them without creating jobs with:

```bash
npm run experiment:pilot -- --dry-run
npm run experiment:main -- --dry-run
```

The runner randomizes architecture order inside each workload block with seed
`20261001`. Pilot uses three repetitions; main uses five. Every run restores the
selected frozen snapshot, executes warm-up/measurement/cooldown, runs the oracle,
stores raw evidence and checksums, and cleans the exact Compose project.

## End-to-end campaign

```bash
# 1. Verify the randomized 48-job plans without queueing.
npm run experiment:pilot -- --dry-run
npm run experiment:main -- --dry-run

# 2. Queue pilot and let the worker finish every run.
npm run experiment:pilot

# 3. Derive p5/p95 bounds and recommended 4–6 load levels from pilot evidence.
npm run experiment:calibrate

# 4. Add a dated regional catalog under cost-catalogs/, copy the generated bounds
#    to a versioned score-bounds file, and freeze both names + loads in a new main protocol.

# 5. Install the main snapshot, rebuild/pin the image, then queue main.
npm run db:sut:seed -- --profile main --seed 20261001 --snapshot
npm run experiment:main

# 6. After all jobs finish, produce CI/Pareto/model metrics/limitations.
npm run experiment:aggregate
```

Before a publication run, replace `research-v1` with a dated regional catalog,
replace `development-v1` with a versioned 5th/95th-percentile bounds catalog
derived from pilot evidence, and freeze 4–6 load levels from that evidence. The
runner refuses a non-dry-run `main-*` protocol while these development inputs
remain and refuses any non-dry run whose dataset snapshot is absent. Do not treat
the development catalog or a single-host synthetic benchmark as production
cost/performance truth. Infrastructure-invalid runs may be retried at most once;
business/correctness failures are not retried or removed as outliers.

The main protocol is intentionally not claimed as executed merely because its
automation exists. A default 48-group × 5-load × 5-repeat campaign at 13 minutes
per run takes roughly 520 hours before retry and orchestration overhead. Archive
the SQLite database, `results/`, exact image digests, protocol, catalogs, bounds,
host inventory and the aggregate report together.
