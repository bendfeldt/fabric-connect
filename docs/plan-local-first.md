# Plan: Local-first Fabric development ("Fabric Connect" as Databricks Connect for Fabric)

Status: proposed, 2026-09-26. Supersedes the "Part 2 = pipelines" scope in
`design-part1-notebooks.md` (pipelines become one executor among many, see M6).

## Goal

Develop anything Fabric can run from a local git working tree, execute it on
Fabric compute you pick once ("connect to a SKU"), and never publish or deploy
items. Cover most of what Fabric Studio offers for _working with_ a tenant,
without its deployment and item-mutation surface.

## Why this is different from Fabric Studio and the Microsoft Fabric extension

Both are **remote-first**: the workspace is the source of truth, you browse it,
open an item (Fabric Studio: an in-memory `fabric://` file system), edit, and
publish back. Execution context comes from what you selected in a tree.

We are **local-first**, like Databricks Connect:

| Principle                                             | Consequence                                                                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| The git working tree is the only code store.          | No virtual file system, no "publish", no "edit definition". Remote items are _read_ (browse, pull once, query), never written.             |
| Compute is a connection, not an item.                 | You connect to a capacity/workspace once per repo (status bar, like a Databricks cluster); every file runs against it.                     |
| Run context comes from local files.                   | Target resolves from `.fabric/targets.json` + `local.json`, `.platform` files and notebook metadata — never from what's clicked in a tree. |
| Remote uploads are ephemeral staging, not deployment. | Local modules/job files are staged to a per-session scratch OneLake path and deleted afterwards. No item is created or updated.            |
| Editing works offline.                                | Network is needed only to run, browse, or pull.                                                                                            |

## The honest constraint: there is no Spark Connect in Fabric

Databricks Connect runs your Python process locally and ships DataFrame plans
over Spark Connect. Fabric does not expose Spark Connect (still absent as of
the July 2026 feature summary). The only remote Spark entry point is the
**Livy API**, and it is always hosted by a Lakehouse:
`/workspaces/{ws}/lakehouses/{lh}/livyapi/versions/2023-12-01/{sessions|batches}`.

So "Databricks Connect for Fabric" means: **local code, local editor and
tests, shipped as statements/batches to a Livy session.** Not: a local Python
process with a remote `spark` object. We design so that swapping the transport
to Spark Connect later is one module (`ILivySessionManager` → `ISparkTransport`),
if Microsoft ships it.

Two consequences to design around:

1. **"Connect to a SKU" = capacity → workspace on it → host Lakehouse.** Spark
   bills to the capacity of the workspace that owns the host Lakehouse. We let
   the user pick the capacity (showing SKU/region), then a workspace assigned
   to it, then a host Lakehouse (a dedicated scratch one is recommended).
2. **Relative paths resolve to the host Lakehouse.** `Files/...` and
   unqualified `spark.sql("SELECT ... FROM t")` hit whichever Lakehouse hosts
   the session. Precedence rule: a notebook's own default Lakehouse (from its
   metadata, mapped via the target) wins; files with no Lakehouse context
   (plain `.py`, `.sql`, job definitions) use the compute profile's host.
   The status bar always shows which one is in effect.

## Guardrail: "never deploy" as a tested property

Like round-trip fidelity, local-first must be enforced, not intended:

- **Write allowlist in `FabricApiClient`.** Every non-GET request must match an
  explicit allowlist (Livy sessions/statements/batches, job-instance runs,
  query endpoints, OneLake scratch paths). Anything else — `POST /items`,
  `updateDefinition`, `PATCH /items/{id}`, git/deployment-pipeline APIs —
  throws a typed `LocalFirstViolationError` before any network call.
- **Unit test** that enumerates the allowlist and asserts item create/update/
  delete/definition paths are rejected. Changing the allowlist is a visible,
  reviewed diff.
- **Scratch hygiene test**: staged OneLake files live only under
  `Files/.fabric-connect/<session-id>/` in the host Lakehouse and are deleted
  on session stop.

## Architecture additions

Existing modules (Auth, Target Config, API Client, Codec, Livy) stay. New
boundaries in `src/core/types.ts`, all `vscode`-free:

