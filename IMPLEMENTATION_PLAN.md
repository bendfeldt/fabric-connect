# Implementation state

Current scope and enduring decisions are in [Architecture](docs/architecture.md).
Use git history for the authoritative record of commits and
[CHANGELOG.md](CHANGELOG.md) for release history. The released version is the
one in `package.json`, changed by convention only by the Release workflow's bump
PR (`test/versionConsistency.test.ts` fails CI if it drifts); committed features
listed under Unreleased are not a claim that the latest released VSIX already
includes them.

## Implemented

- **Notebook-only Local mode:** explicit Local Python module mode no longer fails when source-root discovery finds no package folders; staging becomes a no-op and existing recursive local `%run` expansion remains responsible for referenced Fabric source notebooks. Explicit invalid source roots still fail validation. Live VS Code/Fabric validation remains unverified.
- **Local notebook execution bridge:** notebook-scoped Livy sessions and module
  scratch paths; a private module-level execution descriptor in notebook and
  source-cell paths; opt-in selected active Variable Library values using the
  existing definition-read helper. Source uploads record their actual bundle.
  No notebook-context impersonation, deployment, write-policy broadening or
  authentication changes. Coordinated consumer changes are in `fabric-aqv`.
  Live VS Code/Fabric acceptance and installation remain unverified and require
  separate approval.

- **Local-first policy:** non-GET API requests require the tested allowlist;
  OneLake writes are restricted to `Files/.fabric-connect/`. No workspace item
  provisioning, deployment, remote scheduler runs or pipeline execution.
- **Compute:** capacity-only connection per repo, host Lakehouse/Environment
  selected on demand, capacity discovery from accessible workspaces, Fabric/
  Power BI names and optional local labels. Known paused capacities are refused.
- **Notebooks:** portal JSON and Fabric git source codecs, fidelity/minimal-diff
  tests, local `%run`, cell magics, table display, source-text code lenses,
  notebook/text switching and raw Source Control diffs.
- **Lakehouses:** attach/default/detach local metadata edits, notebook workspace
  precedence, placeholder/logical-ID detection and per-notebook machine-local
  Bind/Unbind without rewriting the notebook.
- **Files and jobs:** file/selection execution; Local/Remote Python modules,
  supported source-root inference and content-hashed ZIP staging; local Spark
  Job Definitions submitted as separate Livy batches with cancellation and
  best-effort logs/cleanup.
- **Queries and browsing:** KQL/DAX/GraphQL executors and per-file bindings,
  escaped Results webview; Explorer remote tree, OneLake browsing/previews,
  GUID hover, read-only definition pull that refuses existing destinations.
- **Repo-centric UI:** Activity Bar Configuration, Repo, Lakehouses and
  Connections; item metadata edits, `.platform` JSON mode, notebook tab labels,
  cached item indexing and file watchers. No separate Tenants/Capacities view.
- **Sign-in and shipping:** remembered repo account/tenant, tenant picker,
  walkthrough completion/advance, LF normalization, VSIX allowlist, native
  manifest/UI-consumer tests, build/test CI and manually initiated release PRs.
  The release job requires VS Code Marketplace publishing through GitHub OIDC
  trusted publishing before creating the matching GitHub Release; see the
  rollout evidence gap below.
- **Execution diagnostics:** opt-in client phase timings in notebook and
  text/file paths. The specific Variable Library missing-notebook-state error
  retains its traceback and adds guidance, not a fallback or compatibility shim.
- **Session recovery:** GUID-safe Livy IDs, display-payload framing compatibility,
  and narrow HTTP 404/recognized terminal-dead HTTP 400 invalidation. Stale
  replies cannot clear a newer generation; original errors remain visible;
  the next explicit run starts fresh without automatic code replay.
- **Version consistency:** the Release workflow's bump PR now carries the
  changelog with the version (`scripts/syncChangelog.cjs` files Unreleased under
  the new version and opens a fresh Unreleased section) and auto-merges by
  rebase. Guides no longer hard-code a release or development version, and
  `test/versionConsistency.test.ts` fails CI when the manifest, lockfile and
  changelog disagree or a guide names a released version.
