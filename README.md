# Fabric Connect

[![Build](https://github.com/bendfeldt/fabric-connect/actions/workflows/build.yml/badge.svg)](https://github.com/bendfeldt/fabric-connect/actions/workflows/build.yml) [![Test](https://github.com/bendfeldt/fabric-connect/actions/workflows/test.yml/badge.svg)](https://github.com/bendfeldt/fabric-connect/actions/workflows/test.yml)

**Local-first Microsoft Fabric development in VS Code** — a "Databricks
Connect for Fabric". Your notebooks, Python modules, Spark jobs and queries
live in your git repo. Connect the repo once to Fabric compute (a capacity,
a workspace on it and a host Lakehouse) and run everything from the editor.

**Nothing is ever deployed.** Fabric Connect never creates, updates or
deletes workspace items — Lakehouses included — and refuses, in code,
every write outside a short, tested allowlist. Getting code into a
workspace stays your team's existing process (Fabric git integration,
deployment pipelines, CI).

## Features

- **Connect to compute** — pick capacity (SKU) → workspace → existing host
  Lakehouse (→ Environment) once per repo; the status bar shows the
  connection and which Lakehouse the active notebook runs on.
- **Notebooks** — Fabric's git format (`notebook-content.py`, `.scala`,
  `.sql`, `.r`) and `.ipynb`, saved byte-for-byte compatible with the
  portal; Lakehouse attach/detach; local `%run`; `%%sql` and other cell
  magics; `display()` tables; restart, list and stop Livy sessions.
- **Your own modules** — set `fabric-connect.sourceRoots` and
  `import mypkg` on Fabric uses the code in your working tree. No wheels,
  no uploads to manage.
- **Run files and jobs** — run a `.py`/`.sql`/`.scala`/`.r` file or a
  selection on Fabric; run a Spark Job Definition as a Livy batch from its
  local files.
- **Query files** — `.kql`, `.dax` and `.graphql` against a KQL database,
  semantic model or GraphQL API; results as tables. (T-SQL: use the
  `mssql` extension with the connection string from the explorer.)
- **Fabric explorer** — read-only view of capacities, workspaces, items,
  OneLake files and tables and connections; table and file previews; pull
  an item into the repo; hover a GUID to see what it is.
- **API notebooks** — `.fabnb` notebooks with `%api` / `%cmd` cells for
  exploring the Fabric REST API.

## Quick start

1. Install the `.vsix` from the
   [latest release](https://github.com/bendfeldt/fabric-connect/releases/latest)
   (`code --install-extension fabric-connect-<version>.vsix`).
2. Open your repo and add `.fabric/local.json` to its `.gitignore`.
3. **Fabric: Sign In** with your tenant ID.
4. **Fabric: Connect to Compute** → capacity → workspace → Lakehouse.
5. Open a `*.Notebook/notebook-content.py` (or `.ipynb`), pick the
   **Fabric Livy** kernel and run a cell.

The full walkthrough — modules, files, jobs, queries, explorer, API
notebooks — is in **[Getting started](docs/getting-started.md)**, and in
VS Code under **Help → Welcome → Walkthroughs → Get started with Fabric
Connect**.

## Documentation

- **[Getting started](docs/getting-started.md)** — the end-to-end how-to.
- **[User guide](docs/user-guide.md)** — reference for every feature,
  command, setting and error.
- **[Installation guide](docs/installation.md)** — install a released
  `.vsix`, build one from source, or run from source.
- **[Security and data](docs/security.md)** — what the extension talks to,
  what it may change, and what it stores.
- **[Plan](docs/plan-local-first.md)** and
  **[Part 1 design](docs/design-part1-notebooks.md)** — architecture and
  decisions.
- **[Changelog](CHANGELOG.md)**.

## Commands

| Command                                         | What it does                                                   |
| ----------------------------------------------- | -------------------------------------------------------------- |
| `Fabric: Sign In`                               | Entra ID sign-in to a tenant                                   |
| `Fabric: Connect to Compute`                    | Pick capacity → workspace → host Lakehouse (→ Environment)     |
| `Fabric: Disconnect from Compute`               | Remove the saved compute connection                            |
| `Fabric: Open File as Fabric Notebook`          | Open any `.ipynb` with the Fabric notebook editor              |
| `Fabric: Manage Lakehouses for Active Notebook` | Attach/detach Lakehouses, set the default                      |
| `Fabric: Restart Livy Session`                  | Stop and start a fresh Spark session                           |
| `Fabric: Stop Livy Session`                     | Stop the active notebook's Spark session                       |
| `Fabric: Show Livy Sessions`                    | List active sessions on the host Lakehouse; stop selected ones |
| `Fabric: Run File on Fabric`                    | Run a Python/SQL/Scala/R file                                  |
| `Fabric: Run Selection on Fabric`               | Run the selection or current line                              |
| `Fabric: Run Spark Job Definition`              | Run a local `*.SparkJobDefinition` folder as a Livy batch      |
| `Fabric: Run Query File`                        | Run a `.kql` / `.dax` / `.graphql` file                        |
| `Fabric: Change Query Target`                   | Re-pick the item a query file runs against                     |
| `Fabric: New API Notebook`                      | Open a `.fabnb` REST API notebook                              |

Settings: `fabric-connect.sourceRoots` (folders whose Python modules are
staged to the session) and `fabric-connect.debugLogging` (redacted API
trace in the **Fabric Connect** output channel; tokens, IDs and cell
contents never appear in logs).

## Requirements

- VS Code 1.85 or later.
- A Microsoft Entra ID account with access to Microsoft Fabric, a capacity
  you can run Spark on, and a workspace on it with at least one Lakehouse
  (Contributor or higher).

## Development

```sh
npm ci
npm test          # clean build + unit tests (node --test, no live workspace needed)
npm run package   # build fabric-connect-<version>.vsix
```

Press `F5` in VS Code to launch an Extension Development Host.

The core modules (`src/core/`) have no dependency on the `vscode` module —
they run and test in plain Node. The VS Code adapters (`src/vscode/`) and
the composition root (`src/extension.ts`) wire them to the editor with
plain constructor calls. A manifest test activates the compiled extension
against a stub of the VS Code API and checks that every command, notebook
type, view, menu entry and walkthrough step in `package.json` is really
wired up.

Design principles: zero runtime dependencies, no magic, explicit over
generic, observable API traffic, and compatibility first — the Fabric REST
API version is an explicit constant, and only VS Code's stable extension
API is used.

Releases are automated: merging to `main` opens a version-bump PR, and
merging that publishes a GitHub Release with the `.vsix`. CI packages the
extension on every PR and checks that the `.vsix` contains only the
compiled extension, manifest, README, changelog, license and media.

### Documentation wiki

The `openwiki/` directory holds a repository wiki generated by
[OpenWiki](https://github.com/langchain-ai/openwiki) and refreshed by
[`.github/workflows/openwiki-update.yml`](.github/workflows/openwiki-update.yml).
Generated pages are not hand-edited — steer the generator through
[`openwiki/INSTRUCTIONS.md`](openwiki/INSTRUCTIONS.md) instead.

## License

[MIT](LICENSE)
