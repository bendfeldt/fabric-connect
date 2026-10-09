# Development

This guide describes the **current source tree**. User setup is in
[Getting started](getting-started.md); execution/data flows are in
[Architecture](architecture.md). Features under [Unreleased](../CHANGELOG.md#unreleased)
may be newer than the latest released VSIX.

## Repository layout

```text
fabric-connect/
  src/
    core/                 VS Code-independent logic and structural interfaces
    vscode/               editor, auth, filesystem, views and execution adapters
    extension.ts          composition root and command registration
  test/                   TypeScript node:test suites and scripted stand-ins
  docs/                   user, architecture, developer and validation guides
  media/                  icon, Activity Bar SVG and walkthrough Markdown
  .github/workflows/      build, test and manual release workflows
  .claude/                installed contributor skills, commands, hooks and verifier
  AGENTS.md               cross-agent contributor contract
  IMPLEMENTATION_PLAN.md  implementation state and evidence gaps
  CHANGELOG.md            Unreleased changes and preserved release history
  package.json            extension manifest, scripts and toolchain
  tsconfig.json           strict TypeScript compilation configuration
  run.sh                  optional agent runner, not an extension dev server
  out/                    generated compilation output (not source)
```

`.vscode/` debug/settings files, `.fabric/` machine state, `node_modules/`,
VSIX packages and the root `plan.md` can exist locally but are not tracked
source. Do not depend on another contributor's local debug configuration.

## Toolchain and first setup

- VS Code **1.93+**.
- Node.js **18+** and npm for building/testing; CI tests Node 18, 20 and 22
  and packages on Node 20.
- No runtime packages. Development dependencies are TypeScript, Node/VS Code
  type definitions and pinned Prettier. Packaging uses the vsce version in
  the `package` script, not a separately maintained global version.

On a fresh clone:

```sh
git clone https://github.com/bendfeldt/fabric-connect.git
cd fabric-connect
npm ci
```

Reinstall dependencies when the lockfile changes or a needed dependency is
missing, not before every edit. A Fabric tenant is not required for local tests.

## Commands

| Command                | Purpose                                                         |
| ---------------------- | --------------------------------------------------------------- |
| `npm run compile`      | Type-check and compile sources/tests into `out/`                |
| `npm run watch`        | Incremental compilation                                         |
| `npm test`             | Remove `out/`, compile, run native `node --test` suites         |
| `npm run format`       | Format the repository with pinned Prettier                      |
| `npm run format:check` | Check formatting without writing                                |
| `npm run package`      | Package a VSIX; `vscode:prepublish` cleans and recompiles first |

Prefer targeted checks for a focused change. For manifest/walkthrough wiring:

```sh
npm run compile && node --test out/test/manifest.test.js
```

Core tests use scripted HTTP/filesystem seams. UI-consumer and manifest tests
use VS Code API stand-ins. These are **not** live Extension Development Host
or Fabric tests; `@vscode/test-electron`, Mocha, nock and msw are not installed.
See [Test and validate](testing.md) for deliberate manual VS Code/Fabric checks.

## Run and debug the extension

Compile, open this repository in VS Code and use an **extensionHost** launch
configuration. If no local configuration exists, create `.vscode/launch.json`
with this minimal configuration:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Fabric Connect",
      "type": "extensionHost",
      "request": "launch",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}"],
      "outFiles": ["${workspaceFolder}/out/**/*.js"]
    }
  ]
}
```

Run `npm run compile` (or keep `npm run watch` running), select **Run Fabric
Connect** and press `F5`. In the Extension Development Host, open a separate
test repo. Do not assume a sibling `fabric-test-repo` exists. This configuration
does not automatically compile before launch.

Microsoft describes the difference between native tests and real host
integration in [Testing extensions](https://code.visualstudio.com/api/working-with-extensions/testing-extension).
Starting the UI or running code against Fabric is a separate manual action.

## Package from source

```sh
npm test
npm run package
```

The output is `fabric-connect-<package.json version>.vsix` in the repo root.
No tag, commit or release is created. The package script uses
`@vscode/vsce@3.9.2`; if unavailable locally, `npx` may download that tooling.
Do not run it in a no-install/offline task unless the tool is already available.

To name a package unambiguously without changing the version:

```sh
npm run package -- --out fabric-connect-local.vsix
```

For the install/reload/test loop, see [Local builds](local-build.md).
`.vscodeignore` allowlists the manifest, compiled `out/src/**/*.js`, README,
changelog, license and media. Sources, tests, `docs/` and agent tooling do not
ship. README documentation links therefore point to the repository.

## CI and releases

Build and Test run on main pushes, main-targeted pull requests and manual
dispatch. Build compiles, packages, checks the VSIX allowlist and uploads
compiled/VSIX artifacts. Test runs the native suite on the Node matrix.
There is no formatting workflow; run the relevant check locally.

A normal merge to main does **not** release. A maintainer manually dispatches
the Release workflow with `auto`, `patch`, `minor` or `major`. `auto` infers
the bump from Conventional Commits since the last `v*` tag. The workflow opens
or refreshes a `bot/version-bump` PR and enables squash auto-merge. Its merge
commit starts `chore(release):`, which triggers tests, packaging and a GitHub
Release/tag for the manifest version.

Repository setup requires `RELEASE_PAT` through GitHub's secret store, the
workflow's Contents/Pull requests permissions, allowed squash/auto-merge and
passing required checks. If human approval is required, a maintainer must also
approve the bump PR. The [workflow](../.github/workflows/release.yml) is the
authoritative operational configuration. Do not embed credential values or
change release settings as part of documentation work.

## Contributor workflow

Follow [AGENTS.md](../AGENTS.md): agree one feature, implement, validate and run
an independent adversarial review before committing. Use Conventional Commits.
Read implementation state and git history before treating a previous claim
as verified. Keep unverified live checks explicit.

Installed Claude entry points are `/spec`, `/verify`, `/polish` and `/next`.
There is no installed `/loop` command. `run.sh` is an optional Claude-oriented
prototype; it reads `PROMPT.md` and a `STATUS: done` marker, but does not enforce
all of the contributor contract. In particular it runs verification **after**
the executor's commit instruction, echoes verification failures and has no
`BLOCKED.md` gate. Do not use it as proof of safe commit/completion gating.
Its repair is outside this documentation update.
