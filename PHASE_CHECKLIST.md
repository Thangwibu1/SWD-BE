# Phase and system DoD checklist

Verified against `AGENT_IMPLEMENTATION_GUIDE.md` on 2026-10-03.

| Phase | Implementation | Automated evidence | Operational evidence |
|---|---|---|---|
| 0 Bootstrap | Complete | lint/typecheck/build/CI | images build |
| 1 Data/contract | Complete | contract + checksum tests | pilot snapshot restore |
| 2 A01/A02 | Complete | unit/integration | A01 smoke |
| 3 A03/A04 | Complete | parity/cache tests | registry/render validation |
| 4 A05–A08 | Complete | API parity | registry/render validation |
| 5 A09–A12 | Complete | event failure tests | A10 smoke, 7/7 invariants |
| 6 Evaluator core | Complete | unit/contract/lease tests | A01/A10 end-to-end |
| 7 Measurement | Complete | parser/validity tests | k6/Prom evidence captured |
| 8 Engines | Complete | golden tests | deterministic report rebuild |
| 9 React UI | Complete | unit + 4/4 Playwright | direct architecture workflow |
| 10 Pilot/main | Runtime complete | both 48-job dry runs | full campaign pending real inputs/time |

## Definition of Done

- [x] Two independent repositories; no workspace/monorepo.
- [x] React UI builds and deploys.
- [x] Express API and worker run as separate processes.
- [x] Five-table migration plus deterministic seed/snapshot/reset.
- [x] The same 15 SUT endpoints across three architecture families.
- [x] Twelve registry profiles validate and render.
- [x] Candidate JSON Schema and semantic validator.
- [x] Invalid candidate or missing snapshot cannot start/queue a run.
- [x] One SUT stack at a time within registry 2-vCPU/4-GiB budgets.
- [x] k6 constant-arrival-rate and invalid-generator gates.
- [x] Prometheus/cAdvisor/app metrics and >=95% coverage gate.
- [x] INV-01…INV-07 automated.
- [x] Cost, gates, score, Pareto and regret golden tests.
- [x] Raw artifacts and SHA-256 manifest.
- [x] Cleanup for success/fail/cancel/restart.
- [x] Dashboard, New Experiment, Detail, Comparison, Architectures, Settings.
- [x] UI shows raw metrics, CI, gates and trade-offs.
- [x] SSE reconnect and polling fallback.
- [x] Backend/frontend unit, contract and E2E suites pass.
- [x] Main protocol supports exactly five repetitions and guarded frozen inputs.
- [x] Fresh-machine deployment runbook for both repositories.

## Publication evidence still to execute

- [ ] Run pilot on the final controller/load/observation hosts.
- [ ] Freeze 4–6 loads and versioned p5/p95 bounds from that pilot.
- [ ] Supply a dated regional cost catalog and immutable image digests.
- [ ] Generate/install `main-20261001` snapshot.
- [ ] Execute the roughly 520-hour main matrix and archive data/report.

Unchecked items are real research execution, not application implementation.
