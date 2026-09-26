# Implementation plan

Source of truth for scope: `docs/plan-local-first.md` (local-first, no deployment).

## Done
- v1.0.1 — notebooks (`.ipynb`): fidelity codec, target config, Entra auth,
  Lakehouse attach/detach panel, Livy execution with session reuse.

## Next (one per session, in order)
1. M0.1 — API write-allowlist + `LocalFirstViolationError` + confirmation-gated Lakehouse create + tests.
2. M0.2 — `Fabric: Connect to Compute` (capacity → workspace → host Lakehouse), status bar.
3. M0.3 — Create Lakehouse on demand, behind a modal confirm (D3).
4. M0.4 — Livy host precedence (notebook default Lakehouse vs compute profile).

Remaining milestones M1–M5: see `docs/plan-local-first.md`.

## Open issues
- None. Decisions D1–D4 are recorded in `docs/plan-local-first.md`.
