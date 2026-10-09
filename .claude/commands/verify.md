---
description: Run adversarial verification on the current diff before claiming done. Loads the loopkit adversarial-verify skill and dispatches the verifier subagent.
argument-hint: "[--summary]"
allowed-tools: Read, Grep, Bash(git diff:*), Bash(git status:*), Bash(git log:*)
---

# /verify — adversarial verification pass

Assume the diff is broken. Prove it isn't.

## Steps

1. Load the goal spec:
   - Read the approved task/session goal or `PROMPT.md` if present.
     Use `IMPLEMENTATION_PLAN.md` for current state and constraints.
   - If neither exists, stop and tell the user to run `/spec` first. Do not verify against an absent contract.
2. Load the current diff:
   - `git diff HEAD` — uncommitted changes.
   - `git log --oneline -5` — recent context.
3. Read `.claude/skills/adversarial-verify/SKILL.md` and walk its
   11-shortcut checklist against the diff. No separate red-flags checklist
   is installed; do not depend on an absent upstream file.
4. Dispatch the `verifier` subagent (`.claude/agents/verifier.md`) for a second, cold-context pass on the same diff.
5. Return a single JSON verdict, and nothing else:

   ```
   {"passes": bool, "failures": [{"file": str, "line": int, "shortcut": str, "why": str}]}
   ```

6. If `passes` is false: do NOT commit or mark the task done. The JSON
   failure list is the output; stop without adding prose after it.

## Never

- Propose fixes in this pass. Verification is separate from repair — mixing them lets the model rationalize.
- Run application code. Read-only tools only.
- Be polite. Politeness is how "fake done" ships.
- Skip the shortcut checklist because "the diff is small".

## Exit contract

This command file defines a verdict, not a shell program. A CLI can exit 0
while printing `{"passes": false, ...}`. A machine caller must validate the
JSON and map a failed/invalid verdict to failure explicitly. The installed
`run.sh` does not parse this JSON and only echoes a non-zero judge exit before
continuing. It is not an enforced commit gate. A client must also expose a
subagent dispatcher to perform the separate verifier step.
