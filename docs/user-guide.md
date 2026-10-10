# Fabric Connect — User Guide

The reference for every Fabric Connect feature. New here? Follow the
step-by-step [getting-started guide](getting-started.md) first. To install,
see the [installation guide](installation.md); for what the extension
talks to and stores, see [Security and data](security.md).
This reference describes current source; entries under
[Unreleased](../CHANGELOG.md#unreleased) may not be in a released VSIX.

## Concepts

- **Local-first** — your code (notebooks, modules, jobs, queries) lives in
  your repo. Fabric Connect runs it on Fabric and never publishes, deploys,
  creates or changes workspace items.
- **Compute connection** — the capacity this repo runs on (section 5),
  plus a host Lakehouse picked when first needed, saved per machine in
  `.fabric/local.json`.
- **Host Lakehouse** — the Lakehouse a Spark session runs on. Relative
  paths (`Files/…`) and unqualified table names resolve against it.
- **Target** (optional) — a named mapping from a folder in your repo to a Fabric
  workspace. The target's _shape_ (name, item type, tenant) is committed
  to git; the actual workspace ID stays in a local, gitignored file. This
  split exists so nothing ever silently runs against the wrong client's
  workspace.
- **Tenant** — the Entra ID organization you sign in to. Sign-in is
  per-tenant; tokens from one tenant are never used against another.
- **Lakehouse** — the Fabric storage item a notebook attaches to. The
  _default_ Lakehouse (or its machine-local binding) is also the Spark
  endpoint your cells execute against, in its own workspace.
- **Livy session** — the Spark session that runs your cells. Sessions are
  reused across runs and survive VS Code reloads.

## 1. Configure targets (optional)

You don't need targets to get started: the compute connection (section 5)
is enough for code without its own Lakehouse; queries pick their own item
targets. Add folder targets for tenant context, the Manage Lakehouses
panel's workspace, or a Spark Job Definition's bound default Lakehouse.
A notebook default's workspace comes from its metadata or local binding,
**not** the target's workspace. Use local Lakehouse binding for per-machine
dev/test choices without changing notebook metadata.

Create a `.fabric/` directory at your VS Code workspace root with two
files.

**`.fabric/targets.json`** (committed to git) declares folder → target
mappings and each target's shape:

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

- `folders` keys are paths **relative to the workspace root**; `"."` maps
  the root itself. A mapping applies to the folder and everything under
  it; when several mappings match, the **deepest** one wins. Mappings may
  not point outside the workspace folder.
- `tenantId` is your Entra tenant GUID (Entra admin center → Overview).
- `itemType` must currently be `notebook`, the only type registered by the
  extension's target resolver. This target shape can also supply a job's
  workspace; it does not choose the executor for a file.

**`.fabric/local.json`** (local — add it to `.gitignore`, never commit
it) supplies the actual workspace ID for each target:

```json
{
  "targets": {
    "dev": { "workspaceId": "00000000-0000-0000-0000-000000000000" }
  }
}
```

Resolution failures are deliberately loud and specific — every error
names the file, the folder or target involved, and the exact fix, so a
misconfiguration can never silently execute against the wrong workspace.

## 2. Sign in

Sign in once per repo, like a Tabular Editor `.tmuo` file: Fabric Connect
remembers **which Microsoft account and tenant this repo uses** and signs
in with them again, without a prompt, whenever you reopen it.

1. Run **`Fabric: Sign In`** (or click **Fabric: sign in** in the status
   bar).
2. Pick a Microsoft account that is already signed in to VS Code, or
   **Sign in with another account…** to log in in the browser.
3. Pick the tenant. The account's own tenant is listed first, so Enter
   keeps it; for guest access pick a recent tenant, **Find tenants on my
   account…**, or **Enter a tenant ID or domain…**. The status bar shows
   `Fabric: you@contoso.com`.

The account name, VS Code's account ID and the tenant ID are saved under
`"signIn"` in the gitignored `.fabric/local.json`. No token is saved there:
sign-in goes through VS Code's built-in Microsoft authentication provider,
which handles the login, caching and refresh and keeps credentials in VS
Code's secret storage. Every token Fabric Connect asks for is for the
repo's account, so a repo never borrows another account's session.

Click the status bar item (or run the commands) to:

- **Switch Account…** — sign the repo in with a different account.
- **Switch Tenant…** (`Fabric: Switch Tenant`) — for guest access to
  another organization with the same account. Pick a recent tenant,
  **Find tenants on my account…** (lists every tenant your account belongs
  to, by name; the first time, VS Code asks you to allow Azure Resource
  Manager access, used only to read that list), or **Enter a tenant ID or
  domain…** (a GUID, or a verified domain such as
  `contoso.onmicrosoft.com`). The status bar then shows
  `you@contoso.com · Fabrikam`.
- **Sign Out** (`Fabric: Sign Out`) — the repo forgets the sign-in. The
  account stays signed in to VS Code; remove it there from the
  **Accounts** menu.

Different repos can be signed in with different accounts and tenants at
the same time. If the saved account is no longer signed in to VS Code, the
status bar shows a warning and you are asked to sign in when Fabric
Connect next needs a token.

The explorer, API notebooks, `Fabric: Connect to Compute` and query files
use the repo's sign-in; if the repo is not signed in yet, they start the
sign-in first. A compute connection keeps the tenant it was made in, and
notebooks mapped by `.fabric/targets.json` use their target's tenant —
all with the repo's account.

## 3. Open and edit notebooks

Files matching `*.Notebook/notebook-content.ipynb` — the layout Fabric's
git integration produces — open in the Fabric notebook editor
automatically. So do the files Fabric's git integration writes by
default — `*.Notebook/notebook-content.py` (and `.scala`, `.sql`, `.r`) —
which open in the same editor. For any other `.ipynb`, run **`Fabric: Open
File as Fabric Notebook`** and pick the file.

**Open as Text** (the code icon in the notebook toolbar) reopens the same
file as editable text — handy for reviewing or fixing its `# META`
metadata. **Fabric: Open as Notebook** (notebook icon in the editor
title) switches back. In the text view:

- **▷ Run Cell | Run All Above** sit above each `# CELL` block, **Run
  All** on the first line. Cells run on the notebook's own host (its
  default Lakehouse or local binding, else the connected compute), in the
  same Livy session as the notebook editor. Unsaved edits run.
