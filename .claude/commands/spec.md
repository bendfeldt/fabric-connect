---
description: Write the goal spec (PROMPT.md) before implementing. Loads the loopkit spec-first skill.
argument-hint: "[--force]"
allowed-tools: Read, Write, Bash(ls:*)
---

# /spec — write the goal spec before you act

Without an external contract, the agent drifts after ~3 iterations and the failure looks like progress (code written, tests pass, wrong goal solved).

## Steps

1. If `PROMPT.md` exists and `--force` was NOT passed, stop and print:
   > `PROMPT.md` already exists. Re-run with `/spec --force` to overwrite, or edit the file directly.
2. Load the `spec-first` skill from `.claude/skills/spec-first/SKILL.md`.
3. Write `PROMPT.md` with these sections from the user's latest turn.
   No templates directory is installed. If the client already has an
   approved session goal/plan, use that contract instead of duplicating it:
   - **Goal** — one sentence, user-observable outcome.
   - **Done when** — concrete, testable conditions. Include the exact command that must go green.
   - **Never touch** — files and areas off-limits.
   - **Stop if** — abort conditions (scope creep, passing test starts failing, more than N files change outside scope).
4. Update `IMPLEMENTATION_PLAN.md` without discarding existing state. If the
   optional runner is explicitly used, preserve its `STATUS:` marker and
   set it to `not-started`; the runner stops only on `STATUS: done`.
5. Print the actual goal/state paths and STOP. Do not implement in the
   same turn. Do not claim a `PROMPT.md` was created when a session contract
   was used instead.

## Refuse if

- The user's request is too vague to write "Done when" concretely. Ask 1–3 clarifying questions and stop.
- The task is a one-line refactor or a typo fix. `/spec` is for tasks with more than 2 steps.

## Never

- Skip `PROMPT.md` because the task "seems small".
- Edit `PROMPT.md` after acting to match what you shipped. That is drift, not spec.
- Start writing code in the same turn as `/spec`. The user reviews first.
