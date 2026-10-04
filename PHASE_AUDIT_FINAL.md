# Final 10-phase audit

**Date:** 2026-10-03
**Reference:** `../AGENT_IMPLEMENTATION_GUIDE.md` sections 32–35
**Conclusion:** All ten phases have deployable implementation. Phase 10's full
research campaign remains intentionally unexecuted until real pilot/catalog/host
inputs are frozen; no synthetic result is presented as publication evidence.

## Acceptance evidence

| Area | Result |
|---|---|
| Backend typecheck | PASS |
| Backend lint | PASS after final run |
| Backend unit | 52/52 PASS |
| Backend contract | 18/18 PASS |
| Registry | A01–A12 PASS |
| Pilot/main plan validation | 48 randomized jobs each PASS |
| Frontend Playwright | 4/4 PASS, including architecture-card stress test |
| Real Docker smoke | A01 and A10 completed; A10 INV-01…INV-07 PASS |
| Metric validity smoke | 100% coverage, zero dropped iterations |
| Full Docker suite | Previously 138/138 PASS; final re-run blocked by stopped Docker engine |

## Audit decisions

- AI output cannot supply Docker/Compose/shell input. It supplies candidate data;
  the validator maps it to immutable A01–A12 registry profiles.
- Users can bypass AI entirely: clicking any architecture queues the same validated
  evaluator pipeline through `POST /architectures/:id/experiments`.
- Official cost, gates, scores, CI, Pareto and regret are calculated only by the
  backend. The frontend renders returned evidence.
- The API has no Docker socket. The worker is the explicit trusted orchestration
  boundary; generated SUT application containers drop capabilities, use a read-only
  filesystem and an internal Compose network.
- Missing datasets and unfrozen main inputs fail before work is queued.

## Non-code conditions before publication

1. Start Docker on the final Linux host and run `npm run test:integration` plus A01/A10 smoke.
2. Run pilot, calibrate, and freeze 4–6 loads plus versioned score bounds.
3. Install a dated regional cost catalog and immutable backend/frontend/SUT digests.
4. Generate the main snapshot, execute all five repetitions and archive the aggregate report.

See `IMPLEMENTATION_STATUS.md`, `PHASE_CHECKLIST.md`, `docs/deployment.md` and
`docs/phase10-protocol.md` for exact evidence and commands.