- Output goes to the **Fabric Connect: Run** output channel; `display()`
  and SQL tables also open in **Fabric Results** beside the editor. **Run
  All Above** and **Run All** stop at the first cell that fails.
- Changing Lakehouses (Lakehouses view, Manage Lakehouses) writes the
  file. Save your text edits first: with unsaved changes it refuses, so
  two editors never write one file.

Portal compatibility is a tested guarantee, not an aspiration:

- An unmodified notebook saves **byte-for-byte identical** to what was
  opened.
- Metadata fields the extension doesn't understand survive open → edit →
  save unchanged, so files always reopen cleanly in the Fabric portal.
- In the git source format (`notebook-content.py`), editing one cell
  rewrites only that cell's block, so git diffs stay as small as the edit.
- Cell outputs are transient: they show in the editor but are never
  written into the `.ipynb`, matching what Fabric's git integration
  expects.
- **Reviewing changes before you commit:** clicking a notebook in Source
  Control shows VS Code's cell diff, which hides metadata changes.
  Right-click it → **Fabric: Open Changes as Text** (also the compare icon
  on the row, and in the notebook toolbar) for the raw file diff — HEAD
  against the working tree, read-only, the lines you commit, metadata
  included. A new notebook shows an empty left side.

## 4. Attach Lakehouses

With a Fabric notebook active, run **`Fabric: Manage Lakehouses for
Active Notebook`**. This separate panel lists Lakehouses in the folder's
target workspace, or the connected compute's host workspace if unmapped.
With neither available it reports a target-configuration error; connecting
only a capacity does not supply a panel workspace. Use the **Lakehouses**
side bar below to browse the capacity's workspaces. In the panel you can:

- **Attach** or **detach** Lakehouses (multiple can be attached at once).
- **Set the default** Lakehouse — the one cells execute against.

Changes are ordinary document edits: the notebook is marked dirty, the
change is undoable (`Ctrl+Z`), and saving writes the attachment into the
same notebook metadata the Fabric portal uses. One panel exists per
notebook; invoking the command again reveals the existing panel.

**Lakehouses view.** The Fabric side bar's **Lakehouses** view does the
same as the portal's Lakehouse pane, for the active Fabric notebook or the
notebook selected in **Repo** (named in the view title):

- **Attached to this notebook** — its Lakehouses, the default first with a
  yellow star.
- One group per workspace on the **connected capacity**, each listing its
  Lakehouses when expanded; attached ones are checked. Not connected: a
  **Connect** link instead of a list.
- Inline buttons: **Attach to Notebook** (+), **Set as Default Lakehouse**
  (star) and **Detach from Notebook** (×). Several Lakehouses can be
  attached; the first one attached becomes the default, and the default
  is what Spark SQL and relative paths resolve against.
- **Browse a Lakehouse:** expand a Lakehouse row into its OneLake
  **Tables** (schemas, then tables, in schema-enabled Lakehouses) and
  **Files**, listed one folder at a time. **Preview Table** (inline on a
  table) shows its first rows in Fabric Results; **Preview File** opens
  the file's start as a read-only text document; **Copy OneLake Path**
  copies the `abfss://` path. Read-only, the same as the Fabric explorer.
  A Lakehouse expands right away when the notebook's metadata names its
  workspace (the portal writes it for the default). Others — attached
  Lakehouses, whose metadata holds only IDs, or a default from older
  metadata — expand once their workspace is expanded below.