- **Reliability fixes from the 2026-10-10 audit:** work-starting POSTs are
  not resent after a 5xx or a mid-request network error (GET/DELETE, 429 and
  requests that never left the machine still retry);
  reattach replaces a saved Livy session only on 404 or an empty answer; cell
  and batch polling ride out network-level outages for up to two minutes
  (`NETWORK_OUTAGE_GRACE_MS`); a Spark job's staged files are deleted only
  once the job ended, was cancelled or never got submitted, and session
  stop/restart deletes only `<runId>/modules/`; a refused batch cancel is
  reported as "may still be running" (404 counts as cancelled); duplicated
  `isRecord`, `escapeHtml` and codec `deepEqual` helpers are shared.
- **Follow-up audit fixes (same day):** requests that provably never left the
  machine (DNS, refused connection, connect timeout) are resent again; a cell
  cancel that does not take effect checks the statement first and otherwise
  fails with LivyError kind `cancel-failed`; a statement Livy reports as
  `error` without output is a failed cell; the job submit error drops "may
  have been submitted" only when the job was provably not accepted (a 4xx
  answer, a never-sent socket code, a sign-in failure or the write policy)
  and keeps it for every other error;
  one stager method builds staged job folder paths; the runner test removes
  its temp folder.
- **Second follow-up (2026-10-23):** a Spark job whose submit Fabric provably
  did not accept (same rule as the submit warning, decided in core by
  `jobMayStillRun`) now has its staged files deleted, without the "may still
  be running" note; a submit that may have reached Fabric still keeps them.
  A saved Livy session that cannot be checked on reattach (any error but 404) fails with its own error naming the session and cause, with next
  steps (retry, or `Fabric: Stop Livy Session` to drop it); the saved ID is
  still kept and no session is started. A test pins that `stopSession`
  clears the saved ID even when its DELETE fails. With no Fabric notebook
  active, `Fabric: Stop Livy Session` now stops the compute host's session
  (core `computeHost`, the same target and Environment plain files run on)
  instead of refusing; it never prompts for a host. Show Livy Sessions'
  compute-host fallback now keeps the Environment too, so stopping your own
  session from its list forgets it (it used to fail the next run once).
- **Documentation alignment:** current architecture/development references,
  consolidated onboarding/build instructions, complete manual fixtures,
  accurate command/settings/security references and installed contributor
  guidance. Superseded design pages and the unused placeholder memory index
  are removed; enduring D1-D4 rationale is preserved in architecture.

The original M0-M5 milestones are implemented. There is no remaining pipeline
milestone or outstanding stacked-PR merge instruction in this tracker.

## Evidence and validation boundaries

The native `node:test` suites exercise core behavior through scripted seams,
and manifest/consumer tests use VS Code API stand-ins. They do not replace a
running VS Code host or live Fabric verification.

Notebook-only Local mode validation: the focused regression failed first with
the reported no-source-folder error, then passed after the fix. TypeScript
compilation, all 392 native tests, changed-file Prettier checks,
`git diff --check`, and the independent adversarial review passed. A live
VS Code/Fabric run of the Aquavilla notebook was not performed.

Local notebook execution bridge validation: TypeScript compilation, all 357
native tests, changed-file Prettier checks and the required independent
adversarial review passed. The coordinated analytics runtime/configuration
regressions also passed. Its full repository gate remains blocked by preserved
pre-existing notebook binding and Load-cell edits, not waived or repaired by this
feature. No extension installation, remote session, authentication change,
deployment or business write was performed; live Local/Remote execution and
deployed Fabric compatibility remain unqualified.

Terminal-session recovery was reproduced locally through real client/manager
code with scripted service responses. It does not establish why Fabric ended
the original session or prove recovery on the original live operation.

The documentation refresh uses local link/reference/example checks,
changed-file formatting and manifest/write-policy regression checks, plus an
independent adversarial diff review. No extension installation, authentication,
live Fabric calls, release or push is part of that maintenance feature.

Local documentation validation passed: all 78 baseline dispositions, 147
links/anchors, 13 JSON examples, 46 command titles and manifest settings/views
were checked. Changed-file formatting, TypeScript compilation and all 24
manifest/write-policy regressions passed. Copy-only comparisons confirmed
unchanged code, manifest behavior and executable runner logic, apart from the
approved documentation text. Independent review passed after correcting
compute-fallback tenant checks, attachment/default semantics, Run All Above
and session-sharing descriptions.

The local-build guide again makes versioned development VSIX packages the
primary workflow, using the pinned packaging script with
`--no-update-package-json` and `--no-git-tag-version`. The fixed-name build
remains an alternative. The recipe was checked against the pinned vsce
implementation; local link/formatting checks and independent review passed.
No package build or extension installation was performed as part of this
documentation correction.

