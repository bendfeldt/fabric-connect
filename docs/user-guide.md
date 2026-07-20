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

## 5. Run cells

Cell execution requires a **default Lakehouse** (section 4) — it provides
the Spark endpoint. Supported cell languages and their Livy session
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
- **"Cannot run this cell: the notebook has no default Lakehouse
  attached…"** — run `Fabric: Manage Lakehouses for Active Notebook` and
  set a default Lakehouse.
- **API calls failing or behaving oddly** — enable
  `fabric-connect.debugLogging` and check the **Fabric Connect** output
  channel for the redacted request/response trail.
