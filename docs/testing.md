# Test and validate an installed build

A checklist for validating a Fabric Connect `.vsix` once it is installed:
every feature, what to do, and what you should see. Work through it after
installing a new release, before rolling a build out to a team, or when
something looks wrong.

- **Quick smoke test (about 15 minutes):** sections 0–4.
- **Full validation (about 1–2 hours):** everything.

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
- A **second workspace with no Lakehouse** (for a negative test in §3).

### Test repo

Create an empty folder, open it in VS Code (**File → Open Folder**), and
add these files. Folder names matter: `*.Notebook` and
`*.SparkJobDefinition` are how Fabric's git format marks items.

`.gitignore`

```gitignore
.fabric/local.json
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

Commit the repo (`git init && git add -A && git commit -m base`) so you
can check with `git diff` that saving changes nothing unexpected.

## 1. Install and activation

- [ ] **Extensions** view → Fabric Connect shows the version you installed.
- [ ] **Help → Welcome → Walkthroughs → Get started with Fabric Connect**
      opens, and each step's link runs its command.
- [ ] The **Fabric** view is in the Explorer side bar. Before you sign in
      it shows _Sign in to browse Fabric_; clicking it starts the sign-in.
- [ ] The status bar shows **Fabric: sign in**.
- [ ] **View → Output → Fabric Connect** exists.

## 2. Sign in (remembered per repo)

The per-repo sign-in needs a version newer than 1.1.7; 1.1.7 and earlier
ask you to type a tenant GUID instead.

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
      lists your home tenant's capacities.
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
- [ ] **Switch Tenant…** → **Enter a tenant ID or domain…** → `not a
  tenant`. **Expect:** a validation message; you cannot submit it.
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
- [ ] Pick the capacity, then the **workspace without a Lakehouse**.
      **Expect:** an error saying to create a Lakehouse in the Fabric
      portal — _Fabric Connect never creates items_. Nothing is created
      (check the workspace in the portal).
- [ ] Connect again and pick the test workspace, Lakehouse `fc_validation`
      and (optionally) an Environment. **Expect:** the status bar shows the
      connection; `.fabric/local.json` exists with a `"compute"` section.
- [ ] `git status`. **Expect:** `.fabric/local.json` is **not** listed
      (it is gitignored).
- [ ] Remove the `.gitignore` line, run **Connect to Compute** again.
      **Expect:** a warning that `.fabric/local.json` does not appear in
      your root `.gitignore`. Put the line back.

## 4. Notebooks

- [ ] Open `notebooks/Validate.Notebook/notebook-content.py`. **Expect:**
      the notebook editor (if it opens as text: tab → **Reopen Editor
      With… → Fabric Notebook (git source format)**).
- [ ] Select the **Fabric Livy** kernel and run the cell. **Expect:** after
      30–90 s (session start), a table with `n` = 0…4. The second status
      bar item names the Lakehouse the notebook runs on.
- [ ] Run it again. **Expect:** a result in seconds (session reused).
- [ ] Save without editing, then `git diff`. **Expect:** no changes.
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
- [ ] **Fabric: Show Livy Sessions**. **Expect:** your active session.
- [ ] **Fabric: Restart Livy Session**, then run a cell. **Expect:** a new
      session starts.
- [ ] **Fabric: Stop Livy Session**. **Expect:** the session stops (also
      gone from **Show Livy Sessions**).
- [ ] Optional: open a portal-exported `.ipynb` renamed to
      `X.Notebook/notebook-content.ipynb`, run a cell, save; `git diff`
      shows only what you changed.

## 5. Your own Python modules

- [ ] Settings → `fabric-connect.sourceRoots` → add `src`.
- [ ] In a notebook cell:
      `from fcvalidate import greet; print(greet("fabric"))`.
      **Expect:** `hello fabric`.
- [ ] Change `greet` to return `f"hi {name}"`, save, run the cell again.
      **Expect:** `hi fabric`, with no restart.
- [ ] In the Fabric view, open the Lakehouse → **Files**. **Expect:** a
      `.fabric-connect` folder while the session runs, and none after
      **Fabric: Stop Livy Session** (refresh the view).

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

## Reporting a problem

Open an issue at <https://github.com/bendfeldt/fabric-connect/issues>
with:

- the Fabric Connect version and VS Code version (**Help → About**);
- the checklist step and what you saw instead of **Expect**;
- the error text, and the **Fabric Connect** output with
  `fabric-connect.debugLogging` on.

Don't paste tenant, workspace or item IDs, tokens or cell contents into a
public issue — the debug log already redacts them, but check error texts
(some include the tenant ID) before posting.
