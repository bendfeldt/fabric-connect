@../AGENTS.md

# Project: fabric-connect

VS Code extension for Microsoft Fabric notebooks: portal-compatible `.ipynb`
editing, Lakehouse attach/detach, and cell execution against Fabric
workspaces over Livy. This is Part 1 (notebooks only); Part 2 (pipelines)
will reuse the auth/target-config/API-client modules unchanged. Full design:
`docs/design-part1-notebooks.md`.

Stack: TypeScript (strict), VS Code stable extension API only, Node 18+.
Zero runtime dependencies by design; tests use the built-in `node:test`.

Layout:

- `src/core/` — pure modules with **no `vscode` import**: errors, notebook
  codec (fidelity), target resolver, Fabric API client, Livy session
  manager. Unit-testable in plain Node. Keep it that way.
- `src/vscode/` — adapters to the editor: Entra auth, notebook
  serializer/controller, Lakehouse webview panel.
- `src/extension.ts` — composition root: plain constructor calls, no DI
  container, lazy activation.
- `test/` — unit tests (no live workspace needed).

## Commands

- `npm run compile` — type-check + build to `out/`
- `npm test` — build + unit tests (`node --test`)
- `npm run watch` — incremental compile

## Conventions

- Match the existing code in the file you're editing. Read it before you write.
- One change, one purpose. No "while I was in there".
- Modules depend on the interfaces in `src/core/types.ts`, never on each
  other's internals. New item types go through the Target Config registry
  (`registerItemType`), not by editing the resolver.
- Error standard: every surfaced error states the failed operation, root
  cause, the entity involved (tenant/workspace/file/session), and the next
  step. Wrap foreign exceptions in a typed error from `src/core/errors.ts`
  with the original as `cause`. No generic "something went wrong".
- Fidelity is a tested property: unknown notebook fields must survive
  round-trips; unmodified notebooks serialize byte-for-byte. Don't break
  the round-trip tests to ship a feature.
- Security: tokens only via VS Code auth/SecretStorage; no tokens, tenant
  IDs, workspace IDs, or cell contents in logs; webviews keep strict CSP
  and HTML-escape all API data; `.fabric/local.json` stays gitignored.
- New dependencies need a concrete justification in the commit body
  (see AGENTS.md); prefer built-in Node/VS Code APIs.

## Claude-specific

- Slash commands live in `.claude/commands/`. `/spec`, `/verify`, and `/loop` are the primary entry points.
- The `verifier` subagent (`.claude/agents/verifier.md`) is dispatched by `/verify` and can be reused as an eval grader.
- The SessionStart hook (`.claude/hooks/session-start`) injects the `using-loopkit` skill on startup, `/clear`, and compaction — so skill routing is loaded from turn 1.
- Cross-agent rules live in the imported `AGENTS.md` at repo root. Do not duplicate them here.

<!-- Keep under 300 lines. Prune weekly. Every paragraph is a tax on every turn. -->
