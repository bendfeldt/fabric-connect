# Test and validate an installed build

A checklist for validating a Fabric Connect `.vsix` once it is installed:
every feature, what to do, and what you should see. Work through it after
installing a new release, before rolling a build out to a team, or when
something looks wrong. This checklist describes current source, including
[Unreleased](../CHANGELOG.md#unreleased) features. Record the source commit for
same-version local builds. Manual steps are not evidence that they have already
been executed.

- **Quick smoke test:** sections 0–4.
- **Full validation:** all applicable sections.

These steps deliberately start/stop sessions, change test-repo configuration
and create/drop test data. Run them only with authorization in a disposable
test environment. For local native tests with no live service, see
[Development](development.md#commands).

Tick each box as you go. If a result differs from **Expect**, see
[Reporting a problem](#reporting-a-problem).

## 0. Prepare a test environment

Use a **test or dev tenant and workspace**, never production. The tests
only read, run code in Spark sessions and write test data you create; the
extension itself never creates, changes or deletes workspace items.

You need:

- VS Code 1.93 or later, with the `.vsix` installed
  (`code --install-extension fabric-connect-<version>.vsix`).
- An Entra account with access to Fabric in the test tenant. For the
  tenant tests, ideally access to a **second tenant** too (a guest account
  is enough).
- A **running** Fabric capacity (F2 or larger, or a trial) and a
  **workspace** on it, where you are Contributor or higher, containing:
  - a **Lakehouse** (required), e.g. `fc_validation`;
  - optional, for the query tests: an **Eventhouse/KQL database**, a
    **semantic model**, a **GraphQL API**, and a **Warehouse** (for the SQL
    connection string).
- Optional: a **capacity whose workspaces have no Lakehouse** (for a negative test in §3).

### Test repo

Create an empty folder, open it in VS Code (**File → Open Folder**), and
add these files. The `.platform` files are required for **Repo** discovery
and `%run` name resolution, not just the item-folder suffixes. The example
logical IDs below are synthetic local identifiers, not remote Lakehouse IDs.

`.gitignore`

```gitignore
.fabric/local.json
```

`notebooks/Validate.Notebook/.platform`

```json
{
  "metadata": { "type": "Notebook", "displayName": "Validate" },
  "config": {
    "version": "2.0",
    "logicalId": "11111111-1111-4111-8111-111111111111"
  }
}
```

`notebooks/Helper.Notebook/.platform`

```json
{
  "metadata": { "type": "Notebook", "displayName": "Helper" },
  "config": {
    "version": "2.0",
    "logicalId": "22222222-2222-4222-8222-222222222222"
  }
}
```

`jobs/Hello.SparkJobDefinition/.platform`

```json
{
  "metadata": { "type": "SparkJobDefinition", "displayName": "Hello" },
  "config": {
    "version": "2.0",
    "logicalId": "33333333-3333-4333-8333-333333333333"
  }
}
```

`notebooks/Validate.Notebook/notebook-content.py`

```python
# Fabric notebook source

# METADATA ********************

# META {
# META   "kernel_info": {
# META     "name": "synapse_pyspark"
# META   }
# META }

# CELL ********************

df = spark.range(5).withColumnRenamed("id", "n")
display(df)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
```

`notebooks/Helper.Notebook/notebook-content.py`

```python
# Fabric notebook source

# METADATA ********************

# META {
# META   "kernel_info": {
# META     "name": "synapse_pyspark"
# META   }
# META }

# PARAMETERS CELL ********************

region = "default"

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

print(f"helper ran with region={region}")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
```

`src/fcvalidate/__init__.py`

```python
def greet(name):
    return f"hello {name}"
```

`scripts/hello.py`

```python
print("run-file ok", spark.range(3).count())
```

`jobs/Hello.SparkJobDefinition/SparkJobDefinitionV1.json`

```json
{
  "executableFile": null,
  "defaultLakehouseArtifactId": "",
  "mainClass": "",
  "additionalLakehouseIds": [],
  "retryPolicy": null,
  "commandLineArguments": "",
  "additionalLibraryUris": [],
  "language": "Python",
  "environmentArtifactId": null
}
```

`jobs/Hello.SparkJobDefinition/Main/hello_job.py`

```python
from pyspark.sql import SparkSession

spark = SparkSession.builder.getOrCreate()
print("spark job ok", spark.range(10).count())
```

Query files (only for the items you have): `queries/test.kql`
(`print ok = 1`), `queries/test.dax` (`EVALUATE ROW("ok", 1)`), and
`queries/test.graphql` with a query valid for your GraphQL API.

Commit the repo (`git init && git add -A && git commit -m "chore(test): initialize validation fixtures"`) so you
can check with `git diff` that saving changes nothing unexpected.

## 1. Install and activation

- [ ] **Extensions** view → Fabric Connect shows the version you installed.
- [ ] **Help → Welcome → Walkthroughs → Get started with Fabric Connect**
      opens, and each step's link runs its command.
- [ ] From the walkthrough, click **Sign In** and press Escape.
      **Expect:** the step stays unticked.
- [ ] Click **Sign In** again and finish it. **Expect:** the step ticks
      and the walkthrough moves to **Connect this repo to Fabric compute**;
      finishing that one ticks it and moves to the notebooks step. After
      **Developer: Reload Window** both steps are still ticked.
- [ ] The **Fabric** view is in the Explorer side bar. Before you sign in
      it shows _Sign in to browse Fabric_; clicking it starts the sign-in.
- [ ] A **Fabric** icon is in the Activity Bar, next to Explorer and
      Source Control. Click it. **Expect:** the views **Configuration**,
      **Repo**, **Lakehouses** and **Connections** (collapsed); no
      **Tenants** or **Capacities** view. Before you sign in, Configuration shows a
      **Sign In** button.
- [ ] The status bar shows **Fabric: sign in**.
- [ ] **View → Output → Fabric Connect** exists.

## 2. Sign in (remembered per repo)

The per-repo sign-in needs a version newer than 1.1.7; older
versions ask you to type a tenant GUID instead.

- [ ] Run **Fabric: Sign In**. **Expect:** a list titled _Sign in to
      Fabric_ with the Microsoft accounts already signed in to VS Code and
      **Sign in with another account…** (with no accounts, the browser
      sign-in opens straight away).
- [ ] Pick your account (or sign in with it in the browser). **Expect:**
      a list titled _Sign in to Fabric — pick the tenant_ with your home
      tenant marked current, **Find tenants on my account…** and **Enter a
      tenant ID or domain…**.
- [ ] Press Enter on the home tenant. **Expect:** _Signed in as you@… to
      <tenant>…_; the status bar shows **Fabric: you@…**; the Fabric view
      browses your home tenant's capacities and workspaces.
- [ ] Sign In again and press Escape on the tenant list. **Expect:**
      nothing changes; the repo keeps its previous sign-in.
- [ ] Open `.fabric/local.json`. **Expect:** a `"signIn"` section with
      `account`, `accountId` and `tenantId` — and no token.
- [ ] **Developer: Reload Window**. **Expect:** no sign-in prompt; the
      status bar shows the same account and the Fabric view loads.
- [ ] Click the status bar item. **Expect:** **Switch Account…**, **Switch
      Tenant…** and **Sign Out**.
- [ ] _(Second tenant)_ **Switch Tenant…** → **Find tenants on my
      account…**. **Expect:** the first time, a consent or sign-in prompt;
      then every tenant your account belongs to, with name, domain and ID.
      Pick the other tenant. **Expect:** the status bar shows
      **Fabric: you@… · <tenant name>**, and the Fabric view switches to
      that tenant.
- [ ] **Switch Tenant…** → **Enter a tenant ID or domain…** →
      `not a tenant`. **Expect:** a validation message; you cannot submit
      it.
- [ ] **Switch Tenant…** → **Enter a tenant ID or domain…** → your test
      tenant's domain (e.g. `contoso.onmicrosoft.com`), or its GUID.
      **Expect:** the repo is signed in to the test tenant again; the
      tenant you used before is listed at the top next time, marked
      **current** when it is the active one.
- [ ] _(Second account)_ Open another folder in a new window, sign it in
      with a different account. **Expect:** each window keeps its own
      account in its own status bar.
- [ ] **Sign Out** from the status bar menu. **Expect:** _This repo no
      longer signs in as you@…_; `"signIn"` is gone from
      `.fabric/local.json`; the status bar shows **Fabric: sign in**. Your
      account is still listed in VS Code's **Accounts** menu. Sign in
      again before continuing.
- [ ] Sign out of the account in VS Code's **Accounts** menu, with the
      repo still signed in. **Expect:** the status bar shows a warning
      icon with the account name; running something asks you to sign in.
      Sign back in.
- [ ] Press **Esc** at each step. **Expect:** nothing changes and no error.

## 3. Connect to compute

- [ ] Run **Fabric: Connect to Compute**. **Expect:** no tenant prompt
      (the repo's sign-in is used); capacities with SKU, region and state.
- [ ] Pick the capacity. **Expect:** no workspace or Lakehouse prompt; the
      status bar shows the capacity; `.fabric/local.json` has a `"compute"`
      section with only tenant and capacity; Configuration → Compute →
      Host Lakehouse says _picked when needed_.
- [ ] Run a plain `.py` file (**Run File on Fabric**). **Expect:** a pick
      of the capacity's Lakehouses grouped by workspace (and an Environment
      when the workspace has any); pick `fc_validation`. The file runs; the
      status bar and Configuration show the host. Run it again. **Expect:**
      no prompt.
- [ ] Configuration → Host Lakehouse → pencil (**Change Host
      Lakehouse…**). **Expect:** the same pick; the new host is saved.
- [ ] Connect another capacity. **Expect:** a message that the old host was
      dropped; Host Lakehouse is _picked when needed_ again.
- [ ] On a capacity whose workspaces have no Lakehouse, run a `.py` file.
      **Expect:** an error saying to create a Lakehouse in the Fabric
      portal — _Fabric Connect never creates items_. Nothing is created.
- [ ] `git status`. **Expect:** `.fabric/local.json` is **not** listed
      (it is gitignored).
- [ ] Remove the `.gitignore` line, run **Connect to Compute** again.
      **Expect:** a warning that `.fabric/local.json` does not appear in
      your root `.gitignore`. Put the line back.

## 4. Notebooks

- [ ] Open `notebooks/Validate.Notebook/notebook-content.py`. **Expect:**
      the notebook editor.
- [ ] Select the **Fabric Livy** kernel and run the cell. **Expect:** after
      session startup, a table with `n` = 0…4. The second status
      bar item names the Lakehouse the notebook runs on.
- [ ] Run it again. **Expect:** the existing session is reused; no
      new host-selection prompt. This is not a latency threshold.
- [ ] Save without editing, then `git diff`. **Expect:** no changes.
- [ ] Add a cell: `df = spark.sql("SELECT 1 AS A")`, then `print(df)` and
      `display(df)`. **Expect:** `DataFrame[A: int]`, then a table with
      column `A` and one row — no `FABRIC_CONNECT_DISPLAY` text.
- [ ] **Open as Text** (code icon in the notebook toolbar). **Expect:**
      the plain file with **▷ Run Cell | Run All Above** above each cell
      and **Run All** on the first line; the status bar still names the
      Lakehouse.
- [ ] **Run Cell** on the `display(df)` cell. **Expect:** the cell's
      header and rows as text in _Fabric Connect: Run_, and a table in
      _Fabric Results_ — no _Missing viewType_ error.
- [ ] Add a failing cell (`1/0`) between two cells, then **Run All**.
      **Expect:** it stops at the failing cell; the next cell does not run.
      Remove the failing cell before continuing.
- [ ] Edit a cell without saving; Lakehouses view → **+** on a Lakehouse.
      **Expect:** _…has unsaved changes in the text editor… Save the file_.
      Save and retry. **Expect:** attached; the text shows the new `# META`
      lines.
- [ ] **Fabric: Open as Notebook** (editor title). **Expect:** back in the
      notebook editor.
- [ ] Edit a cell, save, Source Control → right-click the notebook →
      **Open Changes as Text**. **Expect:** a read-only text diff, _(HEAD ↔
      working tree, text)_, with exactly the changed lines. Save another
      edit. **Expect:** the diff updates.
- [ ] Add a new notebook folder (not committed) and do the same.
      **Expect:** an empty left side, no error.
- [ ] Edit the cell (e.g. `spark.range(7)`), save, `git diff`. **Expect:**
      only that line changed.
- [ ] Add a cell: `%run Helper {"region": "EMEA"}`. **Expect:**
      `helper ran with region=EMEA` (the local `Helper` notebook ran, not a
      deployed copy).
- [ ] Add a cell to create test data:
      `spark.range(3).write.mode("overwrite").saveAsTable("fc_validation_t")`,
      then a cell `%%sql` + `SELECT COUNT(*) AS n FROM fc_validation_t`.
      **Expect:** a table with `n` = 3.
- [ ] Run a slow cell (`import time; time.sleep(120)`) and press the
      cell's **Stop** button. **Expect:** the cell stops; the next cell
      runs normally.
- [ ] **Fabric: Manage Lakehouses for Active Notebook** → attach
      `fc_validation`, make it the default, save. **Expect:** the status bar
      shows that Lakehouse; `git diff` shows only the notebook's metadata
      changing, as the portal writes it.
- [ ] Connect a capacity, then click a notebook in **Repo**. **Expect:**
      the **Lakehouses** view title names it; _Attached to this notebook_
      lists its Lakehouses (default starred); each workspace on the
      connected capacity — and only those — is a group. Disconnect.
      **Expect:** _Connect to a capacity to see its Lakehouses_.
- [ ] Lakehouses → expand `fc_validation` → **Tables**. **Expect:** its
      tables (`fc_validation_t`), or schemas then tables. The inline
      preview on a table shows its rows in _Fabric Results_.
- [ ] Expand **Files**, then a folder. **Expect:** its files; **Preview
      File** on one shows its first bytes; **Copy OneLake Path** copies an
      `abfss://…` path. The Fabric explorer's Lakehouse tree is unchanged.
- [ ] Lakehouses → expand a workspace → **+** on `fc_validation` on a
      notebook with none attached. **Expect:** the Lakehouse is attached
      and default and the file is saved (no editor opens when the notebook
      is not open), and `git diff`
      shows `known_lakehouses`, `default_lakehouse`,
      `default_lakehouse_name` and `default_lakehouse_workspace_id` only.
- [ ] Attach a second Lakehouse (from another workspace on the capacity),
      then **star** it. **Expect:** it becomes the default with its own
      workspace ID; the first stays attached. Run `%%sql SELECT 1` and an
      unqualified table name. **Expect:** they resolve against the new
      default.
- [ ] In a folder mapped in `.fabric/targets.json` to another workspace,
      give a notebook a default Lakehouse from a different workspace and
      run a cell. **Expect:** the status bar names that Lakehouse
      (_notebook's default Lakehouse_) and the session runs in its
      workspace, not the target's.
- [ ] Repo → a notebook's Lakehouse rows → right-click. **Expect:** no
      Attach / Set as Default / Detach (tooltip: manage in the Lakehouses
      view).
- [ ] Give a notebook a default Lakehouse in a workspace you can't access
      (or edit `default_lakehouse_workspace_id` to a random GUID) and run a
      cell. **Expect:** the error names the Lakehouse and workspace, the
      HTTP status and service message, and _Likely cause: … workspace that
      does not exist or that you cannot access_.
- [ ] Open a git-synced notebook whose `default_lakehouse` is
      `00000000-0000-0000-0000-000000000000`. **Expect:** Lakehouses and
      Repo show the default as _not bound_; the status bar says _Livy:
      default Lakehouse not bound_; running a cell gives the "not bound"
      error (no HTTP 400). Attach a Lakehouse. **Expect:** `git diff` shows
      only `default_lakehouse`, `default_lakehouse_name`,
      `default_lakehouse_workspace_id` (and `known_lakehouses`) changing
      from zeros to real IDs; the cell then runs on that Lakehouse.
- [ ] Run a cell of a notebook whose default is not bound (e.g.
      `fc_validation`). **Expect:** a notification **Bind Lakehouse…**;
      click it. **Expect:** "Bind … to Lakehouse `fc_validation` in
      workspace …?" (or a pick when several workspaces have one); after
      **Bind**, this notebook has a local binding, its metadata remains
      unchanged and the next explicit cell run uses the bound Lakehouse.
      Clicking the status bar's _Livy: default Lakehouse not bound_ does
      the same.
- [ ] After **Bind Lakehouse…**, `git status`. **Expect:** the notebook is
      unchanged; `.fabric/local.json` has `"lakehouseBindings"` with the
      notebook's folder. The Lakehouses view shows the default with a green
      link (_bound on this machine_); a second notebook with the same
      placeholder default is still _not bound_. **Unbind** brings back
      _not bound_. **Set as Default** on a Lakehouse instead writes the
      notebook and removes its local binding.
- [ ] Open and refresh Lakehouses and Repo several times. **Expect:** no
      repeated repo-wide scans (no lag); adding a `.platform` file shows up.
- [ ] After binding, run a cell `%%sql` followed by `SELECT 1`.
      **Expect:** the session starts and the result shows as a table — no
      "returned no session ID" error.
- [ ] **×** on the default. **Expect:** it is detached, no default is left,
      and a message says so. Repo shows the notebook's attachments under
      it and follows each change.
- [ ] **Fabric: Show Livy Sessions**. **Expect:** your active session.
- [ ] **Fabric: Restart Livy Session**, then run a cell. **Expect:** a new
      session starts.
- [ ] **Fabric: Stop Livy Session**. **Expect:** the session stops (also
      gone from **Show Livy Sessions**).
- [ ] If a real session expires and the service returns HTTP 404 or the
      recognized matching HTTP 400 terminal/dead-session rejection:
      **Expect:** the original failure remains visible, no failed code
      is replayed and the matching local session reference is discarded.
      Run setup code explicitly, then rerun the failed cell without
      restarting VS Code. **Expect:** a fresh session; old variables and
      temporary views are not retained. Record this step as untested if
      the service condition was not observed; do not manufacture it by
      changing production capacity or authentication.
- [ ] Optional: open a portal-exported `.ipynb` renamed to
      `X.Notebook/notebook-content.ipynb`, run a cell, save; `git diff`
      shows only what you changed.

## 5. Your own Python modules

- [ ] In a repo with a `pyproject.toml` (`where = ["src"]`) whose package
      is also installed, older, in the Fabric environment, and
      `fabric-connect.sourceRoots` unset: **Expect:** the status bar shows
      _Modules: Remote_. Import a name only the local copy has.
      **Expect:** the ImportError plus _'pkg' is also in your repo
      (src/pkg) … pick Local_.
- [ ] Configuration view. **Expect:** a **Python modules** row,
      _Remote_, next to Compute.
- [ ] Click the row (or its pencil) → **Local**. **Expect:** the row shows
      _Local · pkg_ and the status bar _Modules: Local · pkg_ at the same
      time; `.vscode/settings.json` has
      `"fabric-connect.pythonModules": "local"`. Run the import again.
      **Expect:** it succeeds; `print(pkg.__file__)` points into a
      `modules-….zip`.
- [ ] Click the status bar item → **Remote**. **Expect:** the row
      follows. Set `"fabric-connect.pythonModules": "local"` by hand in
      `.vscode/settings.json`. **Expect:** both follow.
- [ ] Switch back to **Remote**, run **Fabric: Restart Livy Session**,
      and run it again. **Expect:** the ImportError again (installed copy;
      a running session keeps already-staged code until it restarts).
- [ ] Settings → `fabric-connect.sourceRoots` → add `src`, then select
      **Local** explicitly. **Expect:** a previously selected `remote`
      mode is not silently overridden by setting source roots.
- [ ] In a notebook cell:
      `from fcvalidate import greet; print(greet("fabric"))`.
      **Expect:** `hello fabric`.
- [ ] Change `greet` to return `f"hi {name}"`, save, run the cell again.
      **Expect:** `hi fabric`, with no restart.
- [ ] In the Fabric view, open the Lakehouse → **Files**. **Expect:** a
      window-specific directory under `.fabric-connect` while the session
      runs. After **Fabric: Stop Livy Session**, refresh. **Expect:** this
      window's directory is removed if cleanup succeeds; other windows'
      directories may remain. Cleanup failures can leave staged files.

## 6. Run files and selections

- [ ] Open `scripts/hello.py` → **▷ Fabric: Run File on Fabric** (editor
      title). **Expect:** `run-file ok 3` in the **Fabric Connect: Run**
      output channel.
- [ ] Select the `print(...)` line → right-click → **Fabric: Run Selection
      on Fabric**. **Expect:** the same output.

## 7. Spark Job Definition

- [ ] Right-click `jobs/Hello.SparkJobDefinition` → **Fabric: Run Spark Job
      Definition**. **Expect:** batch states stream to the output channel
      and the job succeeds (`spark job ok 10` where driver logs are shown).
- [ ] Run it again and cancel the progress notification. **Expect:** the
      batch is cancelled.
- [ ] Check the workspace in the portal. **Expect:** no Spark Job
      Definition item was created or changed.

## 8. Query files

For each item you have:

- [ ] Open `queries/test.kql` → **▷ Fabric: Run Query File** → pick the
      workspace and KQL database. **Expect:** a result table (`ok` = 1) in
      the **Fabric Results** panel (a consent prompt may appear the first
      time).
- [ ] Run it again. **Expect:** no picker (the choice is remembered in
      `.fabric/local.json`).
- [ ] **Fabric: Change Query Target**. **Expect:** the picker again.
- [ ] `queries/test.dax` against the semantic model. **Expect:** `ok` = 1.
- [ ] `queries/test.graphql` against the GraphQL API. **Expect:** your
      query's data as a table.
- [ ] Select part of a query and run. **Expect:** only the selection runs.

## 9. Fabric explorer

- [ ] Expand **Capacities → your capacity → workspace → items**.
      **Expect:** items grouped by type.
- [ ] Configuration → Compute → Capacity. **Expect:** the capacity's real
      name. _(As a workspace member without capacity rights)_ if it reads
      `Capacity <id prefix>`, the tooltip says why; the pencil (**Name
      This Capacity…**) sets a name that shows in Configuration and the
      status bar, and `.fabric/local.json` gains `"capacityLabel"`.
- [ ] Explorer side bar → Fabric → Capacities → right-click a capacity →
      **Connect to This Capacity**. **Expect:** no further prompts;
      Configuration and the status bar show it.
- [ ] **Fabric: Connect to Compute**. **Expect:** the connected capacity is
      first in the list, marked _connected_.
- [ ] Repo → right-click a notebook → **Open .platform**. **Expect:** JSON
      highlighting (language mode _JSON_), same text as in the repo.
- [ ] Open a notebook from Repo. **Expect:** the tab reads
      `<name>.Notebook`, not `notebook-content.py`.
- [ ] Signed in, with no compute connected, run a cell of a notebook that
      has a default Lakehouse. **Expect:** it runs (no "which tenant"
      error).
- [ ] Expand the Lakehouse → **Tables** → right-click `fc_validation_t` →
      **Preview Table**. **Expect:** its rows in the Results panel.
- [ ] Upload a small `.csv` to the Lakehouse **Files** in the portal, then
      right-click it → **Preview File**. **Expect:** its first lines.
- [ ] Right-click an item → **Copy ID**, **Copy Name**, **Copy OneLake
      Path**; on a Warehouse **Copy SQL Connection String**. **Expect:** the
      values on the clipboard.
- [ ] **Open in Fabric**. **Expect:** the workspace opens in the browser.
- [ ] Right-click a notebook → **Pull into Repo…** → pick `notebooks/`.
      **Expect:** a `<name>.Notebook/` folder with its files. Pull it again.
      **Expect:** refused — an existing folder is never overwritten.
- [ ] Hover the `logicalId` GUID in a pulled `.platform` file, or an ID in
      `.fabric/local.json`. **Expect:** a hover naming the item, workspace
      or capacity.
- [ ] **Connections** lists the tenant's connections.
- [ ] Fabric side bar → **Configuration**. **Expect:** Account, Tenant and
      Compute rows. Compute expands to Capacity (name · SKU), Workspace,
      Lakehouse and, when set, Environment. The inline buttons sign in,
      sign out, switch tenant, connect and disconnect; each change shows
      up in the view straight away.
- [ ] Configuration → Tenant → **Switch Tenant** → **Find tenants on my
      account…**. **Expect:** every tenant on your account. Pick another
      tenant. **Expect:** the status bar and Configuration show it, and
      the Explorer Fabric tree and capacity-dependent listings reload for it.
- [ ] **Repo**. **Expect:** only folders that contain Fabric items, in
      your repo's structure; no loose files and no folders without items
      (e.g. `docs/`); `<name>.Notebook` folders show as the notebook's
      display name with _Notebook_, their own files under them and no
      `.platform` child; the title shows the connected compute. Click a notebook. **Expect:** it opens in the
      Fabric notebook editor.
- [ ] Repo → play button on a notebook. **Expect:** it opens and all cells
      run on Fabric. Play on a `.SparkJobDefinition` item. **Expect:** the
      job runs. No play button on files.
- [ ] Open a folder with no `.platform` files. **Expect:** Repo says _No
      Fabric items in this folder_.
- [ ] Create, rename and delete a file in the repo. **Expect:** Repo
      follows within a second.
- [ ] Repo → right-click a notebook → **Open .platform**. **Expect:** the
      file opens as text. **Edit Item Metadata…** → new name, empty
      description. **Expect:** the item shows the new name, `.platform`
      has the new `displayName` and no `description`, every other line is
      unchanged (`git diff`), and the folder keeps its name. Ctrl+Z in the
      open `.platform` undoes it.

## 10. API notebooks

- [ ] **Fabric: New API Notebook** → a cell `GET /workspaces` → run.
      **Expect:** JSON plus a table of your workspaces.
- [ ] A cell with `POST /workspaces` on the first line and
      `{"displayName": "x"}` on the second. **Expect:** _Blocked 'POST' request: Fabric Connect is local-first
      and never creates, updates, deletes or runs items in a workspace._
      No workspace is created.
- [ ] Save as `test.fabnb`, close and reopen. **Expect:** the cells are
      kept.

## 11. Safety checks

- [ ] In the portal, compare the workspace's item list with the start of
      the test. **Expect:** no items created, changed or deleted by the
      extension (only your test table's data changed).
- [ ] Settings → `fabric-connect.debugLogging` on, run a cell and a query,
      then open **Output → Fabric Connect**. **Expect:** lines like
      `→ GET /workspaces/<redacted-id>/items`; no tokens, no GUIDs in paths,
      no cell code. Turn the setting off again.
- [ ] _(Optional, targets)_ Add `.fabric/targets.json` mapping `notebooks`
      to a target whose `tenantId` is **another** tenant, and run a cell.
      **Expect:** _Refusing to run … belongs to a different tenant than the
      connected compute._ Delete the file afterwards.

## 12. Clean up

- [ ] Drop the test table (`%%sql` `DROP TABLE fc_validation_t`) and
      delete any pulled folders.
- [ ] **Fabric: Disconnect from Compute**. **Expect:** the status bar shows
      _connect compute_ and the `"compute"` section is removed.
- [ ] **Fabric: Sign Out** so the test repo forgets the sign-in. To remove
      the account from VS Code as well, use the **Accounts** menu (bottom
      left) → your Microsoft account → **Sign Out**.

## Diagnosing slow cells and Variable Library errors

Use an existing authorized connection and read-only code. Record the
extension and VS Code versions, runtime/Environment, execution path,
Local or Remote modules, and whether the session is new or already warm.
Do not change capacity, pool, authentication or deployment configuration
as part of the comparison.

1. Enable `fabric-connect.debugLogging`. Run `print(1)`, then
   `spark.sql("SELECT 1").collect()`, and repeat on the same session.
   Compare startup, bootstrap, queue and statement phases in **Fabric
   Connect** output. Do not add nested phases to `total`.
2. Run the reported assignment and a separate action in the same warm
   session. For example, use the following read-only probes in separate
   cells, and record only duration and row count:

   ```python
   import time

   _started = time.perf_counter()
   df = spark.sql("SELECT 1 AS n")  # Replace with the reported read-only query.
   print(f"DataFrame creation: {time.perf_counter() - _started:.3f}s")
   ```

   ```python
   _started = time.perf_counter()
   _row_count = df.count()
   print(f"Action: {time.perf_counter() - _started:.3f}s; rows={_row_count}")
   ```

3. Compare notebook editor cells, source-text Run Cell / Run All Above /
   Run All, and a file/selection. If comparing Local and Remote modules,
   use equivalent package versions in separate sessions: switching to
   Remote does not remove modules already staged in a running session.
   Starting/stopping sessions is a deliberate user action, not an
   automatic diagnostic step. Test a queued run as well as an idle one.
4. Compare Variable Library access over Livy with a deployed Fabric
   notebook in the intended workspace, using the same identity, runtime
   and relevant Environment. Assign the result without displaying it:

   ```python
   _library = notebookutils.variableLibrary.getLibrary("existing_library")
   ```

   Substitute an existing library's exact name. Do not print the library,
   its variables, credential APIs or secret
   values. Check same-workspace access, case-sensitive library names and
   the active value set. These checks do not prove the supplied error's
   cause.

5. For the specific Variable Library / notebook-state-not-found failure,
   expect the original error and traceback plus separate visible guidance
   in the notebook editor and guidance after the text-run traceback.
   Expect the cell to remain failed, no automatic retry, and existing
   import guidance to remain visible when applicable. Unrelated SQL,
   permissions and library-not-found errors must not get this hint.
6. Check that a cancelled execution reports `cancelled`, a failed one
   reports `error`, and warm runs reuse the session. Turn debug logging
   off; expect no new execution or HTTP diagnostic lines.

The remote `perf_counter()` measurement excludes client preparation and
startup but can include catalog and service work. Client statement wait
includes remote queueing, execution, polling and network latency. Neither
is a promise about minimum query speed.

| Evidence                                                       | Investigation owner                                                                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Local preparation or extension queue dominates                 | Fabric Connect                                                                                               |
| Session startup, capacity throttling or service wait dominates | Fabric service / workspace operations; inspect runtime timings before blaming the workload                   |
| Variable Library fails only over Livy                          | Fabric Connect compatibility report, with Fabric escalation if needed; not automatically an analytics bug    |
| The same failure occurs in a deployed portal notebook          | Check Fabric state and library configuration, then investigate the analytics caller if evidence points there |

See Microsoft's [Livy overview](https://learn.microsoft.com/en-us/fabric/data-engineering/api-livy-overview),
[Variable Library constraints](https://learn.microsoft.com/en-us/fabric/data-engineering/notebookutils/notebookutils-variable-library)
and [Spark startup considerations](https://learn.microsoft.com/en-us/fabric/data-engineering/spark-compute).
Do not claim a root cause or speed improvement if this live comparison
has not been performed.

## Reporting a problem

Open an issue at <https://github.com/bendfeldt/fabric-connect/issues>
with:

- the Fabric Connect version and VS Code version (**Help → About**);
- the checklist step and what you saw instead of **Expect**;
- the error text, and the **Fabric Connect** output with
  `fabric-connect.debugLogging` on.
- for execution feedback, cold/warm status, module mode, execution path,
  phase timings and the result of the read-only portal/Livy comparison.

Don't paste tenant, workspace or item IDs, tokens or cell contents into a
public issue — the debug log already redacts them, but check error texts
(some include the tenant ID) before posting.
