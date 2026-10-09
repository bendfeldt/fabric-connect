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

- **Node.js 22 or later** and npm for packaging with vsce 4.0.0.
  Compilation/native tests still support Node 18+, but creating a VSIX does not.
- VS Code 1.93 or later, with the `code` command on your `PATH`. In VS Code:
  Command Palette → **Shell Command: Install 'code' command in PATH**.

## 1. Build a versioned development VSIX

Follow [Development](development.md#toolchain-and-first-setup) for initial
setup and tests. From the repository root, package a development version
without changing the checkout's `package.json`. The version is the next patch
after the checkout's released version plus a development suffix, computed from
`package.json` so this guide never names a release:

```sh
BASE="$(node -p "const [a,b,c]=require('./package.json').version.split('.'); a+'.'+b+'.'+(Number(c)+1)")"
N=1   # raise this for every build you want to tell apart
DEV="$BASE-dev.$N"
npm run package -- "$DEV" \
  --no-git-tag-version \
  --no-update-package-json \
  --out "fabric-connect-$DEV.vsix"
```

For a checkout at released version `X.Y.Z` this builds `X.Y.(Z+1)-dev.1`. It
cleans/recompiles the working tree and writes `fabric-connect-$DEV.vsix` in the
repository root. Both the packaged manifest and VSIX metadata use that
development version (`echo "$DEV"` prints it), so VS Code displays it. The checkout's `package.json`
and `package-lock.json` remain unchanged; no version commit, git tag or
release is created.

- The positional `"$DEV"` selects the **embedded package version**.
- `--no-update-package-json` applies that version only inside the package.
- `--no-git-tag-version` explicitly disables npm version commits/tags.
- `--out` names the exact artifact; changing only its filename would not
  change the version displayed in VS Code.

Use the existing `npm run package` script so the recipe stays on the pinned
vsce version. These flags and the packaged-version override are supported by
the official vsce 4.0.0 [CLI](https://github.com/microsoft/vscode-vsce/blob/v4.0.0/src/main.ts)
and [packaging implementation](https://github.com/microsoft/vscode-vsce/blob/v4.0.0/src/package.ts).

Choose a new development suffix for each distinguishable build (`-dev.2`
next). Semver orders `X.Y.(Z+1)-dev.N` above the released `X.Y.Z` but below
`X.Y.(Z+1)`; `X.Y.Z-dev.N` would be below the released `X.Y.Z`, which is why
the base is the next patch version. Record the source commit alongside the
artifact. This is a local version override, not Marketplace publishing.

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
code --install-extension "fabric-connect-$DEV.vsix" --force
```

For the fixed-name alternative, use `fabric-connect-local.vsix` instead.
Always name the file actually built; do not use a wildcard that could select
an older artifact. `--force` deliberately replaces an existing installation,
including reinstalls or downgrades.

Or use the UI: Extensions view → `…` menu → **Install from VSIX…**.

## 3. Reload VS Code

Command Palette → **Developer: Reload Window**. Then check the Extensions
view shows the development version (`echo "$DEV"`) for the primary example,
not the checkout's manifest version. For the fixed-name alternative, check the manifest version
and record the source commit; the displayed version alone cannot identify it.

## 4. Test it

Work through the relevant part of the [test checklist](testing.md), or
just the steps that cover your change.

## 5. Repeat

Change the code, run relevant local checks, then rebuild, install and reload.
Increment the development suffix and keep the version and filename aligned.
For example, the next build/install pair is:

```sh
N=$((N + 1)); DEV="$BASE-dev.$N"
npm run package -- "$DEV" \
  --no-git-tag-version \
  --no-update-package-json \
  --out "fabric-connect-$DEV.vsix" &&
  code --install-extension "fabric-connect-$DEV.vsix" --force
```

(`BASE` and `N` live in your shell session. In a new shell, run the first
block again with a higher `N`.)

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
