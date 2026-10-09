---
name: active-memory-reminder
description: Before compaction Loopkit extracts decisions into claude-decisions.json (machine-readable). Read it alongside claude-progress.txt at session start — prose is for humans, JSON is for the loop.
when_to_use: session start, after /clear, after compaction — before touching code; whenever a decision from a prior session is load-bearing for what you are about to do
---

# Active Memory Reminder

In Fabric Connect the tracked prose handoff is `IMPLEMENTATION_PLAN.md`.
`claude-progress.txt` and `feature_list.json` below are optional upstream
examples. Read `claude-decisions.json` only if it has been created and is safe
to read; an absent file is not a reason to create another state ledger.

Loopkit splits shift-notes across two files on purpose:

- **`claude-progress.txt`** — free-form prose. Human-readable narrative of what the last session did, what is in flight, what to pick up next. Wins for context and intent. Loses when the model needs to _decide_ whether a decision was made.
- **`claude-decisions.json`** — machine-readable array of `{ts, decision}` entries, appended by the loopkit `pre-compact` hook every time the transcript is about to be compacted. Wins for durability of specific choices ("chose Postgres over SQLite because…", "rejected the polling approach", "tried htmx and switched to Alpine").

Compaction is where reasoning dies. The summarizer keeps the shape of the work but strips the _why_. `claude-decisions.json` is the durable side-channel that survives that. This is the same pattern Meta's NapMem paper calls out for behavioral-state-decay in long-running agents: prose degrades faster than structured facts because the model rewrites prose freely and edits structured data carefully (also why loopkit uses JSON for `feature_list.json`; see [feature-list-json](../feature-list-json/SKILL.md)).

## When to apply

- **Session start / post-/clear / post-compact.** Read `claude-decisions.json` right after `claude-progress.txt` and before you look at code. If both files disagree, the JSON is the more recent hard record of a specific choice; the prose gives you the reason.
- **Before re-litigating a design choice.** If you're about to propose "let's use X instead of Y," grep `claude-decisions.json` first. If a prior session already rejected X and wrote it down, don't burn the token budget re-deriving that.
- **When picking up mid-implementation work.** Decisions frame constraints the progress file may not restate.

## File contract

`claude-decisions.json` is a JSON array. Every entry is `{ts, decision}`:

```json
[
  {
    "ts": "2026-07-14T18:22:09Z",
    "decision": "chose Playwright MCP over Puppeteer because Puppeteer's alert-modal blind spot bit us in run 41"
  },
  {
    "ts": "2026-07-14T20:04:11Z",
    "decision": "rejected the daemon-per-project approach; switched to a single supervisor with per-project subdirs"
  },
  {
    "ts": "2026-07-15T09:31:44Z",
    "decision": "tried and failed to cache the plan across sessions — plan went stale within two sessions, dropped"
  }
]
```

Constraints:

- Append-only in normal operation. The `pre-compact` hook appends; sessions read.
- You MAY add a decision by hand if you make one mid-session that the hook won't catch (e.g., a decision made in code, not prose). Use the same shape. Do not rewrite or delete existing entries — they are the durable record.
- If entries contradict, newer wins, but note the contradiction in `claude-progress.txt` so the reason is captured.

## The hook

When invoked by a supporting client with a usable transcript and `jq`,
`.claude/hooks/pre-compact` skims decision-like phrases, deduplicates hits
within that invocation, caps them at 20 and appends timestamped entries.
It does not deduplicate against the existing ledger or validate the truth
of a decision. Most handled failures log to stderr without blocking;
invocation and successful persistence are not guaranteed in every client.
It also does not sanitize extracted text. Do not put sensitive content in
the transcript or trust a generated ledger as a secret-safe memory store.

## Anti-patterns

- **Reading `claude-progress.txt` and skipping `claude-decisions.json`.** You will re-open settled questions. The prose file often omits _why we didn't do the other thing_ — that's what the JSON is for.
- **Editing or deleting past decisions to "clean them up."** Same rule as `feature_list.json` steps and descriptions: durable structured records are load-bearing. Contradict them in a new entry; don't erase the old one.
- **Storing prose in `claude-decisions.json`.** It is not a second progress file. Entries are single decisions with a timestamp, nothing else.
- **Assuming the hook caught it.** The regex catches most decisions but not all. If you made a decision the transcript won't obviously match, add it by hand before ending the session.

## Related

- [progress-reading-protocol](../progress-reading-protocol/SKILL.md) — session-opening sequence; step 2b reads this file.
- [feature-list-json](../feature-list-json/SKILL.md) — the other structured-over-prose file loopkit relies on.
- [shift-notes](../shift-notes/SKILL.md) — the prose companion this file is paired with.
- [clean-state-contract](../../../AGENTS.md#clean-state-contract) — session-end discipline that keeps the pairing usable.
