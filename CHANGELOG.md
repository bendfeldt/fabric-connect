# Changelog

All notable changes to Fabric Connect. Changes merged since the last
release are listed under "Unreleased" until a maintainer runs the release
workflow; each GitHub Release carries the matching `.vsix`.

## Unreleased

- **Sign In asks for the tenant** — after picking the account, you pick
  the tenant: your account's own tenant is listed first (Enter keeps it),
  alongside recent tenants, **Find tenants on my account…** and **Enter a
  tenant ID or domain…**. Before, Sign In always used the home tenant and
  guest tenants needed a separate **Switch Tenant**.
- **Walkthrough follows setup** — the Sign In and Connect to Compute steps
  tick only once you have actually signed in or connected (not when the
  link is clicked), stay ticked after a reload, and move on to the next
  step when started from the walkthrough.

## 1.2.0 — Sign in per repo

- **Sign in per repo** — `Fabric: Sign In` is now a real login: pick your
  Microsoft account (or log in with another in the browser) and the repo is
  signed in to that account's tenant, with no tenant ID to type. Like a
  Tabular Editor `.tmuo` file, the account and tenant are remembered in the
  gitignored `.fabric/local.json`, so reopening the repo signs in again
  silently, and different repos can use different accounts. A status bar
  item shows who the repo is signed in as and offers **Switch Account**,
  **Switch Tenant** (for guest access: lists the tenants on your account,
  or takes a tenant ID or domain such as `contoso.onmicrosoft.com`) and
  **Sign Out**. The explorer, API notebooks, compute and query files all
  use the repo's sign-in.
- Requires VS Code 1.93 or later (for choosing the Microsoft account).

## 1.1.7

- Changelog: the packaging, walkthrough and docs entries are filed under
  1.1.6, the release that shipped them. No extension changes.

## 1.1.6 — Ship-ready packaging and docs

- Packaging: the `.vsix` now contains only the compiled extension, its
  manifest, README, changelog, license, icon and walkthrough pages. Build
  output is cleaned before every package, so removed code can never ship
  from a stale `out/` folder. CI packages on every PR and checks the
  contents.
- In-product **Get started with Fabric Connect** walkthrough (Welcome page
  → Walkthroughs).
- Extension icon, Marketplace metadata (description, keywords, links).
- Documentation: end-to-end [getting-started guide](docs/getting-started.md)
  and [security and data guide](docs/security.md); user guide, installation
  guide and README refreshed for the local-first feature set.

## 1.1.5 — Local-first Fabric development (M0–M5)

Fabric Connect becomes a "Databricks Connect for Fabric": code lives in
your git repo, runs on Fabric compute, and nothing is ever deployed.

- **Connect to Compute** — pick capacity (SKU) → workspace → existing host
  Lakehouse → optional Environment, once per repo; status bar shows the
  connection and which Lakehouse runs the active notebook.
- **Never deploys** — every write that is not on a short, tested allowlist
  (Livy sessions/statements/batches, query endpoints, definition reads,
  OneLake scratch staging) is refused before sign-in or any network call.
  The extension never creates items, Lakehouses included.
- **Notebooks** — Fabric's git source format (`notebook-content.py`,
  `.scala`, `.sql`, `.r`) alongside `.ipynb`, with byte-for-byte fidelity;
  local `%run`; cell magics; `display()` tables; restart, list and stop
  Livy sessions; Python (non-Spark) notebooks run on Spark with a notice.
- **Run files and jobs** — run a file or selection on Fabric; stage your
  working tree's Python modules (`fabric-connect.sourceRoots`); run Spark
  Job Definitions as Livy batches from local files.
- **Query files** — `.kql`, `.dax`, `.graphql` against a bound KQL
  database, semantic model or GraphQL API; results as tables. T-SQL is left
  to the `mssql` extension.
- **Fabric explorer** — read-only capacities, workspaces, items, OneLake
  files and tables, connections; previews; Pull into Repo; GUID hover.
- **API notebooks** — `.fabnb` notebooks with `%api` / `%cmd` cells for the
  Fabric REST API.

## 1.0.x — Notebooks

- Portal-compatible `.ipynb` editing with byte-for-byte fidelity and
  unknown-field preservation.
- Lakehouse attach/detach panel.
- Livy cell execution with session reuse, queueing, cancellation and
  reattachment after reload.
- Multi-tenant Entra ID sign-in; folder → workspace targets with IDs kept
  in a gitignored local file.
