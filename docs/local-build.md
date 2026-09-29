# Build and install a `.vsix` locally

How to package the extension on your machine and install it in VS Code, so
you can test a fix without cutting a release. Nothing here touches `main`,
tags or GitHub Releases: those only happen when a maintainer runs
**Actions → Release → Run workflow**.

Use a local `.vsix` when you need to test exactly what ships: the packaged
file list, the walkthrough, the minimum VS Code version, or a clean
install. For a quick debug loop with breakpoints, run the extension from
source instead (see [Installation guide](installation.md), option 3).

## Prerequisites

- Node.js 18 or later.
- VS Code 1.93 or later, with the `code` command on your `PATH`. In VS Code:
  Command Palette → **Shell Command: Install 'code' command in PATH**.

## 1. Install dependencies

First time, and whenever `package-lock.json` changes:

```sh
npm ci
```

## 2. Run the tests (optional)

```sh
npm test
```

This does a clean build and runs the unit tests. No Fabric workspace is
needed.

## 3. Build the package

```sh
npm run package
```

This deletes `out/`, recompiles, and writes `fabric-connect-<version>.vsix`
in the repo root. The version comes from `package.json`. The `.vsix` is
gitignored, and no tag, release or commit is created.

Two optional variations:

- **Name the file** so you can tell a local build from a released one:

  ```sh
  npm run package -- --out fabric-connect-local.vsix
  ```

- **Use a different version** without editing `package.json`:

  ```sh
  npx --yes @vscode/vsce@3.9.2 package 1.2.1-dev.1 --no-git-tag-version --no-update-package-json
  ```

  This is handy to see at a glance which build is installed
  (Extensions view → Fabric Connect shows the version). Pick a version
  above the installed one: in semver a pre-release sorts _below_ its
  release (`1.2.0-dev.1` < `1.2.0`), and `code --install-extension`
  refuses a lower version unless you pass `--force`.

## 4. Install it

```sh
code --install-extension fabric-connect-1.2.0.vsix --force
```

Use the file name you built. `--force` reinstalls over the same version,
so you don't have to bump the version for every test.

Or use the UI: Extensions view → `…` menu → **Install from VSIX…**.

## 5. Reload VS Code

Command Palette → **Developer: Reload Window**. Then check the Extensions
view shows the version you installed.

## 6. Test it

Work through the relevant part of the [test checklist](testing.md), or
just the steps that cover your change.

## 7. Repeat

Change the code, then run steps 3–5 again. Steps 3 and 4 are one line:

```sh
npm run package && code --install-extension fabric-connect-*.vsix --force
```

(If old `.vsix` files pile up in the repo root, delete them first so the
`*` matches only the new one.)

## Going back to the released version

Extensions view → Fabric Connect → **Uninstall**, then install the release
`.vsix` from the
[Releases page](https://github.com/bendfeldt/fabric-connect/releases/latest)
as in the [Installation guide](installation.md).
