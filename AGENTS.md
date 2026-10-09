# Contributor contract

Fabric Connect is a local-first VS Code extension for notebooks, files, Spark
jobs, queries and read-only Fabric browsing. Use [Architecture](docs/architecture.md)
for current boundaries and [Development](docs/development.md) for layout,
commands, debugging, packaging and releases.

This file is the shared agent guidance. `.claude/CLAUDE.md` imports it and
contains only Claude-specific context. Direct user instructions override
repository defaults.

## Plan, act, verify

1. **Plan:** read the approved task/session goal (or `PROMPT.md` if present),
   `IMPLEMENTATION_PLAN.md` and `git log --oneline -20`. If state and history
   disagree, trust git. Confirm material scope/behavior choices before editing.
2. **Act:** implement exactly one agreed feature. A coordinated documentation
   refresh is one maintenance feature; do not add unrelated runtime fixes.
3. **Verify:** run the smallest applicable checks and an independent adversarial
   review before claiming completion or committing. A failed review blocks both.
   In Claude use `/verify`; in other clients invoke the installed
   [adversarial checklist](.claude/skills/adversarial-verify/SKILL.md) and a
   separate verifier with the same goal and diff.

The tracked handoff is `IMPLEMENTATION_PLAN.md`. `PROMPT.md`, a JSON feature
ledger and `claude-progress.txt` are not required existing files. Read optional
`claude-decisions.json` only if an authorized hook/session has created it.
Do not create parallel state files just to satisfy an upstream example.

## Single-feature rule

Keep one purpose per session and commit. Preserve the requested scope.
Ask and re-plan if evidence requires a different feature or behavior change.

## Clean-state contract

- Preserve unrelated user changes. Never revert them to make the tree clean.
- Update `IMPLEMENTATION_PLAN.md` with implemented work, next steps and evidence
  gaps; keep historical details in git and the changelog.
- Stage explicit task files and use Conventional Commits:
  `type(scope): imperative description` (subject at most 72 characters).
  There is no `scripts/committer` helper installed here.
- Commit reviewed task changes when authorized; do not push to main, publish,
  deploy or change shared state without approval.
- Stop any watcher/host process started by the session. This extension has no
  web-server `init.sh`/`stop.sh` lifecycle.
- Use [manual validation](docs/testing.md) for actual VS Code/Fabric behavior
  only when authorized. Native tests and stand-ins do not prove live behavior;
  record unavailable smoke tests rather than claiming they passed.

## Installed skills and commands

Skills are installed at `.claude/skills/<name>/SKILL.md`. Read matching skills
before acting; the [routing guide](.claude/skills/using-loopkit/SKILL.md) lists
them. Generic examples about web servers, databases, feature ledgers and
upstream release templates are conditional, not this repository's structure.
No upstream `skills/`, `templates/`, presets or auto-loaded `.claude/rules/`
directory is supplied by this checkout.

Installed Claude commands:

- `/spec`: write a goal contract without overwriting an existing one unless
  `--force` is explicitly requested.
- `/verify`: read-only adversarial diff review with a JSON verdict.
- `/polish`: scoped quality pass over the current diff.
- `/next`: optional ledger-based suggestions; requires a feature ledger first.

There is no installed `/loop` command. Command Markdown is client guidance,
not an executable exit-code validator.

## Never

- Weaken tests to make a failing change pass.
- Mark work done or commit before verification.
- Change the write allowlist, auth, dependencies or runtime behavior implicitly.
- Add a dependency without a concrete justification in the commit body.
- Run broad dependency upgrades for an unrelated feature.
- Read or expose secrets, private machine configuration or credential values.

## Escalation and optional runner

When blocked, ask the human; use `hitl-escalate` only through approved channels.
Keep a sanitized block record when needed, and stop. `run.sh` does **not**
check `BLOCKED.md` or enforce the pre-commit review contract: it instructs the
executor to commit, then runs `/verify`, echoes failures and checks a
`STATUS: done` marker. Do not treat it as a safe unattended shipping harness.

The runner reads `CLAUDE_EXECUTOR_MODEL` and `CLAUDE_JUDGE_MODEL` only on its
default Claude CLI path; `LOOPKIT_CLI` bypasses those flags.
`CLAUDE_PLANNER_MODEL` is reserved but not read. See
[model routing](.claude/skills/model-routing/SKILL.md).
