# Fabric Connect

[![Build](https://github.com/bendfeldt/fabric-connect/actions/workflows/build.yml/badge.svg)](https://github.com/bendfeldt/fabric-connect/actions/workflows/build.yml) [![Test](https://github.com/bendfeldt/fabric-connect/actions/workflows/test.yml/badge.svg)](https://github.com/bendfeldt/fabric-connect/actions/workflows/test.yml)

A VS Code extension that brings Microsoft Fabric development into the
editor: work with the items in your Fabric workspaces — notebooks today,
pipelines next — using files that stay 100% compatible with the Fabric
portal, across multiple tenants, without leaving VS Code.

The goal is that a Fabric developer can clone a repo, map its folders to
workspaces, sign in to the right tenant, and edit and run Fabric items
locally, with everything they save opening cleanly in the portal (and vice
versa). A shared foundation makes that work the same way for every item
type:

- **Auth** — multi-tenant, user-delegated Entra ID sign-in; tokens cached
  per tenant in SecretStorage and never overlapping between organizations.
- **Target config** — folder-to-workspace mapping with the shareable target
  shape committed to git and the actual workspace IDs in a gitignored local
  file, so nothing ever silently runs against the wrong client's workspace.
- **Fabric API client** — one typed HTTP client owning retries, backoff,
  and error normalization for every module.

New item types plug into this foundation through a registry instead of
modifying it — which is how pipelines will arrive without touching the
notebook code.

## Status

| Part               | Scope                                                                   | State                                                      |
| ------------------ | ----------------------------------------------------------------------- | ---------------------------------------------------------- |
| Part 1 — Notebooks | Portal-compatible editing, Lakehouse attach/detach, Livy cell execution | **Implemented** ([design](docs/design-part1-notebooks.md)) |
| Part 2 — Pipelines | Trigger, monitor, and eventually a visual canvas                        | Planned                                                    |
| Later              | Other item types, Marketplace publishing                                | Not started                                                |

## Features (notebooks)

- **Portal-compatible notebook editing** — Fabric `.ipynb` files round-trip
  byte-for-byte when unmodified, and unknown metadata fields always survive
  a save. Compatibility is enforced by tests, not aspiration.
- **Lakehouse management** — browse the target workspace's lakehouses,
  attach/detach them (multiple at once), and set the default, written into
  the same notebook metadata the Fabric portal uses.
- **Livy execution** — run cells against your workspace with session reuse,
  per-session queueing, cancellation, and reattachment to an existing
  session after a VS Code reload.

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

   The split is deliberate: target _shape_ is shared in git; the actual
   workspace IDs — which identify client/workspace relationships — stay on
   each developer's machine. Add `.fabric/local.json` to your repo's
   `.gitignore`.

3. Run **`Fabric: Sign In`** and enter your tenant ID.

4. Open a notebook (`*.Notebook/notebook-content.ipynb` opens automatically;
   use **`Fabric: Open File as Fabric Notebook`** for other `.ipynb` files),
   attach a Lakehouse via **`Fabric: Manage Lakehouses for Active
Notebook`**, and run cells.

## Commands

| Command                                         | Purpose                                              |
| ----------------------------------------------- | ---------------------------------------------------- |
| `Fabric: Sign In`                               | Authenticate a tenant (interactive Entra ID sign-in) |
| `Fabric: Open File as Fabric Notebook`          | Open any `.ipynb` with the Fabric editor             |
| `Fabric: Manage Lakehouses for Active Notebook` | Attach/detach lakehouses, set the default            |
| `Fabric: Stop Livy Session`                     | Stop the active notebook's Livy session              |

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

Design principles for the whole project: minimal dependencies (zero at
runtime), no magic, explicit over generic, observable API traffic, and
compatibility first — the Fabric REST API version is an explicit constant,
and only VS Code's stable extension API is used. See
[`docs/design-part1-notebooks.md`](docs/design-part1-notebooks.md).
