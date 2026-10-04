# ADR 001: Direct architecture stress-test endpoint

## Status

Accepted — 2026-10-02.

## Context

The original API requires a caller-supplied Architecture Candidate JSON. Users also
need to select any immutable A01–A12 registry profile and run a stress test without
first invoking an AI provider.

## Decision

Add `POST /api/v1/architectures/:id/experiments`. The backend, not the browser,
constructs a schema-valid candidate from the selected immutable registry profile,
validates it through the same Ajv/semantic validator, freezes catalog and score-bound
versions, and creates the normal asynchronous experiment. The endpoint requires an
`Idempotency-Key` and accepts only workload/SLO/load/duration/repetition options.

## Consequences

Direct runs and AI/manual candidates use exactly the same worker, measurement,
oracle, gate, scoring, artifact and cleanup pipeline. The endpoint cannot modify
images, roles, Compose, CPU or memory.
