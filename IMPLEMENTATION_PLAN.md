# Implementation state

Current scope and enduring decisions are in [Architecture](docs/architecture.md).
Use git history for the authoritative record of commits and
[CHANGELOG.md](CHANGELOG.md) for release history. The released version is the
one in `package.json`, changed by convention only by the Release workflow's bump
PR (`test/versionConsistency.test.ts` fails CI if it drifts); committed features
listed under Unreleased are not a claim that the latest released VSIX already
includes them.

## Implemented

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

The packaging script now pins vsce 4.0.0, with Node 22 in Build and
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
