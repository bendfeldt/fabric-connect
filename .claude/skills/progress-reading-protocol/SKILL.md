---
name: progress-reading-protocol
description: Read the goal, tracked handoff and git history, inspect optional ledgers, validate locally and smoke-test the last feature when authorized before starting new work.
when_to_use: very first tool calls of any fresh coding-agent session, rehydrating after a context reset or crash mid-project, verifying a claimed-shipped feature before picking up new work
---

# Progress-Reading Protocol

You have no memory of the previous session. The repo does. Every fresh session burns 5-10 minutes reconstructing state unless you follow a fixed opening sequence — with the sequence, it drops to 30-60 seconds. The cost is 2-4k tokens at the top of every session; the payoff crosses over past four sessions on the same project.

Skipping steps is the failure mode. Sessions that skip the smoke-test step (6) reliably build new features on top of silently broken ones. See the "looks shipped, isn't shipped" bug (originally documented in the shift-work harness pattern).

## When to apply

- First tool calls of any coding-agent session in a multi-session project.
- After a context reset, compaction, or crash mid-project — treat the resumed context as a fresh session.
- Before you write a single line of new code. No exceptions for "quick fixes."

## Procedure

1. **Confirm the project and working-tree status.** Preserve unrelated user
   edits. Session artifacts belong in the client's session workspace.
2. **Read the approved goal and handoff.** Here the tracked handoff is
   `IMPLEMENTATION_PLAN.md`; use `PROMPT.md` or a session goal if available.
   Read optional `claude-decisions.json` only if it exists and is safe to read.
   See [active-memory-reminder](../active-memory-reminder/SKILL.md) for its heuristic limitations.
3. **`git log --oneline -20`.** Trust committed history over stale state.
4. **Inspect remaining work in the existing tracker.** Count unfinished
   entries only if an optional `feature_list.json` exists. This checkout
   does not use that ledger; do not create one just for orientation.
5. **Use the actual developer workflow.** Fabric Connect is a VS Code
   extension, not a web service. Its commands are in
   [Development](../../../docs/development.md#commands); no `init.sh`,
   database reset or server startup is required for a documentation task.
6. **Smoke-test when authorized.** The real extension path is a running
   VS Code host and, for execution, Fabric. Use the
   [manual checklist](../../../docs/testing.md) only with authorization.
   If unavailable, record that gap; local tests are not a live smoke test.
   For a real failure, use [broken-window-check](../broken-window-check/SKILL.md) and seek approval before
   reverting shared history or expanding the task into a runtime repair.

Only after reviewing this evidence and its limits pick new work (see
[shift-notes](../shift-notes/SKILL.md) for selection heuristics).

## Anti-patterns

- **"I already know this repo, I'll skip the read."** You do not. The context you have is the context in front of you.
- **Reading the progress file but not the git log.** The prose lies; the log does not.
- **Running `init.sh` and assuming success without smoke-testing a feature.** The dev server can start clean while every route is broken.
- **Smoke-testing with unit tests.** Unit tests can pass while the feature is end-to-end broken — wrong route, missing header, config mismatch. Drive the runtime path.
- **Batching the 6 steps into "let me just get oriented."** The steps are cheap because they are fixed. Improvising the orientation is where tokens leak.

## Cost/benefit

Roughly 2-4k tokens and 30-60 seconds of wall-clock at the top of every session. Payoff crosses over past ~4 sessions on the same project; below that, the ritual is overhead. If your project is one-shot, use [verification-before-completion](../verification-before-completion/SKILL.md) instead.

## Related

- [shift-notes](../shift-notes/SKILL.md) — the prose ledger this protocol reads and writes.
- [active-memory-reminder](../active-memory-reminder/SKILL.md) — the paired JSON decisions ledger read in step 2b.
- [broken-window-check](../broken-window-check/SKILL.md) — the sub-protocol for step 6 when the smoke test fails.
- [single-feature-per-session](../../../AGENTS.md#single-feature-rule) — what to do once orientation is complete.
- [clean-state-contract](../../../AGENTS.md#clean-state-contract) — the mirror discipline at session-end that makes this protocol cheap for the next session.

When NOT to apply: single-shot sessions with no prior state, or the very first session of a project (there is nothing to read yet — run the initializer instead).