Each action writes the notebook file's metadata
(`metadata.dependencies.lakehouse`, the same keys the portal writes —
including the default's workspace) and saves it, without opening an
editor when the notebook is not open; when it is open in the notebook
editor, `Ctrl+Z` there undoes the change. Repo lists a notebook's attached Lakehouses under it,
read-only (default starred); change them in the Lakehouses view. Fabric
Connect never creates a Lakehouse.

## 5. Connect to compute

Fabric Connect is local-first: your code lives in your repo, and you
connect the repo once to the Fabric compute it runs on — like attaching a
Databricks Connect project to a cluster. Run **`Fabric: Connect to
Compute`** (or click the Fabric item in the status bar) and pick:

1. the **capacity** — the capacity that is billed. The list holds every
   capacity your workspaces run on (the connected one first). SKU, region
   and state show when you have rights on the capacity itself; otherwise
   it is named `Capacity <id prefix>`. A capacity known to be paused is
   refused.

That is all: no workspace or Lakehouse is asked. The plug button on
Configuration → Compute does the same (and changes the capacity later);
so does **Connect to This Capacity** on a capacity in the Explorer side
bar's Fabric view.

Code without a Lakehouse of its own (a plain `.py`/`.sql` file, a
selection, a table preview, a notebook with no default Lakehouse) also
needs a **host Lakehouse**, because Livy only starts Spark sessions on a
Lakehouse. The first time such code runs you pick one — the Lakehouses of
the capacity's workspaces, grouped by workspace — and optionally an
**Environment**; it is saved and reused. Change it with **Change Host
Lakehouse…** (the pencil on Configuration → Compute → Host Lakehouse, or
`Fabric: Change Host Lakehouse…`). Connecting another capacity drops a
host on the old one.

The connection is saved under `"compute"` in your gitignored
`.fabric/local.json` (the extension warns if that file isn't in your root
`.gitignore`). **`Fabric: Disconnect from Compute`** removes it.

**Notebooks from git: bind the default Lakehouse.** Fabric's git
integration "stores logical identifiers for attached resources in
notebook metadata", and for notebooks in git "the physical ID of the
attached lakehouse … is replaced with a logical ID" ([Notebook source
control and deployment](https://learn.microsoft.com/fabric/data-engineering/notebook-source-control-deployment)).
Such a notebook's `default_lakehouse` (and its workspace) can be
`00000000-0000-0000-0000-000000000000`, which names no Lakehouse Livy can
start a session on. Fabric Connect shows that default as _not bound_
(warning row in the Lakehouses view and under the notebook in Repo;
status bar _Livy: default Lakehouse not bound_) and refuses to run the
notebook instead of guessing. A default whose ID is the `logicalId` of a
`<name>.Lakehouse/.platform` in your repo (a logical ID from git) counts
as not bound too. The quickest fix is **Bind Lakehouse…** (in the
notification shown when a cell fails, on the status bar item, or the link
button on the warning row): it looks for a Lakehouse with the name the
notebook keeps (e.g. `lh_analytics`) in the connected capacity's
workspaces, like Fabric's Lakehouse auto-binding, and asks before binding
(or lets you pick when several workspaces have one).

**Binding is per notebook and stays on your machine.** The binding is
saved under `"lakehouseBindings"` in your gitignored `.fabric/local.json`,
keyed by the notebook's folder (e.g.
`notebooks/consolidated_entity_template.Notebook`). The notebook file is
**not** changed: no git diff, and Fabric's logical IDs stay in place for
its auto-binding in other workspaces. Each notebook is bound on its own;
another notebook with the same placeholder default stays _not bound_
until you bind it. The Lakehouses view shows a bound default with a
green link icon (_bound on this machine_); its unplug button
(**Unbind**) removes the binding. The status bar reads
`… (bound on this machine)`.

To change the notebook itself instead (a choice you commit), use
**Set as Default** in the Lakehouses view. It writes the real
`default_lakehouse`, `default_lakehouse_name` and
`default_lakehouse_workspace_id` into the notebook and removes its local
binding. **Attach** adds a known Lakehouse; it also sets the default when
the existing default is absent or a placeholder. Attaching another Lakehouse
does not replace an already-real default.

The repo's `.platform` files are scanned once and rescanned only when a
`.platform` file is added, changed or deleted.

**When a Spark session cannot start**, the error names the Lakehouse and
workspace, the HTTP status and Fabric's own message. For a notebook it
also checks the Lakehouse's workspace once and says the likely cause: a
workspace that doesn't exist or you can't access (common for notebooks
synced from another workspace — set a new default in the Lakehouses
view), a workspace with no capacity, or a Lakehouse that no longer exists.

