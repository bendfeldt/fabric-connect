# Changelog

All notable changes to Fabric Connect. Changes merged since the last
release are listed under "Unreleased" until a maintainer runs the release
workflow; each GitHub Release carries the matching `.vsix`.

## Unreleased

- **No more duplicate runs after a network hiccup** — a request that starts
  work (running a cell, starting a Livy session, submitting a Spark job, or a
  query) is no longer resent after a network error or a 5xx answer, since it
  may already have run; the error now says so and asks you to check before
  running it again. Throttled (429) requests, reads and stops are still
  retried with backoff.
- **Reloads no longer leave a second Livy session running** — when VS Code
  cannot reach the session it saved before a reload (network error, throttling,
  service error), the cell now fails with that error and the saved session is
  kept; a new session starts only when Fabric reports the old one as ended or
  not found, or returns no session for it.
- **Running cells and Spark jobs survive a network blip** — while a cell or
  job runs, losing the network (Wi-Fi switch, VPN reconnect) no longer ends
  the run with an error after a few seconds; Fabric Connect keeps polling for
  up to two minutes and only then reports the network error. The same holds
  for the setup Fabric Connect runs on a new session before your first cell.
- **A Spark job keeps its files while it may still need them** — a job's
  staged main file and libraries were deleted as soon as Fabric Connect lost
  track of the job, or when you stopped or restarted a notebook session on
  the same Lakehouse, so a job that was still starting could fail. They are
  now deleted only once the job has ended (or was cancelled); when tracking
  is lost they are kept and the output channel says where. Stopping a session
  now removes only that window's staged Python modules.

## 1.4.1 — 2026-10-09

- **Releases keep the whole repo in step** — the Release workflow's
  version-bump PR now also files this changelog's Unreleased entries under the
  new version and auto-merges by rebase (it used to squash), so the `auto` bump
  now reads every commit subject of rebase-merged branches. A test fails CI
  when the manifest, lockfile and changelog disagree, or when a guide
  hard-codes a released or development version; the local development-build
  guide now computes its version from `package.json`. No extension changes.

## 1.4.0

- Changelog: the entries that shipped in 1.3.0 are filed under 1.3.0
  instead of "Unreleased". No extension changes.

## 1.3.0 — Fabric side bar and repo-centric workflows

- **Packaging toolchain** — pin vsce 4.0.0 and use Node 22 for Build and
  release packaging. Local VSIX builds require Node 22+; extension runtime
  requirements and the Node 18/20/22 native-test matrix are unchanged.
  Versioned local development builds still leave checkout manifests untouched.
- **Documentation refreshed** — current architecture and developer guides
  replace superseded design plans; setup, commands/settings, local bindings,
  module modes, validation fixtures and installed contributor guidance now
  match the source tree. Build/install recipes use an explicitly named VSIX.
- **Dead-session recovery** — the specific HTTP 400 Livy submission
  rejection reporting a matching terminal/dead session now clears its
  local reference, so the next run starts a fresh session without
  reloading VS Code. Original service errors remain visible; failed code
  is never replayed automatically. Late failures cannot clear a newer
  session. Rerun setup code to restore lost in-memory state.
- **Execution diagnostics** — opt-in debug logging separates host and
  module preparation, session startup/reattachment, queueing, bootstrap,
  module setup, user-statement wait and rendering in notebook and
  text-run paths. Timings are client-observed, not pure Spark timings.
- **Variable Library failure guidance** — the specific missing-notebook-state
  resolution error keeps its traceback and failed status, with visible
  guidance to compare Livy with deployed notebook execution. No
  compatibility shim or configuration fallback is applied.
- **Browse Lakehouses in the Lakehouses view** — a Lakehouse row expands
  into its OneLake Tables and Files, with Preview Table, Preview File and
  Copy OneLake Path, as in the Fabric explorer.
- **Open as Text and Open Changes as Text** — notebooks still open in the
  notebook editor. **Open as Text** (notebook toolbar) reopens the file as
  editable text with **Run Cell | Run All Above** above each cell (output
  in the _Fabric Connect: Run_ channel, tables in Fabric Results); **Open
  as Notebook** switches back. **Open Changes as Text** (right-click a
  notebook in Source Control) shows the raw diff, HEAD against the working
  tree, metadata included — the cell diff hides those changes.