The packaging script now pins vsce 4.1.1, with Node 22 in Build and
release-packaging CI. Node 22+ is required only for packaging; extension
runtime requirements and the Node 18/20/22 test matrix are unchanged.
Local packaging verified a normal release version and a development version
override in both packaged manifests and VSIX metadata, with 68 allowlisted
files each. Checkout manifest/lockfile bytes and git commit/tag references
were unchanged by packaging. The two session-only verification VSIX files
were removed. Compilation, all 13 manifest regressions, formatting,
documentation links and independent review passed; no extension installation
or release was performed.

The audit reliability fixes were developed on branch `fix/audit-reliability`,
one purpose per commit. Each bug-fix commit carries the tests that pin its
behavior; refactors (shared helpers, the staged folder path) and the test
cleanup rely on the existing suite.

Session record (from the 2026-10-10 working session; not reproducible from
git alone): each bug-fix test was run and seen failing before its fix;
each commit was made after the verifier subagent returned a passing verdict
on its diff. For the follow-up cell-cancel and job-submit items the verifier
failed three rounds over a disputed rule; the user then decided the rule (a
failed cell cancel checks the statement before reporting; the job submit
warning uses an allowlist with a cautious default) and the verifier passed
the result. The `error`-without-output fix was split out of the cell-cancel
item on review and passed separately.

Reproducible checks, last run on 2026-10-10 after the final code commit:
`npm test` (348 tests, 0 failures) and
`npx prettier --check src test docs CHANGELOG.md IMPLEMENTATION_PLAN.md`
(clean). A contract test pins Node's real `fetch` rejection shape for a
refused connection. No live Fabric run (real network drop, job cold start,
reload reattach, cancel races) was performed.

Second follow-up session (2026-10-23): three commits (job files on a
rejected submit, reattach recovery guidance, Stop fallback to the compute
host). Each new test was seen failing before its fix, except the
`stopSession` failing-DELETE test, which pins behavior that already held.
Each commit was made after the verifier passed its diff; the first round
failed each one (submit wording, the dead-state replacement rule in the
docs, and a self-comparing test plus an incomplete warning), and the
re-review passed after the fixes. `npm test` (352 tests, 0 failures) and
`npx prettier --check src test docs CHANGELOG.md IMPLEMENTATION_PLAN.md`
passed. The Stop command handler in `extension.ts` is not reachable by the
native harness; only its core `computeHost` decision is tested. Not run (no
live Fabric): a rejected and a 5xx job submit, a reattach that keeps failing
followed by Stop, and Stop with no notebook active (docs/testing.md).
A fourth commit keeps the Environment in Show Livy Sessions' compute-host
target. Its test pins only the manager side and passed before the fix; the
handler change has no automated test. The verifier failed it for that
reason, and the user accepted the gap and approved the commit. Its manual
smoke step (docs/testing.md) was not run.

## Next authorized work

- After explicit approval, smoke-test current source in a running VS Code host
  and test tenant using [Testing](docs/testing.md), especially walkthrough,
  repo/lakehouse views, bindings and notebook/source-text execution.
- After installing a reviewed build with approval, verify terminal-session
  recovery on the original path without reloading VS Code.
- Obtain authorized read-only timing and portal/Livy comparison evidence before
  assigning the reported latency/Variable Library failure to the extension,
  Fabric service or caller. Do not plan a performance or compatibility remedy
  from the diagnostic hint alone.
- Repair the optional agent runner only as a separately approved feature:
  verification currently follows the executor's commit instruction, failed
  JSON verdicts are not parsed, and `BLOCKED.md` is not checked.

## Known limits and open evidence gaps

- Marketplace publishing in the Release workflow has never run: the trusted
  publisher policy, OIDC token exchange and Marketplace upload remain rollout
  evidence gaps. The stable pinned vsce CLI exposes `--oidc`,
  `--skip-duplicate` and `--packagePath`; existing releases are intentionally
  not backfilled.
- `extension.ts` command handlers are not reachable by the native tests:
  the Stop and Show Livy Sessions compute-host fallbacks are checked only
  through core `computeHost` and manual smoke steps.