- `IComputeProfile` — resolved `{tenantId, capacityId, workspaceId,
hostLakehouseId, environmentId?}`; shape in `targets.json`, IDs in
  `local.json` (extends the existing split, no new config file).
- `IExecutor` + `registerExecutor(kind, executor)` — one executor per run
  surface (Spark statement, Spark batch, KQL, DAX, GraphQL, REST, job run).
  Added through a registry exactly like `registerItemType`; the controller
  picks by file kind, never by `if` chains.
- `ILocalItemIndex` — scans the working tree for `*.<ItemType>/.platform`
  files, maps `logicalId` ↔ local folder ↔ (optional) remote item ID from
  `local.json`. Used for `%run`, hover, and remote-bound items.
- `IOneLakeClient` — DFS (ADLS Gen2-compatible) calls to
  `onelake.dfs.fabric.microsoft.com` for browse/preview and scratch staging.
  Plain `fetch`, no Azure SDK (zero-dependency rule holds).

## What runs, and how

| Local artifact                                          | Executor                                                   | Remote dependency          | Milestone   |
| ------------------------------------------------------- | ---------------------------------------------------------- | -------------------------- | ----------- |
| Notebook `.ipynb` (portal format)                       | Livy session statements                                    | host Lakehouse             | done (v1.0) |
| Notebook `notebook-content.py` (git default format)     | same                                                       | same                       | M1          |
| `%run OtherNotebook`                                    | resolved **locally** via item index, inlined               | none                       | M1          |
| `.py` / `.scala` / `.sql` (Spark SQL) file or selection | Livy session statements                                    | host Lakehouse             | M2          |
| Local Python package imports                            | zip → scratch OneLake → `sc.addPyFile`                     | host Lakehouse             | M2          |
| Spark Job Definition (`*.SparkJobDefinition/`)          | Livy **batch** with staged main file + libs, streamed logs | host Lakehouse             | M2          |
| `.kql` / KQL queryset                                   | Kusto REST v2 query                                        | existing Eventhouse (read) | M3          |
| `.dax` against a semantic model                         | Power BI `executeQueries` REST                             | existing model (read)      | M3          |
| `.graphql`                                              | POST to GraphQL API endpoint                               | existing API item (read)   | M3          |
| T-SQL (Warehouse, SQL endpoint, SQL DB)                 | see decision D2                                            | existing item              | M3          |
| `.fabnb`-style REST cells (`%api`)                      | Fabric REST, GET-only by default; writes need allowlist    | none                       | M5          |
| Data Pipeline / Dataflow Gen2 / Copy job                | see decision D1                                            | existing item              | M6          |

Local TMDL/PBIR edits and pipeline JSON cannot execute without being deployed;
that is a hard platform limit, and we say so in the UI rather than silently
running the remote copy.

## Fabric Studio parity (minus deployment)

| Fabric Studio feature                                                                | Plan                                                                                                 |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Workspace browser                                                                    | M4, **read-only** tree: capacities → workspaces → items, with SKU/state.                             |
| OneLake browse / copy paths                                                          | M4, via `IOneLakeClient`; Delta table preview runs `SELECT … LIMIT` through the Spark executor.      |
| GUID hover (item name/type/workspace)                                                | M4, from the browser cache + `ILocalItemIndex` (`.platform` logicalIds).                             |
| Copy SQL endpoint / connection string                                                | M4 (read-only).                                                                                      |
| Spark notebooks via Livy, session stop/restart                                       | have it; restart + `%run` in M1.                                                                     |
| API notebooks (`%api`, `%cmd`, `_cells`)                                             | M5.                                                                                                  |
| Run notebook / pipeline / Spark job (job scheduler)                                  | M6, remote-bound only.                                                                               |
| Connections, gateways, capacities views                                              | M4 read-only; mutations out.                                                                         |
| "Pull" an item into the repo                                                         | M4: `getDefinition` → write to `<name>.<Type>/` once. This is a clone, not a sync; there is no push. |
| `fabric://` FS, Publish to Fabric, Edit Definition                                   | **Out** (remote-first by nature).                                                                    |
| Fabric Git integration, Deployment pipelines                                         | **Out** (deployment). Use real git.                                                                  |
| Role assignments, tags, capacity assignment, mirroring start/stop, warehouse restore | **Out** for now (tenant admin mutations, not development). Revisit only on request.                  |
| vscode.dev support                                                                   | Out: local-first needs a local file system.                                                          |