**Which Lakehouse runs your code.** A notebook with a default Lakehouse
runs on that Lakehouse, in the workspace saved with it in the notebook's
metadata — the remote workspace a folder is mapped to in `targets.json`
does not change that (it only decides the tenant). If an older notebook's
metadata has no workspace for its default Lakehouse, running it says so:
click **Set as Default** on it in the Lakehouses view to write it.
Anything without its own Lakehouse runs on the connected compute. Relative paths such as `Files/…` and unqualified table
names resolve against that host, so a second status-bar item shows which
one is in effect for the active notebook. When falling back to connected
compute, a folder target in a different tenant is refused. This check does
not apply when the notebook supplies its own default Lakehouse.

**Lakehouses are never created by the extension.** They are
infrastructure: create them in the Fabric portal (or with your
infrastructure tooling). If the connected capacity's accessible workspaces have no
Lakehouse, picking a host fails with guidance to create one in the portal.
Connecting the capacity itself does not require a host. Every write that would change a workspace item —
creating any item (Lakehouses included), updating or deleting items,
definition updates, job runs, git and deployment APIs — is blocked in code
before any request leaves your machine.

## 6. Run cells

Cells run on the notebook's **default Lakehouse** (section 4), or on the
connected compute when it has none (section 5). Supported cell languages and their Livy session
kinds:

| Language | Livy kind |
| -------- | --------- |
| Python   | `pyspark` |
| Scala    | `spark`   |
| SQL      | `sql`     |
| R        | `sparkr`  |

Session behavior:

- **Reuse** — the first run starts a Livy session; later runs reuse it
  instead of paying startup cost again.
- **Queueing** — multiple cell runs against the same session execute in
  order, never racing each other.
- **Cancellation** — stop a running cell with the editor's stop button.
- **Reattachment** — after a VS Code reload, the extension reconnects to
  an existing live session by saved ID rather than always starting a new
  one. Reuse is keyed by tenant, workspace, Lakehouse and optional
  Environment, not by statement language. Notebook/file runs on that same
  target share session state; unrelated targets do not.
- **Expired sessions** — a missing session (HTTP 404) or the specific
  HTTP 400 submission rejection reporting a matching terminal/dead session
  clears that local session reference. The failed code is not replayed.
  Your next run starts a fresh session; rerun setup code to restore
  in-memory variables, imports and temporary views.

To end a session explicitly, run **`Fabric: Stop Livy Session`** with the
notebook active; **`Fabric: Restart Livy Session`** stops it and starts a
fresh one. **`Fabric: Show Livy Sessions`** lists the active sessions on the
host Lakehouse (including ones left running by other windows) and stops the
ones you pick.

**Cell magics.** A cell starting with `%%sql`, `%%pyspark`, `%%spark` or
`%%sparkr` runs as that language, as in the portal. `%%configure` is not
supported over Livy — use an Environment (section 5) instead.

**`%run` is local.** `%run OtherNotebook` (optionally followed by a JSON
object of parameters, e.g. `%run Loader {"run_date": "2026-01-01"}`) is
resolved against the notebooks **in your working tree** (matched by the
`displayName` in their `.platform` file) and inlined before the cell is
sent — never against a copy deployed in a workspace. Parameters are
assigned right after the referenced notebook's parameters cell. Only
Python cells can be inlined; other languages are refused with the cell
named.

**`display()`.** Livy sessions have no `display()`, so the extension
defines one in every session: Spark and pandas DataFrames render as a
table (first 1,000 rows); anything else is printed. `%%sql` results
render as a table too.

**Python (non-Spark) notebooks** run on a Spark session over Livy; a
one-time notice says so, because the runtime can differ slightly from
Fabric's Python-only runtime.

### Execution diagnostics and notebook runtime context

Turn on `fabric-connect.debugLogging` and open **Output → Fabric Connect**
to diagnose a slow cell. Alongside redacted HTTP events, execution lines
use a local sequence number, a phase, milliseconds and an outcome:

```text
[execution 3] phase=statement.wait.user durationMs=42 outcome=ok
```

The same diagnostics cover notebook editor cells, source-text Run Cell /
Run All Above / Run All, files and selections. `host.resolve` includes
host selection; `code.prepare` includes local `%run` expansion;
`modules.prepare` includes local source bundling and any upload.
`queue.user` and `queue.module-setup` measure the extension's session
queue. `session.start` or `session.reattach` measures acquiring the
remote session; `bootstrap.submit` / `bootstrap.wait` measure the display
bootstrap. `statement.submit.*` and `statement.wait.*` separate module
setup from user code. `output.render` measures output processing, including
import guidance, and `total` includes the execution's surrounding work.
Outcomes are `ok`, `error` or `cancelled`.

Phases are **client-observed and nested, not additive**. `session.acquire`
includes waiting for startup/reattachment and bootstrap when necessary;
do not add its child durations to it. A notebook-editor host preflight
gets its own execution number before individual cell runs; a source-text
multi-cell run shares one number. Statement wait includes remote queueing,
execution, HTTP latency and polling, not just Spark execution.

