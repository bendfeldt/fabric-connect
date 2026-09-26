# Implementation plan

Source of truth for scope: `docs/plan-local-first.md` (local-first, no deployment).

## Done

- v1.0.1 — notebooks (`.ipynb`): fidelity codec, target config, Entra auth,
  Lakehouse attach/detach panel, Livy execution with session reuse.
- M0.1 — local-first write allowlist (`src/core/writePolicy.ts`), enforced in
  `FabricApiClient` before auth/network; `LocalFirstViolationError`; no
  item-create rule at all. Tests: `test/writePolicy.test.ts`.

- M0.2 — `Fabric: Connect to Compute` / `Disconnect`: capacity → workspace
  → host Lakehouse → optional Environment, saved as `"compute"` in
  `.fabric/local.json`; status bar; paused capacity refused; gitignore warning.
- M0.3 — removed at the user's request (D3 revised): the extension never
  creates Lakehouses; Connect to Compute picks an existing one and errors
  with a pointer to the portal when a workspace has none.
- M0.4 — Livy host precedence (`src/core/livyHost.ts`): notebook default
  Lakehouse wins, else compute; cross-tenant refused; Environment attached
  via `spark.fabric.environmentDetails`; host shown in the status bar.

- M1 — notebooks complete: git source format (`notebook-content.py/.scala/.sql/.r`)
  codec with byte-for-byte and minimal-diff fidelity tests; local item index
  from `.platform`; local `%run` with parameters; cell magics; `display()`
  via a per-session bootstrap + SQL results as tables; restart session;
  session list with stop; pure-Python notebook notice (D4).

- M2 — run files and jobs: Run File / Run Selection (output channel);
  OneLake client (scratch-only writes enforced by `assertOneLakeWriteAllowed`);
  deterministic zip + module staging via `fabric-connect.sourceRoots`
  (idempotent `addPyFile` prelude, stale-module purge); Spark Job
  Definitions as Livy batches from local `Main/` + `Libs/`, state/log
  streaming, cancel; allowlist gained Livy batch submit/cancel.

- M3 — query files: `.kql` (Kusto `/v1/rest/query`), `.dax` (Power BI
  `executeQueries`), `.graphql` (GraphQL API endpoint), each an executor in
  a registry; per-file bindings in `local.json`; Results webview (no
  scripts, escaped). API client routes by `service` (fabric / powerbi /
  kusto); Kusto origin validated before any token; allowlist gained the
  three query endpoints only.

- M4 — read-only explorer (Explorer side bar "Fabric" view): capacities →
  workspaces → items by type, Lakehouse OneLake Files/Tables, connections;
  copy ID/name/OneLake path/SQL connection string; table preview on the
  compute; file preview; Pull into Repo (getDefinition + LRO, part paths
  confined to the item folder, never overwrites); GUID hover from listings
  and local logicalIds. Allowlist gained getDefinition (read) only.

## Next

The user asked for all milestones in one run (overriding the
one-feature-per-session default); they ship as stacked PRs, one per
milestone. Next: M5 — API notebook.

Remaining milestones M1–M5: see `docs/plan-local-first.md`.

## Open issues

- Decisions D1–D4 are recorded in `docs/plan-local-first.md`.
- Power BI and Kusto scopes go through VS Code's Microsoft auth provider;
  whether its client has consent for them in every tenant is unverified
  (a consent prompt may appear on first use).
- Fabric's Livy batch log endpoint is not documented; logs are fetched
  best effort and skipped after the first failure.
- The layout of a Spark Job Definition's git folder (`Main/`, `Libs/`) is
  assumed from Fabric's item definition docs; not checked against a live
  export in this environment.
- The VS Code layer (quick picks, status bar) is compiled but was
  not exercised in a running VS Code in this environment; core logic is
  unit-tested against faked HTTP.
