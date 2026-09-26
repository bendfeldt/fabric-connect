# Implementation plan

Source of truth for scope: `docs/plan-local-first.md` (local-first, no deployment).

## Done

- v1.0.1 — notebooks (`.ipynb`): fidelity codec, target config, Entra auth,
  Lakehouse attach/detach panel, Livy execution with session reuse.
- M0.1 — local-first write allowlist (`src/core/writePolicy.ts`), enforced in
  `FabricApiClient` before auth/network; `LocalFirstViolationError`;
  single-use, workspace+name-bound `UserConfirmation` for Lakehouse create
  (minting restricted to `src/vscode/` by test). Tests: `test/writePolicy.test.ts`.

- M0.2 — `Fabric: Connect to Compute` / `Disconnect`: capacity → workspace
  → host Lakehouse → optional Environment, saved as `"compute"` in
  `.fabric/local.json`; status bar; paused capacity refused; gitignore warning.
- M0.3 — Create Lakehouse on demand behind a modal (`src/vscode/lakehouseCreation.ts`,
  the only `mintUserConfirmation` caller); 201/202 handled; name validated.
- M0.4 — Livy host precedence (`src/core/livyHost.ts`): notebook default
  Lakehouse wins, else compute; cross-tenant refused; Environment attached
  via `spark.fabric.environmentDetails`; host shown in the status bar.

- M1 — notebooks complete: git source format (`notebook-content.py/.scala/.sql/.r`)
  codec with byte-for-byte and minimal-diff fidelity tests; local item index
  from `.platform`; local `%run` with parameters; cell magics; `display()`
  via a per-session bootstrap + SQL results as tables; restart session;
  session list with stop; pure-Python notebook notice (D4).

## Next

The user asked for all milestones in one run (overriding the
one-feature-per-session default); they ship as stacked PRs, one per
milestone. Next: M2 — run files, module staging, Spark job batches.

Remaining milestones M1–M5: see `docs/plan-local-first.md`.

## Open issues

- Decisions D1–D4 are recorded in `docs/plan-local-first.md`.
- Livy batches and OneLake scratch writes are not yet on the allowlist; add
  them (with tests) in the milestones that need them (M2).
- The VS Code layer (quick picks, status bar, modal) is compiled but was
  not exercised in a running VS Code in this environment; core logic is
  unit-tested against faked HTTP.
- Creating a Lakehouse when a notebook's attached one is missing is not
  offered yet; the connect flow is the only entry point.
