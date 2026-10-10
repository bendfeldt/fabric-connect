# Architecture

Fabric Connect is a local-first VS Code extension: code stays in a git working
tree and executes on Microsoft Fabric through Lakehouse-hosted Livy sessions
or batches. Queries use existing remote data services. The extension does not
publish, deploy, create, update or delete workspace items.

This describes the **current source**, including features under
[Unreleased](../CHANGELOG.md#unreleased). A released VSIX may not contain all of
them. For repository layout and build commands, see [Development](development.md);
for exact user-facing behavior, see the [user guide](user-guide.md).

## Boundaries

`src/extension.ts` is the composition root. It constructs services and registers
commands, serializers, kernels, tree views, code lenses and GUID hovers through
the stable VS Code API. Wiring is explicit; there is no DI container.

| Layer         | Responsibilities and representative modules                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/core/`   | VS Code-independent codecs, validated configuration, API/write policy, host resolution, session lifecycle, queries, item indexing, module bundles and Spark job requests |
| `src/vscode/` | VS Code authentication, filesystem/state adapters, notebook and text execution, compute selection, local bindings, views, webviews and module staging                    |
| `test/`       | Native `node:test` tests, scripted HTTP and VS Code stand-ins; no live tenant needed                                                                                     |

Shared types in `src/core/types.ts` include `IAuthProvider`, `ITargetResolver`,
`IFabricApiClient`, request/response types and a structural cancellation token.
Other boundaries live beside their implementations, including
`ILivySessionManager` in `livySessionManager.ts`. Core modules may use Node APIs,
but never import `vscode`. There is no universal Spark transport/plugin framework.

## Execution flow

```text
Notebook editor / source-text code lens / file or selection
  -> resolve tenant and Lakehouse host
  -> prepare cell language and local %run expansion
  -> prepare local Python modules when Local mode is active
  -> acquire/reuse/reattach a Livy session and bootstrap display()
  -> serialize statements through the session queue
  -> submit and poll through FabricApiClient
  -> decode text, tables and errors into notebook/output/results UI
```

The Livy version is explicit in `src/core/constants.ts` (`2023-12-01`):
`/workspaces/{workspace}/lakehouses/{lakehouse}/livyapi/versions/{version}`.
This is remote execution of local code, **not** a local Python process with a
remote Spark Connect `spark` object. Microsoft describes
[Livy sessions and batches](https://learn.microsoft.com/en-us/fabric/data-engineering/api-livy-overview)
as Spark compute associated with a Lakehouse, without requiring notebook or
Spark Job Definition items.

### Host and tenant resolution

Connecting to compute saves a **capacity**, not a mandatory workspace or host.
A host Lakehouse and optional Environment are picked when code without its own
Lakehouse first needs them. Changing capacity drops a host on the old capacity.

Notebook execution uses these rules:

1. A per-notebook local Lakehouse binding, when present, supplies the default
   without rewriting the notebook.
2. Otherwise the notebook's default Lakehouse and its **metadata workspace**
   are used. Missing workspace metadata is an error, not a target-workspace
   fallback. An unbound placeholder/logical default is refused instead of
   silently running against the compute host.
3. With no default, use the connected capacity's saved host, prompting for one
   when needed. No compute connection is an actionable error.

The tenant comes from the mapped folder target, else the repo sign-in, else
compute. When using compute, a mapped target in a different tenant is refused.
A valid notebook default can run without a compute connection when its tenant
is known. Its own host workspace determines billing; selecting a capacity does
not relocate that default.

The `.platform` item index identifies local logical IDs. Fabric documents the
use of logical identifiers for attached notebook resources in
[notebook source control](https://learn.microsoft.com/en-us/fabric/data-engineering/notebook-source-control-deployment).
Local bindings bridge those IDs to physical Lakehouses on this machine.

**Spark Job Definitions differ:** their settings provide a default Lakehouse ID
but no workspace. If that ID is bound, the folder's target workspace supplies
the workspace; without a suitable target execution fails. A job with no bound
default uses the compute host. Main files and libraries are staged and submitted
as a Livy batch, separate from interactive notebook state.

### Sessions, modules and fidelity

- `LivySessionManager` queues statements, reuses sessions and persists IDs through
  a VS Code workspace-state adapter for reattachment. Reuse is per execution
  tenant, workspace, Lakehouse and optional Environment, not statement
  language. Runs on the same target share state; unrelated targets do not.
- HTTP 404 and the specifically recognized HTTP 400 terminal/dead-session
  rejection invalidate only the matching local generation. Original errors
  remain visible; failed code is never replayed automatically. The next
  explicit run acquires a fresh session and setup state must be rebuilt.
- Local Python modules are bundled into a deterministic ZIP, uploaded under a
  window-specific `Files/.fabric-connect/` scratch path and added to the
  session. Content hashes avoid repeat uploads, not all preparation or remote
  setup. Remote mode stages nothing; switching to it does not undo prior
  staging in an already-running session.
- Stopping/restarting through the extension attempts to remove that window's
  staged modules on the host; Spark job files are removed by their own run
  once the job has ended or was cancelled (best effort: a cancel request that
  fails still counts as cancelled), and kept when the extension loses track
  of a job that may still be running. Cleanup is best effort; service-side expiry
  is not a guaranteed scratch-deletion trigger.
- `notebookCodec.ts` and `notebookSourceCodec.ts` preserve unknown metadata and
  untouched source representations. Fidelity/minimal-diff tests cover portal
  JSON and Fabric git source formats; execution outputs are transient.
- `CachedItemIndex` is invalidated by `.platform` file changes and supports
  local `%run`, logical-ID detection and hovers. `%run` inlines local Python
  cells by item display name; it never runs a deployed copy.

## Other surfaces

- `queryExecutors.ts` registers KQL, DAX and GraphQL executors. The adapter saves
  a target per query file and renders escaped results in a script-free webview.
- The Explorer **Fabric** tree browses capacities, workspaces, remote items,
  OneLake and connections. The Activity Bar **Fabric** container has
  **Configuration**, **Repo**, **Lakehouses** and **Connections** views.
  Repo discovers item folders through `.platform`, not a remote workspace.
- Lakehouse attach/default/detach edits local notebook metadata. Machine-local
  Bind/Unbind edits `local.json` instead. Neither changes a remote item.
- Pull into Repo reads an item definition (including long-running-operation
  polling), validates its part paths and writes a new local item directory;
  it refuses an existing destination. It is a copy, not synchronization.
- `.fabnb` API notebooks evaluate `%api`/`%cmd` cells through the same client
  and write policy. Requests are not categorically GET-only: explicitly
  allowlisted operations can run.

## Local state and observability

`.fabric/targets.json` holds committed folder/target/tenant mappings.
Gitignored `.fabric/local.json` holds per-repo sign-in metadata, compute,
workspace overrides, query bindings and notebook Lakehouse bindings. Module
mode/source folders use VS Code settings. Session IDs use workspace state;
recent tenants use global state; VS Code manages authentication sessions.
See [Security and data](security.md) for exact endpoints, scopes and storage.

The shared opt-in logger redacts HTTP paths. Execution diagnostics measure
client-observed, nested phases across notebook and text/file execution. They
are not pure Spark timings or a latency fix. Runtime errors retain their
tracebacks; the specific Variable Library missing-notebook-state hint supplies
guidance, not a fallback or proof of cause. See the
[diagnostic comparison](testing.md#diagnosing-slow-cells-and-variable-library-errors).

## Preserved design decisions

The original local-first decisions remain in force:

- **D1: no remote item runs.** Pipelines, Dataflow Gen2, copy jobs and job
  scheduler runs execute a deployed item, not this working tree; they are out
  of scope. Browsing/pulling an item is not permission to execute it remotely.
- **D2: T-SQL belongs to `mssql`.** Copy SQL connection details for Warehouse,
  SQL analytics endpoint or SQL database workflows; no TDS client is bundled.
- **D3: no Lakehouse provisioning.** Lakehouses are existing infrastructure.
  No workspace item-create/update/delete endpoint is on the write allowlist.
- **D4: Python-only notebooks use Livy Spark.** There is no separate local
  Python-only kernel; its runtime may differ from the portal's Python runtime.

Local-first is enforced by `writePolicy.ts` before acquiring tokens/network
requests for the shared client, and by the scratch-path guard for OneLake
writes. Read-like POSTs such as `getDefinition` and query execution are explicitly
listed. Changing an allowlist is a deliberate architecture and test change,
not an implicit exception. User Spark code and GraphQL mutations can still
change **data** with the user's permissions; this is not a data sandbox.

Keep zero runtime dependencies, explicit wiring, stable VS Code APIs,
actionable errors and compatibility tests. There is no committed promise of a
pipeline canvas, Spark Connect transport, automatic session prewarming or
full portal-runtime equivalence.
