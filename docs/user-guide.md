# Fabric Connect — User Guide

The reference for every Fabric Connect feature. New here? Follow the
step-by-step [getting-started guide](getting-started.md) first. To install,
see the [installation guide](installation.md); for what the extension
talks to and stores, see [Security and data](security.md).

## Concepts

- **Local-first** — your code (notebooks, modules, jobs, queries) lives in
  your repo. Fabric Connect runs it on Fabric and never publishes, deploys,
  creates or changes workspace items.
- **Compute connection** — the capacity, workspace, host Lakehouse and
  optional Environment this repo runs on (section 5), saved per machine in
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
  _default_ Lakehouse is also the Spark endpoint your cells execute
  against.
- **Livy session** — the Spark session that runs your cells. Sessions are
  reused across runs and survive VS Code reloads.

## 1. Configure targets (optional)

You don't need targets to get started: the compute connection (section 5)
is enough to run notebooks, files, jobs and queries. Add targets when a
notebook's default Lakehouse should resolve in a specific workspace per
machine or environment (dev/test/prod), or to make sure a folder is only
ever run in one tenant.

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

## 4. Attach Lakehouses

With a Fabric notebook active, run **`Fabric: Manage Lakehouses for
Active Notebook`**. A panel opens listing the Lakehouses in the
notebook's target workspace, where you can:

- **Attach** or **detach** Lakehouses (multiple can be attached at once).
- **Set the default** Lakehouse — the one cells execute against.

Changes are ordinary document edits: the notebook is marked dirty, the
change is undoable (`Ctrl+Z`), and saving writes the attachment into the
same notebook metadata the Fabric portal uses. One panel exists per
notebook; invoking the command again reveals the existing panel.

## 5. Connect to compute

Fabric Connect is local-first: your code lives in your repo, and you
connect the repo once to the Fabric compute it runs on — like attaching a
Databricks Connect project to a cluster. Run **`Fabric: Connect to
Compute`** (or click the Fabric item in the status bar) and pick:

1. the **capacity** (shown with SKU and region) — the capacity that is
   billed; a paused capacity is refused;
2. a **workspace** assigned to that capacity;
3. an existing **host Lakehouse** for Spark sessions;
4. optionally an **Environment** (libraries and Spark settings); otherwise
   the workspace starter pool is used.

The connection is saved under `"compute"` in your gitignored
`.fabric/local.json` (the extension warns if that file isn't in your root
`.gitignore`). **`Fabric: Disconnect from Compute`** removes it.

