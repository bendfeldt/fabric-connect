# Installing Fabric Connect

Fabric Connect is distributed as a `.vsix` package attached to GitHub
Releases — it is not published to the VS Code Marketplace. Pick one of the
three installation paths below, then verify the install and move on to the
[user guide](user-guide.md).

## Prerequisites

- **VS Code 1.85 or later** (the extension uses only the stable extension
  API).
- A **Microsoft Entra ID account** with access to at least one Microsoft
  Fabric workspace. Sign-in uses VS Code's built-in Microsoft
  authentication provider, so no extra auth tooling is needed.
- **Node.js 18+ and npm** — only if you build from source (options 2
  and 3). Installing a released `.vsix` needs neither.

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

Use this if you want to install a commit that has no release yet.

```sh
git clone https://github.com/bendfeldt/fabric-connect.git
cd fabric-connect
npm ci
npm test                              # type-check + build + unit tests
npx --yes @vscode/vsce package        # produces fabric-connect-<version>.vsix
```

Then install the generated `.vsix` as in option 1. This is exactly what
the [Release workflow](../.github/workflows/release.yml) does in CI.

## Option 3 — Run from source (development)

For working on the extension itself:

```sh
git clone https://github.com/bendfeldt/fabric-connect.git
cd fabric-connect
npm ci
npm run compile        # or: npm run watch
```

Open the folder in VS Code and press `F5` to launch an Extension
Development Host window with the extension loaded.

## Verify the installation

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and type
`Fabric:` — you should see the extension's commands (`Fabric: Sign In`,
`Fabric: Open File as Fabric Notebook`, …).

Activation is lazy by design: the extension only activates when you open a
Fabric notebook (`*.Notebook/notebook-content.ipynb`) or run one of its
commands, never unconditionally on startup. Not seeing it in the "running
extensions" list before that is expected.

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

Configure your workspace targets and sign in — see the
[user guide](user-guide.md).
