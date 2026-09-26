# Fabric Connect — User Guide

This guide covers day-to-day use of the extension: configuring targets,
signing in, editing Fabric notebooks, attaching Lakehouses, and running
cells over Livy. For getting the extension into VS Code in the first
place, see the [installation guide](installation.md).

## Concepts

- **Target** — a named mapping from a folder in your repo to a Fabric
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

## 1. Configure targets

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

Run **`Fabric: Sign In`** from the Command Palette and enter the tenant
GUID (the prompt remembers the last one you used). Sign-in goes through
VS Code's built-in Microsoft authentication provider: it handles the
interactive login, caching, and refresh, and persists credentials in VS
Code's SecretStorage. The extension never writes tokens to disk or logs
them.

You can be signed in to multiple tenants at once; each notebook uses the
tenant declared by its target.

## 3. Open and edit notebooks

Files matching `*.Notebook/notebook-content.ipynb` — the layout Fabric's
git integration produces — open in the Fabric notebook editor
automatically. For any other `.ipynb`, run **`Fabric: Open File as Fabric
Notebook`** and pick the file.

Portal compatibility is a tested guarantee, not an aspiration:

- An unmodified notebook saves **byte-for-byte identical** to what was
  opened.
- Metadata fields the extension doesn't understand survive open → edit →
  save unchanged, so files always reopen cleanly in the Fabric portal.
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
3. the **host Lakehouse** for Spark sessions — or _Create a Lakehouse…_;
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

**Creating a Lakehouse.** Lakehouses are infrastructure: Fabric Connect
creates one only from _Create a Lakehouse…_, and only after a confirmation
dialog naming the Lakehouse, the workspace and the capacity. It never
updates or deletes Lakehouses, and every other write to a workspace (item
create/update/delete, definition updates, job runs, git and deployment
APIs) is blocked in code before any request leaves your machine.

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
notebook active.

## Command reference

| Command                                         | What it does                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| `Fabric: Sign In`                               | Interactive Entra ID sign-in to a tenant (remembers the last GUID) |
| `Fabric: Open File as Fabric Notebook`          | Open any `.ipynb` with the Fabric notebook editor                  |
| `Fabric: Manage Lakehouses for Active Notebook` | Browse, attach/detach Lakehouses; set the default                  |
| `Fabric: Stop Livy Session`                     | Stop the active notebook's Livy session                            |
| `Fabric: Connect to Compute`                    | Pick capacity → workspace → host Lakehouse (→ Environment)         |
| `Fabric: Disconnect from Compute`               | Remove the saved compute connection                                |

## Settings

| Setting                       | Default | Effect                                                                                                 |
| ----------------------------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `fabric-connect.debugLogging` | `false` | Log redacted Fabric API requests/responses (retries included) to the **Fabric Connect** output channel |

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
- **API calls failing or behaving oddly** — enable
  `fabric-connect.debugLogging` and check the **Fabric Connect** output
  channel for the redacted request/response trail.
