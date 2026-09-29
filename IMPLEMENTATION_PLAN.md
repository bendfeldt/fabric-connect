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

- M5 — API notebooks (`.fabnb`): `%api` / `%cmd` cells, variables,
  `$(_cells[-n]…)` references, list responses as tables; all requests
  through the shared client, so the write policy applies; only Fabric API
  URLs accepted.

- Shipping and docs: `.vscodeignore` allowlist (only compiled JS, manifest,
  README, CHANGELOG, LICENSE, media); `vscode:prepublish` cleans `out/`;
  icon, Marketplace metadata, in-product walkthrough; manifest/activation
  test (declared commands, notebook types, views, menus, walkthrough links
  all wired); CI packages on every PR and checks `.vsix` contents; new
  `docs/getting-started.md` and `docs/security.md`; README, user guide,
  installation guide and CHANGELOG refreshed.

- Setup feedback on 1.2.0 (2026-09-28): `.gitattributes` keeps LF for
  Windows contributors; Sign In now asks for the tenant (home tenant
  first, tenant step runs as the picked account); walkthrough Sign In /
  Connect Compute steps complete via `onContext` keys and advance when
  started from the walkthrough. The `DEP0169 url.parse()` warning during
  `code --install-extension` comes from VS Code's CLI, not the extension.

- Fabric side bar, feedback 2026-09-29 part 1 of 3: Activity Bar
  container `fabric-connect` with Configuration, Tenants, Capacities,
  Workspaces (SKU via `describeWorkspaceCapacity`) and Connections views;
  the Explorer side bar view stays. `FabricExplorer` gained an
  `ExplorerRoot`; `SignInManager.switchTo(tenant)` backs the Tenants view.

## Next

- Feedback part 2: **Repo Items** view from `LocalItemIndex` (type → item
  by `.platform` displayName → content files, `.platform` hidden); click a
  notebook to open it in the Fabric notebook editor; right-click **Open
  .platform** and **Edit Item Metadata…** (displayName/description via a
  pure, round-trip-tested `updatePlatform`, applied as a `WorkspaceEdit`).
- Feedback part 3: pin Lakehouses from Repo Items (attachments listed
  under a notebook; Pin… / Set as Default / Unpin through the notebook
  serializer and `attachLakehouse`/`detachLakehouse`). Never creates a
  Lakehouse (D3).

All planned milestones (M0–M5) are implemented, as stacked PRs (one per
milestone; the user asked for all of them in one run, overriding the
one-feature-per-session default). Next steps belong to the user: review
and merge the PR stack, then smoke-test against a real tenant (the VS Code
UI and live Fabric calls could not be exercised in the build environment).

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
- The Fabric side bar is not yet checked in a running VS Code (section 1
  and 9 of `docs/testing.md`).
- Sign-in tenant step and walkthrough advance are not yet checked in a
  running VS Code; see the sign-in and walkthrough items in
  `docs/testing.md`.
- The VS Code layer (quick picks, status bar) is compiled but was
  not exercised in a running VS Code in this environment; core logic is
  unit-tested against faked HTTP.
