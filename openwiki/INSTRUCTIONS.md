# Wiki brief

fabric-connect is a VS Code extension for Microsoft Fabric: portal-compatible
`.ipynb` notebook editing, Lakehouse attach/detach, and cell execution against
Fabric workspaces over Livy. Part 1 (notebooks) is implemented; Part 2
(pipelines) will reuse the auth, target-config, and API-client modules
unchanged. The authoritative design document is
`docs/design-part1-notebooks.md`.

When generating the wiki, emphasize:

- **The layer boundary.** `src/core/` is pure Node with no `vscode` import
  (errors, notebook codec, target resolver, Fabric API client, Livy session
  manager); `src/vscode/` adapts those modules to the editor; `src/extension.ts`
  is the composition root with plain constructor calls. Modules depend on the
  interfaces in `src/core/types.ts`, never on each other's internals.
- **The extension seam.** New item types plug in through the Target Config
  registry (`registerItemType`), not by editing the resolver — this is how
  pipelines arrive without touching notebook code.
- **Fidelity as a tested property.** Unknown notebook fields survive
  round-trips and unmodified notebooks serialize byte-for-byte; the round-trip
  tests enforce portal compatibility.
- **The Livy execution flow.** Session creation, reuse, per-session queueing,
  cancellation, and reattachment after a VS Code reload.
- **Security posture.** Tokens only via VS Code auth/SecretStorage; no tokens,
  tenant IDs, workspace IDs, or cell contents in logs; `.fabric/local.json`
  (workspace IDs) stays gitignored while `.fabric/targets.json` (target shape)
  is committed.

Zero runtime dependencies is a design constraint, not an accident — call it
out where relevant. Tests use the built-in `node:test`; nothing in `test/`
needs a live Fabric workspace.