The first cell may pay Spark startup and Environment personalization costs;
later cells reuse the session. In Local module mode, even unchanged
modules still have local preparation and an idempotent remote setup
statement. A six-row table does not make those costs disappear.
`df = spark.sql(...)` creates a DataFrame and can resolve catalog metadata;
an action such as `df.count()` is a separate measurement. Use the
read-only comparison in [testing](testing.md#diagnosing-slow-cells-and-variable-library-errors)
before assigning the delay to the extension, Fabric or the workload.

**Variable Library notebook-state failures.** Local notebook files run
in a Lakehouse Livy session, not as deployed Fabric notebook items.
When Variable Library resolution specifically reports that notebook
state was not found, the extension keeps the failure and original
traceback and adds guidance in both notebook and text-run output.
This may be a notebook-runtime-context limitation or stale Fabric state;
it is not proof that the analytics caller is wrong or that all Variable
Library calls are unsupported over Livy.

Compare the same call in a deployed notebook in the intended workspace.
If it only fails over Livy, report the compatibility difference. If it
also fails in the portal, check notebook state, the library's workspace,
exact case-sensitive name and active value set before investigating the
application caller. No configuration fallback, retry or compatibility
shim is applied. Microsoft documents
[Variable Library utilities](https://learn.microsoft.com/en-us/fabric/data-engineering/notebookutils/notebookutils-variable-library)
for notebooks, with same-workspace access and active-value-set constraints;
the page does not establish support in standalone Livy sessions.
See also [Livy session behavior](https://learn.microsoft.com/en-us/fabric/data-engineering/api-livy-overview)
and [Spark startup considerations](https://learn.microsoft.com/en-us/fabric/data-engineering/spark-compute).

## 7. Run files, selections and Spark jobs

The Databricks Connect workflow: edit locally, run on Fabric.

- **`Fabric: Run File on Fabric`** (▷ in the editor title, or Explorer
  context menu) runs a whole `.py`, `.sql`, `.scala` or `.r` file;
  **`Fabric: Run Selection on Fabric`** runs the selection (or the current
  line). Files run on the connected compute (section 5; a folder
  target in another tenant is refused), in the same session as your
  notebooks on that host. `%run` and cell magics work as in notebooks.
  Output (text, `display()` tables as text) appears in the **Fabric
  Connect: Run** output channel.
- **Your local modules: Local or Remote.** The **Python modules** row in
  the Configuration view (Fabric side bar), the _Modules_ status bar item,
  or **`Fabric: Python Modules (Local or Remote)`** picks where `import` finds your
  packages, saved per repo in `fabric-connect.pythonModules`. The row and
  the status bar always show the same mode:
  - **Remote** — what the Fabric environment has installed, e.g. your
    published wheel. Nothing is staged. This is the default unless
    `fabric-connect.sourceRoots` is set. After switching from Local, run
    **Fabric: Restart Livy Session**: a running session keeps the code it
    already staged.
  - **Local** — your working tree. The source folders are
    `fabric-connect.sourceRoots` if set, else the folders `pyproject.toml`
    names (setuptools `packages.find.where` or `package-dir`, Hatch wheel
    `packages`, Poetry `packages.from`), else `src`.

  When an import fails on Remote for a package that is also in your repo
  (e.g. `cannot import name 'entity' from 'analytics'`, because the
  installed wheel is older), the error says so and how to switch.

  On Local, every Python run — notebook cells included — first stages
  the `.py` files under those folders to the session: they are zipped,
  uploaded to the host Lakehouse's scratch folder `Files/.fabric-connect/`,
  added with `addPyFile`, and stale copies are dropped from `sys.modules`.
  `import mypkg` then loads your working tree's code. Unchanged sources are
  not re-uploaded. Stop/restart attempts best-effort cleanup of this
  window's staged modules, not deletion of every window's files.

- **Spark Job Definitions.** Right-click a `*.SparkJobDefinition` folder →
  **`Fabric: Run Spark Job Definition`**. Settings (arguments, main class,
  libraries, default Lakehouse, Environment) come from
  `SparkJobDefinitionV1.json`. A bound default Lakehouse ID uses the folder
  target's workspace because job settings do not name a workspace;
  without a suitable target, it fails rather than guessing. With no bound
  default it uses the compute host. The main file comes from the folder's `Main/`
  (or next to the settings file) and libraries from `Libs/` — local files
  only. They are staged to the scratch folder and submitted as a Livy
  batch, and deleted when the job ends (kept, with a note in the output
  channel, if Fabric Connect loses track of a job that may still be running);
  state changes (and driver logs, where the service provides them) stream to
  the output channel, and cancelling the progress notification cancels the
  batch. If Fabric refuses the cancel, an error says the job may still be
  running (and its staged files are kept); cancel it from the Fabric
  monitoring hub. A batch Fabric no longer knows (HTTP 404) counts as
  cancelled. Nothing is published to
  the Spark Job Definition
  item.

Staging writes only to `Files/.fabric-connect/` of the host Lakehouse; any
other OneLake write is blocked in code.

## 8. Query files: KQL, DAX, GraphQL

Keep queries as files in your repo and run them against existing items:

| File                | Runs against     | How                                 |
| ------------------- | ---------------- | ----------------------------------- |
| `.kql` / `.csl`     | a KQL database   | Kusto query endpoint (queries only) |
| `.dax`              | a semantic model | Power BI `executeQueries`           |
| `.graphql` / `.gql` | a GraphQL API    | the API's GraphQL endpoint          |

Run **`Fabric: Run Query File`** (▷ in the editor title). The first run
asks which workspace and item the file runs against and remembers it under
`"queryBindings"` in `.fabric/local.json`; **`Fabric: Change Query
Target`** re-picks. With a selection, only the selection runs. Results open
in a **Fabric Results** panel as tables. A GraphQL file can pass variables
on a comment line: `# variables: {"first": 10}`.

T-SQL is intentionally not included: copy a Lakehouse's or Warehouse's SQL
connection string from the Fabric explorer and use the Microsoft `mssql`
extension. Kusto control commands (`.drop`, `.set`, …) are blocked; only
the query endpoint is allowed, and a Kusto token is only ever sent to a
`*.kusto.fabric.microsoft.com` host.

## 9. Fabric explorer (read-only)

**Fabric side bar.** Click the **Fabric** icon in the Activity Bar (next to
Explorer and Source Control), the way the Databricks extension works. Its
views:

- **Configuration** — the account and tenant the repo signs in with, and
  its compute (capacity; host Lakehouse and Environment once picked). The
  inline buttons sign in, sign out, switch tenant, connect or disconnect.
  **Switch Tenant** lists the current, recently used and compute tenants,
  **Find tenants on my account…** and **Enter tenant ID or domain…**;
  every view follows the tenant you pick.
- **Capacity name** — Configuration → Compute → Capacity shows the
  capacity's real name. It comes from Fabric's capacity list, else Power
  BI's. Both only give it to people with rights on the capacity itself;
  otherwise it reads `Capacity <id prefix>`, the tooltip says why (and,
  if listing failed, the HTTP status and service message), and the pencil
  (**Name This Capacity…**) lets you give it a name, saved in your
  gitignored `.fabric/local.json`. A real name found later replaces the
  placeholder automatically.
- **Repo** — your repo's Fabric items, inside the folders that lead to
  them on disk. A folder holding a `.platform` file is a Fabric item,
  shown by its display name and type, with its own files under it and
  `.platform` hidden (a folder with a broken `.platform` shows as a plain
  folder). Folders without items and loose files are not shown — run
  those from the editor or the file Explorer. Folders hidden by
  `files.exclude` (plain or `**/name` patterns), `.git` and
  `node_modules` are left out. Click a **Notebook** to open it in the
  Fabric notebook editor. The play button (or right-click → **Run on
  Fabric**) runs a notebook (all cells) or a Spark Job Definition. The
  view title shows the connected compute (or _no compute_). The tree
  follows file changes.
  Right-click an item → **Open .platform** to see the file, or **Edit
  Item Metadata…** to change its display name and description: the edit
  keeps every other field, the indentation and the line endings, can be
  undone in the editor, and is saved. The folder keeps its name; Fabric
  uses the display name on the next git sync.
- **Lakehouses** — attach Lakehouses to a notebook and pick its default;
  see [Attach Lakehouses](#4-attach-lakehouses).
- **Connections** — collapsed by default.

**Explorer side bar.** The **Fabric** view in VS Code's Explorer side bar
stays, with the same tree in one place. It browses the tenant the
repo is signed in to (or, before it signs in, the compute connection's
tenant): **Capacities** (SKU, region, state) →
workspaces on each → items grouped by type; **Workspaces without a
capacity**; and the tenant's **Connections**. Lakehouses expand into their
OneLake `Files` and `Tables`.

Right-click actions:

- **Copy ID / Name / OneLake Path** (`abfss://…`).
- **Copy SQL Connection String** (Lakehouse, Warehouse, SQL endpoint) —
  paste it into the Microsoft `mssql` extension for T-SQL.
- **Preview Table** — the first 100 rows, read on the connected compute's
  Spark session and shown in the Fabric Results panel.
- **Preview File** — the first 64 KB of a text file, opened as an untitled
  document.
- **Pull into Repo…** — writes the item's definition into
  `<name>.<Type>/` in a folder you pick (the layout Fabric's git
  integration uses, with a `.platform` file). This is a one-time clone:
  nothing syncs back, and an existing folder is never overwritten.
- **Open in Fabric** — the workspace in the Fabric portal.

**GUID hover.** Hover a GUID in any file (notebook metadata, `.platform`,
`local.json`) to see which workspace, item or capacity it is — from what
the explorer has listed, or from your repo's `.platform` logicalIds.

The explorer never changes a workspace: every call is a read.

## 10. API notebooks (`.fabnb`)

For exploring the Fabric REST API, create a notebook with **`Fabric: New
API Notebook`** (or any `*.fabnb` file). Cells:

```
%api
GET /workspaces
```

```
%cmd
SET API_PATH = /workspaces/$(_cells[-1].value[0].id)
```

```
GET ./items
```

- A cell is a request line `METHOD path` (the `%api` line is optional),
  optionally followed by a JSON body. Paths are relative to the API root
  (`/…`), to the `API_PATH` variable (`./…`), or full
  `https://api.fabric.microsoft.com/v1/…` URLs — no other host.
- `%cmd` cells set (`SET NAME = value`) and show (`SET NAME`) variables.
- `$(NAME)` inserts a variable; `$(_cells[-1].value[0].id)` reads a value
  from a previous cell's output (`[-1]` = the cell above, `[2]` = the third
  cell).
- List responses show as a table, with the JSON alongside.

Requests go through the same client as everything else, so the local-first
policy applies: GETs work, and writes that would change a workspace are
refused before anything is sent.

## Files Fabric Connect reads and writes

| File                                                     | Written by                                                                                             | Commit it?                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------- |
| `.fabric/targets.json`                                   | you                                                                                                    | Yes                          |
| `.fabric/local.json`                                     | you and the extension (`"signIn"`, `"compute"`, `"targets"`, `"queryBindings"`, `"lakehouseBindings"`) | **No** — add to `.gitignore` |
| `*.Notebook/notebook-content.*`                          | you (saved in Fabric's format)                                                                         | Yes                          |
| `<name>.<Type>/` from Pull into Repo                     | the extension, once, when you ask                                                                      | Yes                          |
| `.vscode/settings.json` (`sourceRoots`, `pythonModules`) | you and the module-mode command                                                                        | Optional                     |

In OneLake, the extension writes only to `Files/.fabric-connect/` in the
host Lakehouse (staged modules and job files). Cleanup removes only this
window's staged modules (on stop/restart) or a finished job's files, and is
best effort. Remote idle expiry does
not guarantee cleanup; see [Security and data](security.md).

## Command reference

| Command                                         | What it does                                                   |
| ----------------------------------------------- | -------------------------------------------------------------- |
| `Fabric: Sign In`                               | Sign this repo in with a Microsoft account (remembered)        |
| `Fabric: Switch Tenant`                         | Sign this repo in to another tenant with the same account      |
| `Fabric: Sign Out`                              | This repo forgets its sign-in                                  |
| `Fabric: Account…`                              | Account menu (the status bar item)                             |
| `Fabric: Name This Capacity…`                   | Save a local name when the real capacity name is not visible   |
| `Fabric: Connect to This Capacity`              | Connect from a capacity row in the Explorer Fabric view        |
| `Fabric: Open File as Fabric Notebook`          | Open any `.ipynb` with the Fabric notebook editor              |
| `Fabric: Manage Lakehouses for Active Notebook` | Browse, attach/detach Lakehouses; set the default              |
| `Fabric: Bind Notebook's Default Lakehouse…`    | Bind the default locally without editing notebook metadata     |
| `Fabric: Unbind Notebook's Default Lakehouse`   | Remove this notebook's local binding                           |
| `Fabric: Open as Notebook`                      | Switch a source-format notebook back from text                 |
| `Fabric: Open as Text`                          | Reopen a notebook as editable text                             |
| `Fabric: Open Changes as Text`                  | Show the HEAD/working-tree text diff including metadata        |
| `Fabric: Run All Cells`                         | Run all source-text notebook cells                             |
| `Fabric: Run Cell`                              | Run a source-text cell from its code lens                      |
| `Fabric: Run All Above`                         | Run preceding source-text code cells and the current cell      |
| `Fabric: Python Modules (Local or Remote)`      | Select working-tree or installed Python packages               |
| `Fabric: Stop Livy Session`                     | Stop the active notebook's Livy session                        |
| `Fabric: Restart Livy Session`                  | Stop and immediately start a fresh session                     |
| `Fabric: Show Livy Sessions`                    | List active sessions on the host Lakehouse; stop selected ones |
| `Fabric: Run File on Fabric`                    | Run the active (or selected) Python/SQL/Scala/R file           |
| `Fabric: Run Selection on Fabric`               | Run the selection or current line                              |
| `Fabric: Run Spark Job Definition`              | Run a local `*.SparkJobDefinition` folder as a Livy batch      |
| `Fabric: Run Query File`                        | Run a `.kql` / `.dax` / `.graphql` file against its bound item |
| `Fabric: Change Query Target`                   | Re-pick the item a query file runs against                     |
| `Fabric: New API Notebook`                      | Open a new `.fabnb` REST API notebook                          |
| `Fabric: Connect to Compute`                    | Pick the capacity to run on                                    |
| `Fabric: Change Host Lakehouse…`                | Pick the host Lakehouse (→ Environment) on that capacity       |
| `Fabric: Disconnect from Compute`               | Remove the saved compute connection                            |

View actions use shorter labels: Repo has **Refresh**, **Run on Fabric**,
**Open .platform** and **Edit Item Metadata…**; Lakehouses has **Refresh**,
**Attach to Notebook**, **Set as Default Lakehouse** and **Detach from Notebook**.
Explorer actions are **Refresh**, **Copy ID**, **Copy Name**,
**Copy OneLake Path**, **Copy SQL Connection String**, **Preview Table**,
**Preview File**, **Pull into Repo…** and **Open in Fabric** (category **Fabric**).
Their context menus pass the selected tree node; they are not standalone
commands requiring a fabricated ID.

## Settings

| Setting                        | Default | Effect                                                                                                                                    |
| ------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `fabric-connect.debugLogging`  | `false` | Log redacted Fabric API requests/responses (retries included) to the **Fabric Connect** output channel                                    |
| `fabric-connect.sourceRoots`   | `[]`    | Explicit workspace-relative Python source folders; in Local mode an empty list uses supported `pyproject.toml` roots, else existing `src` |
| `fabric-connect.pythonModules` | `auto`  | Resource-scoped `auto`, `local` or `remote`; `auto` selects Local only when `sourceRoots` is non-empty, otherwise Remote                  |

HTTP paths are redacted and execution diagnostics use fixed labels, local
sequence numbers, timings and outcomes. Runtime errors and ordinary cell
output are not sanitized; review them before sharing.

## Troubleshooting

Every error message states what failed, why, which entity was involved,
and the next step — so the message itself is usually the fix. Common
cases:

- **"No Fabric target configuration found…"** — create
  `.fabric/targets.json` at the workspace root (section 1).
- **"Folder '…' is not mapped to any target…"** — add the notebook's
  folder under `"folders"` in `.fabric/targets.json`.
- **Missing workspace ID for a target** — add the target's `workspaceId`
  to your local `.fabric/local.json` (section 1); this file is per-machine
  and never committed.
- **"Sign-in to tenant … was cancelled or consent was declined."** — run
  `Fabric: Sign In` again and complete the Microsoft prompt.
- **"… has no Lakehouse of its own and this repo is not connected to
  Fabric compute"** — run `Fabric: Connect to Compute`, or attach a default
  Lakehouse with `Fabric: Manage Lakehouses for Active Notebook`.
- **"Blocked '…' request: Fabric Connect is local-first…"** — the
  extension refused a write that would change a workspace. This is by
  design; see [Architecture](architecture.md#preserved-design-decisions).
- **"Capacity '…' is Inactive, so it cannot run Spark."** — resume the
  capacity in the Azure portal (or pick another), then connect again.
- **"Workspace '…' has no Lakehouse to host Spark sessions."** — create a
  Lakehouse in the Fabric portal; Fabric Connect never creates items.
- **HTTP 400 with "is in a terminal state" and "Livy state : dead"** —
  Fabric has ended the execution session, not reported a missing `.fabric`
  mapping. For the recognized service message naming the current session
  and workspace, the extension forgets only that session and preserves
  the original failure. Rerun setup code, then the failed code: the next
  run creates a fresh session without restarting VS Code. Unrelated
  HTTP 400 errors do not reset sessions. The rejection alone does not
  explain why Fabric ended the session; retain the correlation ID if
  repeated termination requires service-side investigation.
- **"Refusing to run '…': its folder's target … belongs to a different
  tenant"** — connect to compute in the target's tenant, or move the file.
- **"Cannot expand '%run …'"** — the named notebook must exist in the repo
  with that `displayName` in its `.platform` file, exactly once, and the
  inlined cells must be Python.
- **`display(df)` prints text instead of a table** — the session's
  `display()` setup did not run (e.g. the session was started elsewhere);
  run **Fabric: Restart Livy Session**.
- **`import mypkg` imports an old version or fails** — on Remote you get
  the Fabric environment's installed copy: run **Fabric: Python Modules (Local or Remote)**
  and pick Local to use your working tree. On Local, check the source
  folder is the one that _contains_ the package (e.g. `src`, not
  `src/mypkg`), then run the cell again.
- **A consent prompt appears on the first KQL or DAX query** — expected:
  Kusto and Power BI use permissions separate from the Fabric API.
- **API calls failing or behaving oddly** — enable
  `fabric-connect.debugLogging` and check the **Fabric Connect** output
  channel for the redacted request/response trail.
