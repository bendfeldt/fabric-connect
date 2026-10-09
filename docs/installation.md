# Installing Fabric Connect

Fabric Connect is distributed as a `.vsix` package attached to GitHub
Releases — it is not published to the VS Code Marketplace. Pick one of the
installation paths below, then verify the install and follow
[Getting started](getting-started.md).

Guides describe the current source. Check [Unreleased](../CHANGELOG.md#unreleased)
before expecting a newer feature in the latest release.

## Prerequisites

- **VS Code 1.93 or later** (the extension uses only the stable extension
  API).
- A **Microsoft Entra ID account** with access to at least one Microsoft
  Fabric workspace. Sign-in uses VS Code's built-in Microsoft
  authentication provider, so no extra auth tooling is needed.
- **Node.js 18+ and npm** for source compilation/native tests, or
  **Node.js 22+** to package a VSIX with vsce 4.0.0. Installing a released
  `.vsix` needs neither.

## Option 1 — Install a released `.vsix` (recommended)

1. Download `fabric-connect-<version>.vsix` from the
   [latest release](https://github.com/bendfeldt/fabric-connect/releases/latest).
2. Install it, either way:
   - **VS Code UI**: Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`) →
     `···` (Views and More Actions) → **Install from VSIX…** → pick the
     downloaded file.
   - **Command line**:

     ```sh
     code --install-extension fabric-connect-<version>.vsix
     ```

3. Reload the window if VS Code prompts you to.

## Option 2 — Build the `.vsix` from source

Use this for a commit that has no release yet. The authoritative
[source-build recipe](development.md#package-from-source) covers dependencies,
tests, tooling and packaging. Then follow the
[local install/reload/test loop](local-build.md).

## Option 3 — Run from source (development)

For working on the extension itself, use the
[development guide](development.md#run-and-debug-the-extension). It includes
a clean-clone `extensionHost` launch configuration; local `.vscode/` files
are not supplied by git.

## Verify the installation

- Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and type
  `Fabric:` — you should see the extension's commands (`Fabric: Sign In`,
  `Fabric: Connect to Compute`, …).
- The **Fabric** view appears in the Explorer side bar and the **Fabric**
  Activity Bar icon opens Configuration, Repo, Lakehouses and Connections.
- **Help → Welcome → Walkthroughs → Get started with Fabric Connect**
  opens the in-product walkthrough.

Activation is lazy: the extension starts when you run one of its commands,
open the Fabric view or a Fabric notebook, or open a folder that already
has a `.fabric/local.json` — never unconditionally on startup.

## Updating

Download the newer `.vsix` from Releases and install it the same way — VS
Code replaces the older version in place. There is no auto-update for
extensions installed from a `.vsix`.

## Uninstalling

Extensions view → **Fabric Connect** → **Uninstall** (or
`code --uninstall-extension bendfeldt.fabric-connect`). Cached
authentication sessions are managed by VS Code's Microsoft account
integration and can be removed via the Accounts menu; the extension itself
stores no tokens on disk.

## Next step

Follow the [getting-started guide](getting-started.md): sign in, connect
to compute and run your first notebook.
