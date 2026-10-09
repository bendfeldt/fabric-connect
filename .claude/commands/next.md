---
description: Draft suggested next features into feature_list.suggestions.json (separate from feature_list.json)
allowed-tools: Read, Write, Bash(git log:*), Bash(jq:*), Bash(cat:*)
---

# /next — propose new features without touching feature_list.json

Use when the ledger is dry (`jq '[.[]|select(.passes==false)]|length' feature_list.json` → 0) or the spec has quietly grown past what the list covers.

## Steps

1. Confirm `feature_list.json` exists. This repository does not currently
   use that optional ledger; if absent, explain the prerequisite and stop
   rather than inventing one.
2. Load `.claude/skills/suggest-next-features/SKILL.md`. Read the available
   git history and handoff (`IMPLEMENTATION_PLAN.md` here), then compare
   against the supplied ledger. Do not assume a scaffold commit or
   `claude-progress.txt` exists.
3. Write 5–10 candidates to `feature_list.suggestions.json` at the project root (overwrite any prior draft).
4. Print a one-line summary per suggestion: `[category] description — rationale`.
5. Stop. Do not touch `feature_list.json`. Do not commit the suggestions file. The human hand-merges the entries they want.

## Never

- Edit `feature_list.json` from this command. The immutability contract in [feature-list-json](../skills/feature-list-json/SKILL.md) wins.
- Propose more than 10 at once — long lists get skimmed, not read.
- Commit `feature_list.suggestions.json`. It is a proposal, not project state.