**Which Lakehouse runs your code.** A notebook with a default Lakehouse
runs on that Lakehouse (in its target's workspace, or its own workspace if
the folder isn't mapped). Anything without its own Lakehouse runs on the
connected compute. Relative paths such as `Files/…` and unqualified table
names resolve against that host, so a second status-bar item shows which
one is in effect for the active notebook. If a folder's target and the
connected compute are in different tenants, running is refused.

**Lakehouses are never created by the extension.** They are
infrastructure: create them in the Fabric portal (or with your
infrastructure tooling). If the chosen workspace has no Lakehouse, Connect
to Compute stops and says so. Every write that would change a workspace —
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

Session behavior mirrors the Fabric portal:

- **Reuse** — the first run starts a Livy session; later runs reuse it
  instead of paying startup cost again.
- **Queueing** — multiple cell runs against the same session execute in
  order, never racing each other.
- **Cancellation** — stop a running cell with the editor's stop button.
- **Reattachment** — after a VS Code reload, the extension reconnects to
  the existing session by ID rather than starting a fresh one, so no
  orphaned sessions burn workspace capacity.

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
- **Your local modules.** Set **`fabric-connect.sourceRoots`** (e.g.
  `["src"]`) and every Python run — notebook cells included — first stages
  the `.py` files under those folders to the session: they are zipped,
  uploaded to the host Lakehouse's scratch folder `Files/.fabric-connect/`,
  added with `addPyFile`, and stale copies are dropped from `sys.modules`.
  `import mypkg` then loads your working tree's code. Unchanged sources are
  not re-uploaded. The scratch folder is deleted when you stop or restart
  the session.
- **Spark Job Definitions.** Right-click a `*.SparkJobDefinition` folder →
  **`Fabric: Run Spark Job Definition`**. Settings (arguments, main class,
  libraries, default Lakehouse, Environment) come from
  `SparkJobDefinitionV1.json`; the main file from the folder's `Main/`
  (or next to the settings file) and libraries from `Libs/` — local files
  only. They are staged to the scratch folder and submitted as a Livy
  batch; state changes (and driver logs, where the service provides them)
  stream to the output channel, and cancelling the progress notification
  cancels the batch. Nothing is published to the Spark Job Definition
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
  its compute (capacity, workspace, host Lakehouse, Environment). The
  inline buttons sign in, sign out, switch tenant, connect or disconnect.
- **Tenants** — the tenants you can use, the current one checked. Click
  one to sign the repo in to it (same account); every view follows. The
  list shows the current, recently used and compute tenants; **Find
  tenants on my account…** (or the search button) adds every tenant your
  account belongs to. The first time, VS Code asks you to allow Azure
  Resource Manager access. The organization button enters a tenant ID or
  domain.
- **Capacities** — SKU, region and state; each expands to its workspaces.
- **Workspaces** — every workspace, with the SKU and capacity it runs on
  (and the state when the capacity is paused), _no capacity_, or _unknown
  capacity_ when you cannot see the capacity itself (or capacities cannot
  be listed at all; the workspaces still show).
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

| File                                                   | Written by                                                          | Commit it?                   |
| ------------------------------------------------------ | ------------------------------------------------------------------- | ---------------------------- |
| `.fabric/targets.json`                                 | you                                                                 | Yes                          |
| `.fabric/local.json`                                   | you and the extension (`"compute"`, `"targets"`, `"queryBindings"`) | **No** — add to `.gitignore` |
| `*.Notebook/notebook-content.*`                        | you (saved in Fabric's format)                                      | Yes                          |
| `<name>.<Type>/` from Pull into Repo                   | the extension, once, when you ask                                   | Yes                          |
| `.vscode/settings.json` (`fabric-connect.sourceRoots`) | you                                                                 | Optional                     |

In OneLake, the extension writes only to `Files/.fabric-connect/` in the
host Lakehouse (staged modules and job files), and deletes it when the
session stops.

## Command reference

| Command                                         | What it does                                                   |
| ----------------------------------------------- | -------------------------------------------------------------- |
| `Fabric: Sign In`                               | Sign this repo in with a Microsoft account (remembered)        |
| `Fabric: Switch Tenant`                         | Sign this repo in to another tenant with the same account      |
| `Fabric: Sign Out`                              | This repo forgets its sign-in                                  |
| `Fabric: Account…`                              | Account menu (the status bar item)                             |
| `Fabric: Open File as Fabric Notebook`          | Open any `.ipynb` with the Fabric notebook editor              |
| `Fabric: Manage Lakehouses for Active Notebook` | Browse, attach/detach Lakehouses; set the default              |
| `Fabric: Stop Livy Session`                     | Stop the active notebook's Livy session                        |
| `Fabric: Restart Livy Session`                  | Stop and immediately start a fresh session                     |
| `Fabric: Show Livy Sessions`                    | List active sessions on the host Lakehouse; stop selected ones |
| `Fabric: Run File on Fabric`                    | Run the active (or selected) Python/SQL/Scala/R file           |
| `Fabric: Run Selection on Fabric`               | Run the selection or current line                              |
| `Fabric: Run Spark Job Definition`              | Run a local `*.SparkJobDefinition` folder as a Livy batch      |
| `Fabric: Run Query File`                        | Run a `.kql` / `.dax` / `.graphql` file against its bound item |
| `Fabric: Change Query Target`                   | Re-pick the item a query file runs against                     |
| `Fabric: New API Notebook`                      | Open a new `.fabnb` REST API notebook                          |
| `Fabric: Connect to Compute`                    | Pick capacity → workspace → host Lakehouse (→ Environment)     |
| `Fabric: Disconnect from Compute`               | Remove the saved compute connection                            |

## Settings

| Setting                       | Default | Effect                                                                                                 |
| ----------------------------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `fabric-connect.debugLogging` | `false` | Log redacted Fabric API requests/responses (retries included) to the **Fabric Connect** output channel |
| `fabric-connect.sourceRoots`  | `[]`    | Workspace-relative folders whose Python modules are staged to the session before Python code runs      |

Logs are always redacted: tokens, tenant IDs, workspace IDs, and cell
contents never appear in them.

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
  design; see `docs/plan-local-first.md`.
- **"Capacity '…' is Inactive, so it cannot run Spark."** — resume the
  capacity in the Azure portal (or pick another), then connect again.
- **"Workspace '…' has no Lakehouse to host Spark sessions."** — create a
  Lakehouse in the Fabric portal; Fabric Connect never creates items.
- **"Refusing to run '…': its folder's target … belongs to a different
  tenant"** — connect to compute in the target's tenant, or move the file.
- **"Cannot expand '%run …'"** — the named notebook must exist in the repo
  with that `displayName` in its `.platform` file, exactly once, and the
  inlined cells must be Python.
- **`display(df)` prints text instead of a table** — the session's
  `display()` setup did not run (e.g. the session was started elsewhere);
  run **Fabric: Restart Livy Session**.
- **`import mypkg` imports an old version or fails** — check
  `fabric-connect.sourceRoots` points at the folder that _contains_ the
  package (e.g. `src`, not `src/mypkg`), then run the cell again.
- **A consent prompt appears on the first KQL or DAX query** — expected:
  Kusto and Power BI use permissions separate from the Fabric API.
- **API calls failing or behaving oddly** — enable
  `fabric-connect.debugLogging` and check the **Fabric Connect** output
  channel for the redacted request/response trail.
