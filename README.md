# Fabric Connect

A VS Code extension for working with Microsoft Fabric notebooks: edit
portal-compatible notebook files, attach Lakehouses, and run cells against
your Fabric workspace over Livy — without leaving the editor.

This is **Part 1 (notebooks)** of the extension. Pipelines and other item
types are a separate, later part; the module boundaries here (auth, target
config, API client) are designed so Part 2 plugs in without changes to this
code. See [`docs/design-part1-notebooks.md`](docs/design-part1-notebooks.md)
for the full design.

## Features

- **Portal-compatible notebook editing** — Fabric `.ipynb` files round-trip
  byte-for-byte when unmodified, and unknown metadata fields always survive
  a save. Compatibility is enforced by tests, not aspiration.
- **Lakehouse management** — browse the target workspace's lakehouses,
  attach/detach them (multiple at once), and set the default, written into
  the same notebook metadata the Fabric portal uses.
- **Livy execution** — run cells against your workspace with session reuse,
  per-session queueing, cancellation, and reattachment to an existing
  session after a VS Code reload.
- **Multi-tenant auth** — user-delegated Entra ID sign-in per tenant via VS
  Code's built-in Microsoft authentication; tokens are cached per tenant in
  SecretStorage and never overlap between organizations.

## Setup

1. **Declare targets** (committed) in `.fabric/targets.json` at your
   workspace root:

   ```json
   {
     "folders": { "notebooks": "dev" },
     "targets": {
       "dev": {
         "itemType": "notebook",
         "tenantId": "00000000-0000-0000-0000-000000000000"
       }
     }
   }
   ```

2. **Map targets to workspaces** (local, **gitignored — never commit this
   file**) in `.fabric/local.json`:

   ```json
   {
     "targets": {
       "dev": { "workspaceId": "00000000-0000-0000-0000-000000000000" }
     }
   }
   ```

   The split is deliberate: target *shape* is shared in git; the actual
   workspace IDs — which identify client/workspace relationships — stay on
   each developer's machine. Add `.fabric/local.json` to your repo's
   `.gitignore`.

3. Run **`Fabric: Sign In`** and enter your tenant ID.

4. Open a notebook (`*.Notebook/notebook-content.ipynb` opens automatically;
   use **`Fabric: Open File as Fabric Notebook`** for other `.ipynb` files),
   attach a Lakehouse via **`Fabric: Manage Lakehouses for Active
   Notebook`**, and run cells.

## Commands

| Command | Purpose |
| --- | --- |
| `Fabric: Sign In` | Authenticate a tenant (interactive Entra ID sign-in) |
| `Fabric: Open File as Fabric Notebook` | Open any `.ipynb` with the Fabric editor |
| `Fabric: Manage Lakehouses for Active Notebook` | Attach/detach lakehouses, set the default |
| `Fabric: Stop Livy Session` | Stop the active notebook's Livy session |

Set `fabric-connect.debugLogging: true` to see redacted API request/response
logs (retries included) in the **Fabric Connect** output channel. Tokens,
tenant IDs, workspace IDs, and cell contents never appear in logs.

## Development

```sh
npm install
npm run compile   # type-check + build to out/
npm test          # build + unit tests (node --test, no live workspace needed)
```

The core modules (`src/core/`) have no dependency on the `vscode` module —
they run and test in plain Node. The VS Code adapters (`src/vscode/`) and
the composition root (`src/extension.ts`) wire them to the editor with
plain constructor calls; there is no DI container or framework to learn.

## Out of scope for Part 1

- Pipelines (trigger, monitor, visual canvas)
- Item types other than notebooks
- Marketplace packaging/publishing
