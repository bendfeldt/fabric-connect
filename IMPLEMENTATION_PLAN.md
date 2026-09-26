# Implementation plan

Source of truth for scope: `docs/plan-local-first.md` (local-first, no deployment).

## Done

- v1.0.1 — notebooks (`.ipynb`): fidelity codec, target config, Entra auth,
  Lakehouse attach/detach panel, Livy execution with session reuse.
- M0.1 — local-first write allowlist (`src/core/writePolicy.ts`), enforced in
  `FabricApiClient` before auth/network; `LocalFirstViolationError`;
  single-use, workspace+name-bound `UserConfirmation` for Lakehouse create
  (minting restricted to `src/vscode/` by test). Tests: `test/writePolicy.test.ts`.

## Next (one per session, in order)

1. M0.2 — `Fabric: Connect to Compute` (capacity → workspace → host Lakehouse), status bar.
2. M0.3 — Create Lakehouse on demand, behind a modal confirm (D3).
3. M0.4 — Livy host precedence (notebook default Lakehouse vs compute profile).

Remaining milestones M1–M5: see `docs/plan-local-first.md`.

## Open issues

- Decisions D1–D4 are recorded in `docs/plan-local-first.md`.
- Livy batches and OneLake scratch writes are not yet on the allowlist; add
  them (with tests) in the milestones that need them (M2).
- Nothing mints a `UserConfirmation` yet; M0.3 adds the modal that does.