- Unverified against live Fabric: that a gone Livy session answers HTTP 404
  on `GET /sessions/{id}`. If Fabric answers 400 or 403 instead, reattach
  keeps failing until the user runs `Fabric: Stop Livy Session`; no other
  status is treated as gone without live evidence.
- Live latency and Variable Library notebook-state failure causes remain
  unconfirmed. Notebook utility documentation does not prove standalone Livy
  support.
- Real VS Code walkthrough/tenant prompts and all current sidebar behaviors
  have not been established by the native stand-in tests.
- Cross-tenant Power BI/Kusto consent behavior remains tenant-dependent and
  not verified in every tenant.
- Livy batch driver logs are fetched best effort; the endpoint contract and
  local SJD `Main/`/`Libs/` layout still need comparison with a live export.
- Repo exclusion supports plain and `**/name` `files.exclude` patterns, not
  `.gitignore` semantics.
- Attached Lakehouses without a discovered workspace may show ID prefixes;
  expanding their workspace supplies names/context. Missing notebook default
  workspace metadata is an explicit error, not a target fallback.
- Scratch cleanup is best effort and window-scoped; remote expiry is not a
  guaranteed cleanup trigger. Session stop/restart removes only staged module
  bundles; job folders kept after lost tracking stay until removed by hand.
- Read-only POSTs (DAX, KQL, GraphQL, getDefinition) are no longer retried on
  5xx or mid-request network errors; rerunning is manual.
- The never-sent socket codes are read from Node's `fetch`; whether VS Code's
  proxy-aware `fetch` reports the same codes is unverified (unknown codes fall
  back to "not resent").
- A failed module-staging prelude in the notebook editor is rendered without
  saying it was module staging (the text runner labels it).
- Unverified against live Livy: that a statement can end in state `error`
  without output (now shown as a failed cell), and the statement states seen
  after a failed cancel (`cancelling`, `cancelled`, finished).
- `describeWorkspaceCapacity` is a tested core helper without a UI caller
  since the remote Workspaces view was replaced. Removal would be a separate,
  deliberate code cleanup.

## Variable Library picker and Connections pane cleanup (2026-11-17)

- Added the Configuration Variable library row and `fabric-connect.variableLibrary` picker. It resolves the active notebook target, falls back to the connected host only when no Fabric notebook is active, shows variable names only, preselects saved names, preserves values on cancellation, supports explicit clearing, and rejects empty selections.
- The existing `fabric-connect.variableLibraries` workspace setting remains the private bridge input and is restricted to one library. The execution descriptor and active-value-set resolution are unchanged; only selected active values continue into notebook execution.
- Removed the duplicate Activity Bar Connections view and its obsolete root mode/menu conditions. The main Fabric Explorer retains the Connections group and read-only listing/actions.
- Updated manifest, user and testing documentation, installation notes, changelog and this handoff.
- Evidence: `npm run compile -- --pretty false` passed. The full `npm test` suite passed (367 tests) after rerunning with local socket permission because one existing fetch-contract test binds `127.0.0.1`. Focused picker, target, manifest, Configuration-row and Explorer-Connections tests also passed.
- Evidence gap: no live VS Code/Fabric picker smoke test was run; it requires an authorized tenant/VS Code host. Prettier checks passed for the changed TypeScript and Markdown files.

## Notebook target resolution and Remote module switching (2026-11-17)

- Variable Library listing now resolves the active Fabric notebook with the execution host resolver and uses configured compute only when no notebook is active. Invalid/unbound notebook targets still fail instead of falling back to an unrelated workspace.
- The Local → Remote picker transition now restarts only a tracked session on the active notebook host or existing compute host; no session is created when none is tracked. Direct settings edits do not trigger restart.
- Evidence: `npm run compile -- --pretty false` passed; the focused target/session/module-picker suites passed (114 tests); the full `npm test` suite passed (372 tests); Prettier checks passed for changed task files.
- Independent adversarial review passed. Live VS Code/Fabric smoke test remains unavailable and is needed to validate picker-driven session replacement against a real Fabric notebook.

## OneLake-free Local Wheel installation (2026-11-20)

