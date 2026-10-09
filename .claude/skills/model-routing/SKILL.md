---
name: model-routing
description: Split the Plan/Act/Verify loop across three model tiers — frontier planner, cheap executor, frontier judge — via env vars read by run.sh.
when_to_use: when a long unattended loop is being tuned for cost, or when you want a stronger judge than executor.
---

# Model routing

`run.sh` reads two optional model variables on its default `claude -p`
path. Unset variables use the CLI default. If `LOOPKIT_CLI` is set, the
runner ignores these model flags. The planner variable is reserved but
not read by the runner.

These knobs do not make the runner an enforced review gate; see
[its current limitations](../../../docs/development.md#contributor-workflow).

## The three knobs

- `CLAUDE_PLANNER_MODEL` — reserved for `/spec` workflows that draft PROMPT.md up front. Not read by the current `run.sh` loop, but claimed here so future planner passes bind to it.
- `CLAUDE_EXECUTOR_MODEL` — used on the "do the next step" call. This is the workhorse; it runs on every iteration. Pick something cheap and fast.
- `CLAUDE_JUDGE_MODEL` — used on the `/verify` call. Runs once per iteration to adversarially check the executor's diff. Pick a frontier model — a weak judge is worse than no judge.

## Recommended shape

```
planner  = frontier   (Opus-class, runs once at /spec time)
executor = cheap-fast (Haiku-class, runs every turn)
judge    = frontier   (Opus-class, runs every turn but on a small diff)
```

## Example

```bash
export CLAUDE_EXECUTOR_MODEL="<valid-executor-model-id>"
export CLAUDE_JUDGE_MODEL="<valid-judge-model-id>"
./run.sh
```

Replace placeholders with IDs accepted by your installed CLI. The planner
is a separate, explicitly invoked step, not a third runner invocation.

## The Elvis Executor+Judge finding

A cheap executor paired with a frontier judge outperforms a frontier executor with no judge on long loops. The judge catches the executor's premature-victory claims that a mono-model run rationalises away when it runs out of context. Cost stays low because the judge only sees the diff, not the working history.