## Milestones (one feature per session, per `AGENTS.md`)

Each line is one session-sized feature with its own acceptance test.

**M0 — Connect to compute**

1. API write-allowlist + `LocalFirstViolationError` + test (lands first; every later feature must pass it).
2. `Fabric: Connect to Compute` — list capacities (SKU, region, state) → workspaces on it → host Lakehouse (+ optional Environment); stored as a compute profile; status-bar item showing the active connection; paused capacity is a loud error.
3. Decouple Livy host from notebook metadata with the precedence rule above, shown in the status bar.

**M1 — Notebooks, complete** 4. Codec for `notebook-content.py` format with the same round-trip fidelity tests as `.ipynb`. 5. `ILocalItemIndex` + local `%run` resolution. 6. `display()` rendering: session bootstrap defines a display shim that emits a tagged JSON/HTML payload the controller renders as a table (closes the Livy `display()` gap both tools share). 7. Restart session command; session view (active sessions per compute profile, stop orphans).

**M2 — Run files and jobs (the Databricks Connect core)** 8. Run file / run selection for `.py`, `.scala`, `.sql` in the shared session. 9. Local module staging: zip the configured source roots, upload to scratch, `addPyFile`, re-stage on change (content hash), delete on stop. 10. Spark Job Definition as Livy batch: staged main file + args from local definition, streamed driver logs, cancel.

**M3 — Query surfaces** (each an executor registered via `registerExecutor`) 11. KQL. 12. DAX. 13. GraphQL. 14. T-SQL (per D2).

**M4 — Explorer (read-only)** 15. Capacity/workspace/item tree. 16. OneLake browser + table preview. 17. GUID hover. 18. Pull item into repo.

**M5 — API notebook** 19. `%api` / `%cmd` / `_cells` cells, GET-only unless allowlisted.

**M6 — Remote-bound items** (per D1) 20. Run existing pipeline/dataflow/notebook via job scheduler, matched from the local `.platform` logicalId, with status polling and a warning when the local definition differs from the remote one.

## Decisions needed from you

- **D1 — Remote-bound items (pipelines, dataflows).** They cannot run from a
  local definition. Recommended: run the _existing remote item_ matched via
  `.platform` logicalId, warn on drift, never update it. Alternative: leave
  them out entirely.
- **D2 — T-SQL.** TDS is a binary protocol; implementing it breaks the
  zero-dependency rule. Recommended: hand off to the Microsoft `mssql`
  extension (optional extension dependency, not an npm package), and run
  Lakehouse tables through Spark SQL ourselves. Alternative: add `tedious`
  (would need the dependency justification in the commit body).
- **D3 — Host Lakehouse creation.** Creating a scratch Lakehouse is itself an
  item create. Recommended: the user picks an existing Lakehouse; we offer to
  create `fabric_connect_scratch` only behind an explicit one-time confirm,
  as the single allowlisted item create.
- **D4 — Pure-Python (non-Spark) Fabric notebooks.** Livy only runs Spark.
  Options: run them on the Spark session (behaviour differs slightly), or run
  them in a _truly local_ Python kernel with OneLake access through a token.
  Recommended: Spark session first; local kernel later if asked.

## Risks

- **Livy API status**: high-concurrency sessions are preview; the endpoint
  shape is pinned in `constants.ts` and must stay an explicit constant.
- **Session startup latency** (tens of seconds cold): mitigate with reuse
  (existing) and an optional pre-warm on `Connect to Compute`.
- **Wrong-workspace execution** grows with more surfaces: every executor goes
  through the target/compute resolver; no executor takes an ID from UI state.
- **Scope creep toward remote-first**: the allowlist test is the brake. A
  feature that needs a new write endpoint needs an explicit plan change here.
