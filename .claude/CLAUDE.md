@../AGENTS.md

# Project: fabric-connect

Local-first VS Code extension for Fabric notebooks, files, Spark jobs,
KQL/DAX/GraphQL queries, API notebooks and read-only browsing. Code stays
in the repo; execution uses Lakehouse-hosted Livy, not deployment.
Current architecture: `docs/architecture.md`. Toolchain/layout:
`docs/development.md`. Pipelines and workspace item mutations are out of scope.

Stack: TypeScript (strict), VS Code stable extension API only, Node 18+.
Zero runtime dependencies by design; tests use the built-in `node:test`.

Layout:

- `src/core/` — pure modules with **no `vscode` import**: errors, notebook
  codecs, configuration/host resolution, API/write policy, Livy sessions,
  queries, item indexing, module bundling and Spark jobs. Native-testable.
- `src/vscode/` — adapters to the editor: Entra auth, notebook
  notebook/text execution, compute and binding stores, serializers,
  Configuration/Repo/Lakehouses/Connections views and webview panels.
- `src/extension.ts` — composition root: plain constructor calls, no DI
  container, lazy activation.
- `test/` — native tests with scripted HTTP and VS Code stand-ins; no live
  workspace needed. Not a real Extension Development Host test suite.

## Commands

- `npm run compile` — type-check + build to `out/`
- `npm test` — clean build + native tests (`node --test`)
- `npm run watch` — incremental compile

## Conventions

- Match the existing code in the file you're editing. Read it before you write.
- One change, one purpose. No "while I was in there".
- Use typed boundaries in `src/core/types.ts` and beside their owning
  modules. The target registry currently registers only `notebook`;
  do not confuse it with the query-executor registry or invent pipeline support.
- Error standard: every surfaced error states the failed operation, root
  cause, the entity involved (tenant/workspace/file/session), and the next
  step. Wrap foreign exceptions in a typed error from `src/core/errors.ts`
  with the original as `cause`. No generic "something went wrong".
- Fidelity is a tested property: unknown notebook fields must survive
  round-trips; unmodified notebooks serialize byte-for-byte. Don't break
  the round-trip tests to ship a feature.
- Security: tokens only via VS Code authentication; HTTP paths redacted,
  diagnostics use fixed labels, strict webview CSP and escaped data.
  Original runtime output/errors can contain sensitive values; redact before
  sharing. `.fabric/local.json` stays gitignored.
- New dependencies need a concrete justification in the commit body
  (see AGENTS.md); prefer built-in Node/VS Code APIs.

## Claude-specific

- Slash commands live in `.claude/commands/`: `/spec`, `/verify`, `/polish`
  and `/next`. There is no installed `/loop` command or templates directory.
- The `verifier` subagent (`.claude/agents/verifier.md`) is dispatched by `/verify` and can be reused as an eval grader.
- The installed SessionStart hook attempts to inject `using-loopkit`.
  Hook invocation/output support depends on the client; loading a skill
  manually is still necessary when it is not injected.
- The PreCompact hook can append extracted decisions to
  `claude-decisions.json` when invoked with a usable transcript and `jq`;
  it is not a guaranteed cross-client memory store or a sanitizer.
- Cross-agent rules live in the imported `AGENTS.md` at repo root. Do not duplicate them here.

<!-- Keep under 300 lines. Prune weekly. Every paragraph is a tax on every turn. -->
