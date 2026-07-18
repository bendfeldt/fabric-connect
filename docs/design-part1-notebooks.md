# MS Fabric VS Code Extension — Part 1: Notebook Module

## Scope

This part covers only what's needed to get notebooks working end-to-end:
editing, Lakehouse attachment, Livy execution, and the minimum auth/config
plumbing required to reach a workspace. Pipelines and everything else from
the full concept doc are explicitly out of scope here and will be designed
as a separate, sibling part.

## Architecture

Each concern is an independent module behind a narrow interface (e.g.
`IAuthProvider`, `ITargetResolver`, `INotebookCodec`, `ILivySessionManager`),
wired together in a single composition root (`extension.ts`'s `activate()`).
Modules depend on interfaces, not on each other's internals — this is what
lets Part 2 (pipelines) plug into Auth, Target Config, and the Fabric API
Client unchanged, and what makes each module mockable/testable in isolation.

```
┌─────────────────┐     ┌──────────────────────┐
│   Auth Module    │     │ Target Config Module │
│ (tenant/token)   │     │ (folder → workspace)  │
└────────┬─────────┘     └──────────┬───────────┘
         │                          │
         └───────────┬──────────────┘
                      │
              ┌───────┴────────┐
              │ Fabric API      │
              │ Client (shared) │
              │ retries/backoff │
              │ error handling  │
              └───────┬────────┘
                      │
        ┌─────────────┼─────────────────────┐
        │             │                     │
┌───────┴───────┐ ┌───┴────────────┐ ┌──────┴───────────┐
│ Notebook       │ │ Lakehouse Panel│ │ Livy Session      │
│ Fidelity Module│ │ Module         │ │ Manager            │
│ (parse/write)  │ │ (attach/detach)│ │ (lifecycle, exec)  │
└────────────────┘ └────────────────┘ └──────┬─────────────┘
                                              │
                                    ┌─────────┴──────────┐
                                    │ Execution/Output    │
                                    │ Module (render in    │
                                    │ VS Code)             │
                                    └──────────────────────┘
```

## Modules

### 1. Auth Module
- Multi-tenant, user-delegated Entra ID auth (`az login`-style).
- Interactive login, token cache + refresh, clean switching between tenants
  with no credential overlap.
- Credentials stored via VS Code `SecretStorage` API.
- **Interface**: `IAuthProvider.getToken(tenantId, scope) → token`.
  No awareness of notebooks, targets, or item types.

### 2. Target Config Module
- Resolves `folder path → target → workspace ID`.
- Target *shape* (name, item type it governs) is committed to git; the
  actual workspace ID resolves from a local, gitignored override file
  (same pattern as the `local` tier in the existing `CLAUDE.md` hierarchy).
- Item types are added via a **registry** (`registerItemType('notebook', handler)`)
  rather than hardcoded — so Part 2 adds `pipeline` by registering a
  handler, not by modifying this module.
- **Interface**: `ITargetResolver.resolveTarget(folderPath) → { workspaceId, itemType }`.
- Resolution failures must be loud and specific — the real risk here isn't
  a crash, it's silently executing against the wrong client's workspace.
  Validate the resolved config against a schema before use.

### 3. Fabric API Client (shared)
- A single typed HTTP client used by Fidelity, Lakehouse Panel, and Livy
  Session Manager — owns retries, backoff, and error normalization into
  one `FabricApiError` type.
- Without this, a REST contract change means fixing the same logic in
  three places instead of one.
- **Interface**: `IFabricApiClient.request<T>(...) → T`.

### 4. Notebook Fidelity Module
- Reads/writes the Fabric notebook file format 1:1 with the portal —
  same metadata Fabric itself writes (default lakehouse + attached
  lakehouses).
- **Must preserve unknown metadata fields on round-trip** — if Fabric adds
  a field this module doesn't understand yet, it has to survive parse →
  serialize unchanged rather than being dropped. This is what actually
  enforces "100% compatible" rather than just aiming for it.
- **Interface**: `INotebookCodec.parse(file) → NotebookModel`,
  `serialize(NotebookModel) → file`.

### 5. Lakehouse Panel Module
- VS Code panel to browse, attach, and detach lakehouses for the active
  notebook; supports multiple lakehouses attached at once.
- Calls the Fabric API Client to list available lakehouses, writes results
  into the notebook's metadata via the Fidelity Module's model.

### 6. Livy Session Manager
- Owns session lifecycle against the workspace resolved by Target Config:
  start, reuse, idle timeout — mirroring standard portal notebook-run
  behavior.
- **Cancellation**: supports VS Code's `CancellationToken` so a running
  cell can be stopped.
- **Queueing**: serializes multiple cell/notebook executions against the
  same session rather than racing them.
- **Reattachment**: on VS Code reload, reconnects to an existing Livy
  session by ID instead of always starting a fresh one — matching portal
  behavior and avoiding orphaned sessions burning capacity.
- **Interface**: `ILivySessionManager.execute(cell, token) → rawResult`.

### 7. Execution/Output Module
- Renders cell outputs (tables, plots, text, errors) in VS Code.
- Consumes results from the Livy Session Manager; agnostic of how they
  were produced.

## Code principles: minimal, transparent, fast, compatible
These constrain every module above — the interface/registry structure is
the boundary needed for Part 2, not a license to add abstraction beyond
that.

- **Minimal dependencies.** Prefer built-in Node and VS Code APIs over
  pulling in a library. Each new dependency needs a concrete reason, not
  "might be useful." No DI containers, no ORMs, no reactive-stream
  frameworks (RxJS etc.) unless a specific problem actually demands one.
- **No magic.** No decorators, no reflection-based wiring, no runtime
  metaprogramming. The composition root in `activate()` should be plain,
  readable constructor calls — anyone should be able to trace a request
  from "cell run" to "Livy call" by reading code, not by understanding a
  framework's conventions.
- **Explicit over generic.** The item-type registry exists because Part 2
  concretely needs it. Don't build a generic plugin system, config DSL, or
  event bus speculatively — add abstraction when a second real case
  demands it, not before.
- **Observable, not opaque.** The Fabric API Client logs outgoing
  requests/responses (redacted) to a VS Code output channel in debug mode.
  Retries and error normalization must be visible in logs, not a black box
  that silently swallows or reshapes failures.
- **Compatibility first.** Target only VS Code's stable extension API
  (no proposed/experimental APIs), pinned to the TypeScript/Node version
  VS Code's extension host actually ships. Treat the Fabric REST API
  version as an explicit constant, never inferred from response shape.
- **Speed.** Lazy-activate on relevant events (opening a Fabric notebook,
  running a relevant command) rather than activating on VS Code startup.
  Keep the Lakehouse panel to plain HTML/vanilla JS — no UI framework —
  since Part 1's panel doesn't need one; save that tradeoff for the
  Phase 4 canvas, where it's actually justified.

## Error handling standard
No generic "something went wrong" errors anywhere. Every thrown/surfaced
error must state: **what operation failed, why (root cause if known), which
entity it relates to** (tenant/workspace/file/session), **and the next step**
the developer should take. Raw exceptions never cross a module boundary
unwrapped — each module catches and re-throws as a typed domain error, with
the original exception preserved as `cause` for debugging.

Failure points per module, and what their errors must convey:

- **Auth Module** — token acquisition failure (network, consent declined,
  expired refresh token, tenant-switch conflict): must name the tenant
  involved and whether the fix is "re-authenticate" or "check network."
- **Target Config Module** — missing local override file, malformed
  override, unregistered item type, workspace ID unresolvable: must name
  the exact folder path and target, and state the remediation (e.g. "add
  a workspace ID for target `dev` in `.fabric/local.json`"). This is the
  module where silent wrong-workspace failures are most dangerous, so
  errors here are loud by design, never a fallback default.
- **Fabric API Client** — HTTP errors (401/403/404/429/5xx), timeouts,
  malformed responses: map raw status/body into a `FabricApiError` with a
  human-readable explanation and the request's correlation ID, so a
  support case can reference it directly rather than a bare stack trace.
- **Notebook Fidelity Module** — parse failure (corrupt file, unsupported
  schema version), serialization failure (missing required field): must
  name the file and the specific section/field involved, and whether it
  happened on read or write.
- **Lakehouse Panel Module** — list failure (no permission on workspace),
  attach/detach conflict (already attached, or lakehouse deleted upstream):
  must name the lakehouse and workspace involved.
- **Livy Session Manager** — session start failure (capacity paused, pool
  not found, insufficient permissions) vs. mid-execution session expiry vs.
  a cell's own runtime error: these are three different failure classes
  and must be presented differently. Infra-level failures get an
  actionable message ("capacity X is paused — resume it in the portal").
  A cell's own exception is not an extension error at all — it's shown as
  the notebook's own traceback, exactly as the portal would show it.
- **Execution/Output Module** — unsupported output MIME type: degrade
  gracefully with an inline warning on that one output, never crash the
  whole notebook's rendering.

## Testing strategy
- **Unit tests** per module, dependencies mocked via the interfaces above.
- **Integration tests** against recorded HTTP fixtures (nock/msw) — no live
  workspace required in CI.
- **Round-trip fidelity test**: parse a real portal-exported notebook,
  serialize it back, diff against the original byte-for-byte where
  possible. This is what actually enforces "100% portal-compatible" as a
  testable property, not just a stated goal.
- **Minimal E2E** via `@vscode/test-electron` for the critical path only
  (open notebook → run cell → see output). Kept thin since UI-level tests
  are slow and flaky.

## Security considerations
- **Token handling**: never logged, never written outside `SecretStorage`;
  tokens cached and keyed per-tenant so there's no path for a token from
  one client's tenant to be used against another's — directly enforcing
  the "never overlap between orgs" requirement.
- **Least privilege**: request only the OAuth scopes needed for the
  notebook/Lakehouse APIs actually used, not broad Fabric/Graph access.
- **Local override file hygiene**: contains workspace IDs, not secrets,
  but must be gitignored by default and the repo template should make
  that unmissable — this file identifying client/workspace relationships
  is still not something to accidentally commit or share.
- **Transport**: HTTPS only via the Fabric API Client; never disable
  certificate validation, even for debugging.
- **No sensitive data in logs/telemetry**: tokens, tenant IDs, workspace
  IDs, and notebook cell contents/outputs must never appear in extension
  logs. If telemetry is added later, it must be explicit opt-in.
- **Narrow activation**: the extension should activate only on relevant
  file types/commands, not unconditionally on VS Code startup — smaller
  attack surface and faster startup.
- **Webview safety** (Lakehouse panel now, canvas in Part 2 later):
  strict Content Security Policy, no remote script loading, sanitize any
  API response data before rendering into the webview to avoid injection.
- **Path validation**: when resolving folder → target and writing files,
  validate resolved paths stay within the workspace folder — no traversal
  outside it via a misconfigured mapping.
- **Supply chain**: minimal dependency footprint, lockfile committed,
  periodic `npm audit` — worth taking seriously early since this extension
  will hold credentials, and matters even more once Marketplace-published.

## Out of scope for Part 1
- Pipelines (trigger, monitor, or visual canvas)
- Any item type other than notebooks
- Marketplace packaging/publishing

## Why this split works for Part 2 later
Part 2 (pipelines) reuses the Auth Module, Target Config Module, and Fabric
API Client unchanged, registers `pipeline` as a new item type via the
registry, and adds its own sibling modules (Pipeline Fidelity,
Trigger/Monitor, eventually the visual canvas) — without touching anything
built here.
