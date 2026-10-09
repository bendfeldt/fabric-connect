# Getting started with Fabric Connect

This guide takes you from a fresh install to running notebooks, your own
Python modules, Spark jobs and queries on Microsoft Fabric — all from a git
repo in VS Code. Spark startup depends on capacity, runtime and Environment.
This guide describes the current source; check
[Unreleased](../CHANGELOG.md#unreleased) when using a released VSIX.

Fabric Connect is **local-first**: your code lives in your repo, and the
extension only _runs_ it on Fabric. It never publishes, deploys, creates or
changes items in a workspace. If you want the details of what it talks to
and what it stores, see [Security and data](security.md). For every option
of every feature, see the [user guide](user-guide.md).

---

## Before you start

You need:

- **VS Code 1.93 or later.**
- **A Microsoft Entra ID account** that can use Microsoft Fabric. You sign
  in with the account and pick the tenant (your own is the default).
- **A Fabric capacity** you can run Spark on, with **a workspace assigned
  to it** that contains **at least one Lakehouse**. Fabric Connect never
  creates Lakehouses; if the workspace has none, create one in the Fabric
  portal (New item → Lakehouse) — a small "scratch" Lakehouse is enough.
- **Contributor** (or higher) access to that workspace, so you can start
  Spark sessions in it.
- Optional: a repo connected to a workspace through **Fabric git
  integration**, if you want to work on existing notebooks.

## 1. Install the extension

Download the latest `fabric-connect-<version>.vsix` from the
[GitHub Releases](https://github.com/bendfeldt/fabric-connect/releases/latest)
page and install it:

```sh
code --install-extension fabric-connect-<version>.vsix
```

or Extensions view → `···` → **Install from VSIX…**. The
[installation guide](installation.md) covers building from source too.

After installing, open **Help → Welcome → Walkthroughs → Get started with
Fabric Connect**: it walks through the same steps as this guide, with
buttons that run each command.

## 2. Open your repo and keep local settings out of git

Open the folder you work in (**File → Open Folder**). A repo that uses
Fabric git integration typically looks like this — Fabric Connect works
with this layout as-is:

```
my-fabric-repo/
├── .gitignore
├── .fabric/                  ← created by Fabric Connect; local.json is per machine
├── notebooks/
│   ├── Load Sales.Notebook/
│   │   ├── .platform
│   │   └── notebook-content.py
│   └── Utils.Notebook/
│       ├── .platform
│       └── notebook-content.py
├── jobs/
│   └── Nightly.SparkJobDefinition/
│       ├── .platform
│       ├── SparkJobDefinitionV1.json
│       └── Main/nightly.py
├── src/
│   └── salesutils/           ← your own Python package
│       ├── __init__.py
│       └── cleaning.py
└── queries/
    ├── errors.kql
    └── revenue.dax
```

Add this line to the repo's **root `.gitignore`** before anything else:

```gitignore
.fabric/local.json
```

`.fabric/local.json` holds the capacity (and host Lakehouse) IDs you
connect to. They identify your (or your client's) environment and must not
be committed. Fabric Connect warns you if the line is missing.

## 3. Sign in

Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) → **Fabric: Sign In**
(or click **Fabric: sign in** in the status bar):

1. Pick your Microsoft account, or **Sign in with another account…** —
   VS Code opens the Microsoft sign-in in your browser.
2. Pick the tenant: your account's home tenant is first; guest access can
   use a recent tenant, **Find tenants on my account…**, or a tenant ID/domain.
3. The repo is signed in to that tenant. The status bar shows
   `Fabric: you@contoso.com`.

That's it, for this repo, for good: like a Tabular Editor `.tmuo` file,
the account and tenant are saved in your gitignored `.fabric/local.json`,
and reopening the repo signs you in again without a prompt. Tokens stay
in VS Code's secure storage; Fabric Connect never writes them to disk or
logs.

> Working for several organizations? Each repo keeps its own sign-in, so
> client A's repo and client B's repo can use different accounts side by
> side. For **guest** access with the same account, click the status bar
> item → **Switch Tenant…** → **Find tenants on my account…** (lists your
> tenants by name; VS Code asks once to allow Azure Resource Manager
> access, used only for that list) or enter a tenant ID or domain.

## 4. Connect the repo to Fabric compute

This is the Databricks Connect moment: you choose, once, where your code
runs.

1. Run **Fabric: Connect to Compute** (or click **Fabric: connect compute**
   in the status bar).
2. Sign in if the repo isn't signed in yet; compute is connected in the
   repo's tenant.
3. Pick the **capacity**. Each entry shows its SKU (e.g. `F8`), region and
   state; a paused capacity is refused — resume it in Azure first. That is
   all you pick here.

The first time you run code without a Lakehouse of its own (a plain `.py`
file, or a notebook with no default Lakehouse), you also pick a **host
Lakehouse** on that capacity — Spark sessions run there, and relative
paths such as `Files/raw/sales.csv` resolve against it — and optionally an
**Environment**. It is saved and reused; **Fabric: Change Host
Lakehouse…** changes it.

The status bar now shows something like
`Fabric: dev-capacity F8` (plus `· Sandbox / scratch` once a host
Lakehouse is picked). The choice is saved under
`"compute"` in `.fabric/local.json`; run **Fabric: Disconnect from
Compute** to remove it.

## 5. Run your first notebook

1. Open `notebooks/Load Sales.Notebook/notebook-content.py`. It opens in the
   **Fabric notebook editor** (Fabric's git format; `.ipynb` works too).
   If it opens as plain text, right-click the tab → **Reopen Editor With…**
   → **Fabric Notebook (git source format)**.
2. Select the **Fabric Livy** kernel (top right) if VS Code asks.
3. Add a cell and run it:

   ```python
   df = spark.range(5).withColumnRenamed("id", "n")
   display(df)
   ```

   The first run starts a Spark session; later runs reuse it.
   `display(df)` renders a table (first 1,000 rows).

   If a git-synced notebook shows _default Lakehouse not bound_, click
   **Bind Lakehouse…** to pick the corresponding physical Lakehouse. The
   binding stays in `.fabric/local.json`; the notebook is unchanged.
   Without a default, pick a host Lakehouse when prompted.

4. Look at the second status-bar item, e.g. `Livy: scratch (connected
compute)`. It tells you which Lakehouse the notebook runs on:
   - a notebook with a **default Lakehouse** or local binding runs there,
     in that Lakehouse's workspace;
   - a notebook without one runs on the connected compute's host.

   Use the Fabric side bar's **Lakehouses** view to attach, detach or change
   the default. These actions edit and save notebook metadata, unlike
   machine-local binding. The separate **Manage Lakehouses** panel is
   described in the [user guide](user-guide.md#4-attach-lakehouses).

5. Try the notebook features you know from the portal:

   ```python
   %run Utils {"region": "EMEA"}
   ```

   runs the `Utils` notebook **from this repo** (not a deployed copy), with
   `region` set after its parameters cell. Cells starting with `%%sql`,
   `%%pyspark`, `%%spark` or `%%sparkr` switch language:

   ```sql
   %%sql
   SELECT COUNT(*) AS rows FROM sales
   ```

6. Save. Fabric Connect writes the same file format Fabric uses; an
   unmodified notebook is saved byte-for-byte, and editing one cell changes
   only that cell in the git diff.

Session commands: **Fabric: Restart Livy Session** (fresh session),
**Fabric: Stop Livy Session**, and **Fabric: Show Livy Sessions** (lists
active sessions on the host Lakehouse — including ones another window left
running — and stops the ones you pick). Sessions also stop on their own
when idle.

## 6. Use your own Python package

The point of local-first: edit `src/salesutils/cleaning.py` in VS Code and
use it on Fabric without publishing a wheel or deploying an item. The
extension stages the source files for you.

1. Run **Fabric: Python Modules (Local or Remote)** and pick **Local**.
   Source folders come from `fabric-connect.sourceRoots`, else supported
   `pyproject.toml` layouts, else an existing `src` directory. Set
   `"fabric-connect.sourceRoots": ["src"]` when explicit roots are needed.
   In `auto` mode, non-empty source roots select Local; otherwise Remote
   is used, even when `pyproject.toml` exists.
2. In a notebook cell:

   ```python
   from salesutils.cleaning import normalize_regions
   display(normalize_regions(spark.table("sales")))
   ```

3. Change `cleaning.py`, save, and run the cell again — the new code is
   used.

Before Python code runs, Fabric Connect zips the `.py` files under your
source roots, uploads the zip to `Files/.fabric-connect/` in the host
Lakehouse, adds it to the session and reloads your packages only when the
code changed. Stop/restart through the extension attempts to delete this
window's scratch directory; cleanup is best effort. This is the only
OneLake prefix the extension itself may write. After switching to Remote,
restart the session to discard already-staged imports.

## 7. Run files and selections

Open any `.py`, `.sql`, `.scala` or `.r` file:

- **▷ Fabric: Run File on Fabric** (editor title, or right-click the file
  in the Explorer) runs the whole file.
- Select some lines → right-click → **Fabric: Run Selection on Fabric**
  (or the current line if nothing is selected).

Output — printed text, and `display()` / `%%sql` results as text tables —
appears in the **Fabric Connect: Run** output channel. Files run on the
connected compute. Runs share a session when tenant, workspace, Lakehouse and
optional Environment match, regardless of statement language. Python
variables/imports remain in that session's Python interpreter; another
language does not automatically expose them.

## 8. Run a Spark Job Definition from local files

Right-click `jobs/Nightly.SparkJobDefinition` in the Explorer → **Fabric:
Run Spark Job Definition**.

- Settings (arguments, main class, libraries, default Lakehouse,
  Environment) come from `SparkJobDefinitionV1.json`.
- A bound default Lakehouse in those settings needs a folder target for
  its workspace. Without a bound default, the job uses the compute host.
  See [optional targets](#12-optional-map-folders-to-workspaces-dev--test--prod).
- The **main file comes from the repo**: `Main/<file>`, or next to the
  settings file. Library files come from `Libs/`. Libraries referenced by
  `abfss://` URI are passed through unchanged.
- The files are staged to the scratch folder and submitted as a Livy
  batch. State changes (and driver logs, where Fabric provides them) stream
  to the output channel; cancel the progress notification to cancel the
  batch.

Nothing is published to the Spark Job Definition item in the workspace.

## 9. Run queries: KQL, DAX, GraphQL

Keep queries next to your code:

```kusto
// queries/errors.kql
AppEvents
| where Level == "Error"
| summarize count() by bin(Timestamp, 1h)
```

```dax
// queries/revenue.dax
EVALUATE SUMMARIZECOLUMNS('Date'[Year], "Revenue", [Total Revenue])
```

```graphql
# queries/customers.graphql
# variables: {"first": 10}
query ($first: Int) {
  customers(first: $first) {
    items {
      id
      name
    }
  }
}
```

Open a file and click **▷ Fabric: Run Query File**. The first time, pick
the workspace and the item (KQL database, semantic model or GraphQL API);
the choice is remembered per file in `.fabric/local.json`. **Fabric:
Change Query Target** picks again. Results open in the **Fabric Results**
panel. With a selection, only the selection runs.

For **T-SQL** (Warehouse, SQL analytics endpoint), use the Microsoft
**mssql** extension: right-click the item in the Fabric view → **Copy SQL
Connection String**.

> The first KQL or DAX query may show a Microsoft consent prompt: those
> services use separate permissions from the Fabric API.

## 10. Explore Fabric and pull items into the repo

Click the **Fabric** icon in the Activity Bar. Its **Configuration** view
shows what the repo signs in as and its compute (switch the tenant from
its Tenant row), **Repo** shows your working tree and runs it on the
connected compute, **Lakehouses** attaches Lakehouses to a notebook, and
**Connections** lists connections. The **Fabric** view in the Explorer
side bar browses everything:

- **Capacities** → workspaces → items grouped by type;
- **Workspaces without a capacity**;
- **Connections**.

Lakehouses expand into their OneLake **Files** and **Tables**. Right-click:

- **Preview Table** — first 100 rows, read on your connected compute;
- **Preview File** — the start of a text file;
- **Copy ID / Name / OneLake Path / SQL Connection String**;
- **Open in Fabric** — the workspace in the portal;
- **Pull into Repo…** — writes the item's definition into
  `<name>.<Type>/` in a folder you pick. It is a one-time copy: nothing
  syncs back, and an existing folder is never overwritten.

Hover any GUID in an editor (notebook metadata, `.platform`, `local.json`)
to see which workspace, item or capacity it is.

## 11. Explore the Fabric REST API

Run **Fabric: New API Notebook**. Cells call the Fabric REST API:

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

List responses show as a table next to the JSON. The shared write policy
blocks workspace item creation, update and deletion; explicitly allowlisted
operations can run. This is not a data sandbox: user code and GraphQL
mutations can change data with your permissions. Save as `.fabnb` to keep it.

## 12. Optional: map folders to workspaces (dev / test / prod)

Compute is enough for code without its own Lakehouse. A valid notebook
default can also run with only sign-in, without connecting compute.
Add **targets** to assign folders a tenant, supply a workspace for the
Manage Lakehouses panel, or resolve a Spark Job Definition's bound default.
Targets do **not** relocate a notebook's default Lakehouse.

`.fabric/targets.json` (committed) says which folders belong to which
target and tenant:

```json
{
  "folders": { "notebooks": "sales", "jobs": "sales" },
  "targets": {
    "sales": {
      "itemType": "notebook",
      "tenantId": "00000000-0000-0000-0000-000000000000"
    }
  }
}
```

`.fabric/local.json` (not committed; the same file that holds `"compute"`)
says which workspace that target means on this machine:

```json
{
  "targets": {
    "sales": { "workspaceId": "11111111-1111-1111-1111-111111111111" }
  },
  "compute": { "…": "written by Connect to Compute" }
}
```

A notebook's default runs in `default_lakehouse_workspace_id` from its
metadata, or in its local binding's workspace. The target supplies tenant
context, not a replacement workspace. Use **Bind Lakehouse…** for
machine-local dev/test Lakehouse choices without a notebook git diff.

For an SJD with a bound `defaultLakehouseArtifactId`, the target workspace
is used because its settings do not carry a workspace. `notebook` is the
only registered target `itemType`; it is not a file execution-mode setting.
If code uses the compute host and the folder target has a different
tenant, execution is refused rather than borrowing another tenant's host.

## Your daily loop

1. Open the repo — the status bar shows the connected compute.
2. Edit notebooks, modules and queries locally; commit with git as usual.
3. Run cells, files, jobs and queries on Fabric from the editor.
4. Stop the session when you're done (or let it time out).
5. Getting code into a workspace stays your team's existing process
   (Fabric git integration, deployment pipelines, CI) — Fabric Connect
   deliberately never does it.

## When something goes wrong

Every error says what failed, why, what it concerns and what to do next —
read it first. The most common ones:

| Message starts with                                     | Do this                                                           |
| ------------------------------------------------------- | ----------------------------------------------------------------- |
| "… has no Lakehouse of its own and … not connected"     | Run **Fabric: Connect to Compute**, or attach a default Lakehouse |
| "Capacity '…' is Inactive"                              | Resume the capacity in the Azure portal                           |
| "Workspace '…' has no Lakehouse to host Spark sessions" | Create a Lakehouse in the Fabric portal, then connect again       |
| "Failed to start a Livy session …"                      | Check capacity state and your Contributor access to the workspace |
| "Refusing to run '…' … different tenant"                | Connect to compute in the tenant of the folder's target           |
| "Cannot expand '%run …'"                                | Check the notebook's `displayName` in its `.platform` file        |
| "Blocked '…' request: Fabric Connect is local-first"    | Expected: the extension never changes workspaces                  |

More in the [user guide's troubleshooting section](user-guide.md#troubleshooting).
Set `fabric-connect.debugLogging` to `true` to see a redacted trace of
every API call in the **Fabric Connect** output channel.
