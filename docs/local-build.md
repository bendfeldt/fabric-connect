# Build and install a `.vsix` locally

How to package the extension on your machine and install it in VS Code, so
you can test a fix without cutting a release. Nothing here touches `main`,
tags or GitHub Releases: those only happen when a maintainer runs
**Actions → Release → Run workflow**.

Use a local `.vsix` when you need to test exactly what ships: the packaged
file list, the walkthrough, the minimum VS Code version, or a clean
install. For a quick debug loop with breakpoints, run the extension from
source instead (see [Development](development.md#run-and-debug-the-extension)).

## Prerequisites

- Node.js 18 or later.
- VS Code 1.93 or later, with the `code` command on your `PATH`. In VS Code:
  Command Palette → **Shell Command: Install 'code' command in PATH**.

## 1. Build one explicitly named artifact

Follow [Development](development.md#toolchain-and-first-setup) for initial
setup and tests, then use its
[packaging recipe](development.md#package-from-source) with a fixed local name:

```sh
npm run package -- --out fabric-connect-local.vsix
```

This recompiles and packages the working tree without bumping the version,
tagging or releasing. The manifest version remains the installed version
label even if this artifact contains newer source; record the git commit
alongside it when comparing builds.

## 2. Install it

```sh
code --install-extension fabric-connect-local.vsix --force
```

Use the file name you built. `--force` reinstalls over the same version,
so you don't have to bump the version for every test.

Or use the UI: Extensions view → `…` menu → **Install from VSIX…**.

## 3. Reload VS Code

Command Palette → **Developer: Reload Window**. Then check the Extensions
view shows the version you installed. Do not identify builds solely by the
version if you reused the same version number.

## 4. Test it

Work through the relevant part of the [test checklist](testing.md), or
just the steps that cover your change.

## 5. Repeat

Change the code, run relevant local checks, then rebuild, install and reload.
For the first two actions:

```sh
npm run package -- --out fabric-connect-local.vsix &&
  code --install-extension fabric-connect-local.vsix --force
```

Use an exact filename. Older packages can coexist without making the install
ambiguous. Packaging may download vsce; installation/reload and live Fabric
validation are deliberate manual actions, not part of a no-install docs check.

## Going back to the released version

Extensions view → Fabric Connect → **Uninstall**, then install the release
`.vsix` from the
[Releases page](https://github.com/bendfeldt/fabric-connect/releases/latest)
as in the [Installation guide](installation.md).