- **Python modules: Local or Remote** — the **Python modules** row in
  the Configuration view, a status bar item (always in sync) and
  **Fabric: Python Modules (Local or Remote)** pick whether `import` uses your working tree
  (staged to the session) or what the Fabric environment has installed,
  such as your wheel. Local finds the source folders from
  `pyproject.toml` when `fabric-connect.sourceRoots` is not set. An
  import error on Remote for a package that is also in your repo now
  says so and how to switch.
- **Fix: `display(df)` shows a table** — the raw
  `FABRIC_CONNECT_DISPLAY{…}` text was printed instead. Fabric's Livy
  drops the trailing control character that framed the table data; the
  framing is no longer required.
- **Fix: Spark sessions started on Fabric** — Fabric's Livy returns
  session IDs as GUID strings; a numeric ID was required, so every
  accepted session failed with "returned no session ID".
- **Bind Lakehouse…** — a notebook from git whose default Lakehouse is not
  bound (placeholder or logical IDs) is bound in one click to the
  Lakehouse with the name it keeps, found on the connected capacity. The
  binding is per notebook and saved only on this machine
  (`.fabric/local.json`): the notebook file does not change, so no git
  diff. **Unbind** removes it.
- **Fewer repo scans** — `.platform` files are read once and again only
  when one changes.

- **Fix: notebooks from git with placeholder Lakehouse IDs** — Fabric
  stores logical/placeholder IDs (`00000000-…`) for attached Lakehouses in
  git. Those were sent to Livy (HTTP 400). Now such a default shows as
  _not bound_, running says to attach one, and attaching (or Set as
  Default) writes the real IDs over the placeholders, as in the portal.

- **No Capacities view** — the capacity is shown and changed in
  Configuration → Compute (or **Connect to This Capacity** in the Explorer
  side bar's Fabric view).
- **Real capacity names** — taken from Fabric's or Power BI's capacity
  list; when neither shows it (no rights on the capacity), the tooltip
  says why and **Name This Capacity…** sets your own name.
- **Repo's Lakehouse rows are read-only** — attach, set default and
  detach only in the Lakehouses view.
- **Clearer Spark session errors** — a failed session start names the
  Lakehouse and workspace, the HTTP status and Fabric's message; for
  notebooks it adds the likely cause (inaccessible or missing workspace,
  no capacity, missing Lakehouse).

- **Connect = pick a capacity** — Connect to Compute (and the plug button
  in Configuration) only picks the capacity. Code without a Lakehouse of its
  own asks once for a host Lakehouse on that capacity; **Change Host
  Lakehouse…** changes it. Lakehouses lists only the connected capacity's
  workspaces.
- **Fix: notebooks use the signed-in tenant** — a notebook with a default
  Lakehouse no longer fails with "not which tenant" when the repo is
  signed in but no compute is connected.
- **`.platform` opens as JSON**, and notebook tabs show the item folder
  (`publish_metadata.Notebook`) instead of `notebook-content.py`.

- **Repo shows only Fabric items** — folders without items and loose
  files are gone; item folders keep your repo's folder structure. The
  play button runs notebooks and Spark Job Definitions (run loose files
  from the editor or the file Explorer).

- **Notebooks run in their default Lakehouse's own workspace** — a folder
  mapped in `targets.json` no longer changes the workspace a notebook with
  a default Lakehouse runs in; the workspace saved in the notebook's
  metadata is used (the target still decides the tenant).

- **Lakehouses view** — attach Lakehouses to a notebook like the Fabric
  portal: the active (or Repo-selected) notebook's attachments with the
  default starred, and the Lakehouses of every workspace you can access
  with Attach / Set as Default / Detach. Each action writes and
  saves the notebook's metadata; many Lakehouses can be attached.

- **Repo view** — replaces the side bar's remote Workspaces view: your
  Fabric items in your repo's folder structure, shown by display name
  (click a notebook to open it), and a play button that runs notebooks
  and Spark Job Definitions. Right-click an item for **Open .platform** or **Edit Item
  Metadata…** (display name and description).

- **Capacities from your workspaces** — Connect to Compute lists every
  capacity your workspaces run on, even when you cannot list capacities
  yourself (usual for workspace members).
- **No Tenants view** — the tenant is switched from Configuration (or the
  status bar); **Switch Tenant** still finds every tenant on your account.

- **Fabric side bar** — a **Fabric** icon in the Activity Bar, like the
  Databricks extension: **Configuration** (account, tenant and compute,
  with sign in/out, switch tenant, connect/disconnect buttons; **Switch
  Tenant** also finds every tenant on your account), **Repo**,
  **Lakehouses** and **Connections**. The Explorer side bar's **Fabric** view stays.
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