- Replaced the earlier OneLake-staged/per-executor-pip approach with streamed sibling-wheelhouse transfer through sequential Livy statements. Wheel bytes are reconstructed and hash-verified in driver-local session storage; pip resolves dependencies only from that wheelhouse.
- Driver installs only pure-Python wheels, rejects native and `.pth` outputs, then distributes one hash-named ZIP with Spark `addPyFile`. A one-task manifest sentinel preflight checks distribution but does not prove every executor imported the ZIP. Remote mode remains attached-Environment-only; Spark job staging remains unchanged.
- Setup now uses `createStatements(): AsyncIterable`, executes statements in order, and blocks user code after cancellation/failure. A changed or absent active wheelhouse setup key replaces the tracked session. Session temporary files are retained; no cleanup callback removes them prematurely.
- Updated README, manifest text, changelog, architecture, security, user and testing guides. No new setting, dependency, command, upload endpoint or public API.
- Evidence: `npm run compile -- --pretty false` passed; all 88 focused Livy, wheel-stager, generated-code and execution-UI tests passed; generated PySpark statements parse successfully; and Prettier plus `git diff --check` pass. Full `npm test` passes 385 of 386 tests; the unrelated real-loopback contract test fails with sandbox `listen EPERM` on `127.0.0.1`. Independent adversarial review passed; live Fabric acceptance remains unavailable and required before release. Transfer is unbounded; measure live statement and wheelhouse limits before deciding whether to add a cap.

## Self-contained local development rebuild (2026-11-20)

- Updated the repeat-build recipe in `docs/local-build.md` to recompute its
  base version and require an explicit next unused development build number,
  so it also works in a fresh terminal session.
- Evidence: with `BASE` and `DEV` initially unset, the documented calculation
  produced a complete next-patch development version ending in `-dev.6`;
  Prettier passed for both changed documentation files; `npm test` passed all
  386 tests; and the independent adversarial review passed.

## Required Marketplace publishing (2026-11-19)

- Removed the optional repository-variable bypass: every new release now
  publishes the already packaged VSIX with GitHub OIDC before GitHub Release
  creation. Missing policy or token-exchange failure leaves no partial GitHub
  Release. Existing releases remain GitHub-only.
- Pinned package and publish commands to stable vsce 4.1.1 and documented the
  exact `bendfeldt/fabric-connect` trusted-publisher policy. Runtime code,
  authentication and Fabric permissions are unchanged.
- The release guard now distinguishes absent, complete and partial releases.
  Only a nonempty `uploaded` VSIX is complete; a `starter` or zero-byte asset is
  repaired on re-run. Non-404 GitHub API and malformed-response failures stop
  the job instead of being mistaken for an absent release.
- Evidence: vsce 4.1.1 `publish --help` exposes `--oidc` and
  `--skip-duplicate`; the release-workflow regression test was observed failing
  before the recovery fix and passing after it; `npm test` passed all 383 tests.
  The focused version-consistency suite, YAML parsing and changed-file Prettier
  checks passed. Packaging produced a 72-file allowlisted VSIX with identity
  `bendfeldt.fabric-connect` and manifest version matching the checkout. The
  first independent review rejected filename-only partial-release detection;
  the final review passed after the tested state/size classifier replaced it.
- Rollout remains blocked on the documented live local-wheel release gate,
  Marketplace policy creation, the first OIDC upload, and verification of the
  Marketplace listing. No branch push, policy, live Fabric call or release was
  performed.

## Lakehouse-first execution host (2026-11-20)

- Replaced capacity-first selection with one atomic workspace → Lakehouse →
  optional Environment flow. Capacity identity, name and SKU are derived from
  the selected workspace; a known inactive capacity is rejected.
- Treats only complete host profiles as connected. Existing capacity-only
  `"compute"` values remain readable for compatibility but do not set connected
  context or enable host-dependent execution.
- Kept the `"compute"` storage key and existing command IDs as hidden aliases;
  visible commands, Configuration, status, walkthrough and recovery text use
  execution-host terminology.
- Lakehouses now browse and bind across all accessible workspaces after sign-in,
  independent of execution-host selection. Notebook defaults and local bindings
  continue to run without a saved host.
- Added regression coverage for atomic host selection, legacy local state,
  Configuration context, hidden command compatibility, all-workspace browsing
  and logical Lakehouse binding.
- Evidence: the focused host/configuration/manifest/workspace suite passed all
  69 tests; `npm test` passed all 392 tests after allowing the existing
  loopback-only fetch-contract test to bind `127.0.0.1`; changed-file Prettier
  and `git diff --check` passed; the independent adversarial review passed.
- Evidence gap: no live VS Code/Fabric picker or execution smoke test was run;
  it requires an authorized tenant and extension host.
