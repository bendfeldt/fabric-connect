# Fabric Connect

[![Build](https://github.com/bendfeldt/fabric-connect/actions/workflows/build.yml/badge.svg)](https://github.com/bendfeldt/fabric-connect/actions/workflows/build.yml) [![Test](https://github.com/bendfeldt/fabric-connect/actions/workflows/test.yml/badge.svg)](https://github.com/bendfeldt/fabric-connect/actions/workflows/test.yml)

**Local-first Microsoft Fabric development in VS Code** — a "Databricks
Connect for Fabric". Your notebooks, Python modules, Spark jobs and queries
live in your git repo. Connect the repo once to a Fabric capacity and run
everything from the editor. This README describes the **current source**;
features under [Unreleased](https://github.com/bendfeldt/fabric-connect/blob/main/CHANGELOG.md#unreleased)
may not be in the latest released `.vsix`.

**Nothing is ever deployed.** Fabric Connect never creates, updates or
deletes workspace items — Lakehouses included — and refuses, in code,
every write outside a short, tested allowlist. Getting code into a
workspace stays your team's existing process (Fabric git integration,
deployment pipelines, CI).

## Features

- **Connect to compute** — pick a capacity once per repo. A host Lakehouse
  and optional Environment are picked when code without its own Lakehouse
  first needs them; the status bar shows the actual execution host.
- **Notebooks** — Fabric's git format (`notebook-content.py`, `.scala`,
  `.sql`, `.r`) and `.ipynb`, saved byte-for-byte compatible with the
  portal; notebook/text editing and text diffs; local `%run`, cell magics
  and `display()` tables; restart, list and stop Livy sessions. Bind a
  git-synced default Lakehouse locally without changing notebook metadata.
- **Python modules: Local or Remote** — choose working-tree packages
  staged to the session, or packages already installed in Fabric. Local
  source folders come from `sourceRoots`, supported `pyproject.toml`
  layouts, or `src`.
- **Run files and jobs** — run a `.py`/`.sql`/`.scala`/`.r` file or a
  selection on Fabric; run a Spark Job Definition as a Livy batch from its
  local files.
- **Query files** — `.kql`, `.dax` and `.graphql` against a KQL database,
  semantic model or GraphQL API; results as tables. (T-SQL: use the
  `mssql` extension with the connection string from the explorer.)
- **Fabric views** — Configuration, local Repo, Lakehouses and Connections
  in the Activity Bar, plus a remote Explorer tree. Browse OneLake, preview
  tables/files, pull an item into the repo or hover a GUID to identify it.
- **API notebooks** — `.fabnb` notebooks with `%api` / `%cmd` cells for
  exploring the Fabric REST API.

## Quick start

1. Install the `.vsix` from the
   [latest release](https://github.com/bendfeldt/fabric-connect/releases/latest)
   (`code --install-extension fabric-connect-<version>.vsix`).
2. Open your repo and add `.fabric/local.json` to its `.gitignore`.
3. **Fabric: Sign In** with your Microsoft account — remembered for this
   repo, like a Tabular Editor `.tmuo` file.
4. **Fabric: Connect to Compute** → pick the capacity.
5. Open a `*.Notebook/notebook-content.py` (or `.ipynb`), pick the
   **Fabric Livy** kernel and run a cell. If its default Lakehouse is
   _not bound_, use **Fabric: Bind Notebook's Default Lakehouse…**. Without
   a default, pick the compute host when prompted.

The full walkthrough — modules, files, jobs, queries, explorer, API
notebooks — is in **[Getting started](https://github.com/bendfeldt/fabric-connect/blob/main/docs/getting-started.md)**, and in
VS Code under **Help → Welcome → Walkthroughs → Get started with Fabric
Connect**.

## Documentation

- **[Getting started](https://github.com/bendfeldt/fabric-connect/blob/main/docs/getting-started.md)** — the end-to-end how-to.
- **[User guide](https://github.com/bendfeldt/fabric-connect/blob/main/docs/user-guide.md)** — reference for every feature,
  command, setting and error.
- **[Installation guide](https://github.com/bendfeldt/fabric-connect/blob/main/docs/installation.md)** — install a released
  `.vsix`, build one from source, or run from source.
- **[Build a `.vsix` locally](https://github.com/bendfeldt/fabric-connect/blob/main/docs/local-build.md)** — package and install
  your working tree to test a fix, without a release.
- **[Test and validate](https://github.com/bendfeldt/fabric-connect/blob/main/docs/testing.md)** — a checklist for validating an
  installed build, feature by feature.
- **[Security and data](https://github.com/bendfeldt/fabric-connect/blob/main/docs/security.md)** — what the extension talks to,
  what it may change, and what it stores.
- **[Architecture](https://github.com/bendfeldt/fabric-connect/blob/main/docs/architecture.md)** — implemented boundaries, execution flows and design decisions.
- **[Development](https://github.com/bendfeldt/fabric-connect/blob/main/docs/development.md)** — repository structure, builds, tests, debugging and releases.
- **[Changelog](https://github.com/bendfeldt/fabric-connect/blob/main/CHANGELOG.md)**.

## Commands and settings

Use the Command Palette's **Fabric:** actions or the Fabric views. The
[user guide](https://github.com/bendfeldt/fabric-connect/blob/main/docs/user-guide.md#command-reference)
owns the full command reference.

Settings are `fabric-connect.pythonModules` (`auto`, `local`, `remote`),
`fabric-connect.sourceRoots` (local Python source folders) and
`fabric-connect.debugLogging` (opt-in redacted HTTP and execution-phase
diagnostics). Runtime errors/output can contain sensitive values; review
them before sharing.

## Requirements

- VS Code 1.93 or later.
- A Microsoft Entra ID account with access to Microsoft Fabric, a capacity
  you can run Spark on, and a workspace on it with at least one Lakehouse
  (Contributor or higher).

## Development

```sh
npm ci
npm test          # clean build + unit tests (node --test, no live workspace needed)
npm run package   # build fabric-connect-<version>.vsix
```

For the clean-clone debugging configuration and installed-build loop, see
[Development](https://github.com/bendfeldt/fabric-connect/blob/main/docs/development.md).

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

Releases are initiated manually: an ordinary merge to `main` never releases.
A maintainer runs
**Actions → Release → Run workflow** (bump `auto`, `patch`, `minor` or
`major`), which opens a version-bump PR; merging that publishes a GitHub
Release with the `.vsix`. CI packages the
extension on every PR and checks that the `.vsix` contains only the
compiled extension, manifest, README, changelog, license and media.

## License

[MIT](LICENSE)
