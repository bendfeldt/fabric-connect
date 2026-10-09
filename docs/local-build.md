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

## 1. Build a versioned development VSIX

Follow [Development](development.md#toolchain-and-first-setup) for initial
setup and tests. From the repository root, package a development version
without changing the checkout's `package.json`:

```sh
npm run package -- 1.2.1-dev.16 \
  --no-git-tag-version \
  --no-update-package-json \
  --out fabric-connect-1.2.1-dev.16.vsix
```

This cleans/recompiles the working tree and writes
`fabric-connect-1.2.1-dev.16.vsix` in the repository root. Both the packaged
manifest and VSIX metadata use **`1.2.1-dev.16`**, so VS Code displays that
development version. The checkout's `package.json` and `package-lock.json`
remain unchanged; no version commit, git tag or release is created.

- The positional `1.2.1-dev.16` selects the **embedded package version**.
- `--no-update-package-json` applies that version only inside the package.
- `--no-git-tag-version` explicitly disables npm version commits/tags.
- `--out` names the exact artifact; changing only its filename would not
  change the version displayed in VS Code.

Use the existing `npm run package` script so the recipe stays on the pinned
vsce version. These flags and the packaged-version override are supported by
the official vsce 3.9.2 [CLI](https://github.com/microsoft/vscode-vsce/blob/v3.9.2/src/main.ts)
and [packaging implementation](https://github.com/microsoft/vscode-vsce/blob/v3.9.2/src/package.ts).

Choose a new development suffix for each distinguishable build, such as
`1.2.1-dev.17` next. Semver orders `1.2.1-dev.16` above `1.2.0` but below
`1.2.1`; `1.2.0-dev.16` is below the released `1.2.0`. Use an appropriate
next release version as the base, and record the source commit alongside
the artifact. This is a local version override, not Marketplace publishing.

### Alternative: keep the manifest version

If a distinct installed version is not needed, retain the fixed-name build:

```sh
npm run package -- --out fabric-connect-local.vsix
```

This changes only the artifact filename. Its installed version is still the
checkout's manifest version, even when the working tree contains newer source.

## 2. Install it

For the versioned development build above:

```sh
code --install-extension fabric-connect-1.2.1-dev.16.vsix --force
```

For the fixed-name alternative, use `fabric-connect-local.vsix` instead.
Always name the file actually built; do not use a wildcard that could select
an older artifact. `--force` deliberately replaces an existing installation,
including reinstalls or downgrades.

Or use the UI: Extensions view → `…` menu → **Install from VSIX…**.

## 3. Reload VS Code

Command Palette → **Developer: Reload Window**. Then check the Extensions
view shows **`1.2.1-dev.16`** for the primary example, not the checkout's
manifest version. For the fixed-name alternative, check the manifest version
and record the source commit; the displayed version alone cannot identify it.

## 4. Test it

Work through the relevant part of the [test checklist](testing.md), or
just the steps that cover your change.

## 5. Repeat

Change the code, run relevant local checks, then rebuild, install and reload.
Increment the development suffix and keep the version and filename aligned.
For example, the next build/install pair is:

```sh
npm run package -- 1.2.1-dev.17 \
  --no-git-tag-version \
  --no-update-package-json \
  --out fabric-connect-1.2.1-dev.17.vsix &&
  code --install-extension fabric-connect-1.2.1-dev.17.vsix --force
```

For fixed-name builds, repeat the alternative build command and install
`fabric-connect-local.vsix --force`. Older packages can coexist without making
the explicit filename ambiguous. Packaging may download vsce; installation/
reload and live Fabric validation are deliberate manual actions, not part of
a no-install docs check.

## Going back to the released version

Extensions view → Fabric Connect → **Uninstall**, then install the release
`.vsix` from the
[Releases page](https://github.com/bendfeldt/fabric-connect/releases/latest)
as in the [Installation guide](installation.md).
