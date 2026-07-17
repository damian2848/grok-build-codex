---
name: delegate-to-grok
description: Orchestrate implementation work between Codex and the local Grok Build CLI through a stateful bridge. Use when the user asks Codex to plan requirements or architecture, delegate investigation or coding to Grok, share the current Codex transcript or repository context, monitor or stop background Grok runs, resume a prior Grok thread, then independently review diffs, run validation, and send bounded repair rounds back to Grok.
---

# Delegate to Grok

Keep Codex responsible for requirements, architecture, review, and acceptance. Use Grok as the implementation worker. Use the bundled stateful bridge for execution and `.ai-collab/` files for the durable handoff contract.

The bridge runtime is adapted from xAI's `grok-build-plugin-cc`. Read [references/protocol.md](references/protocol.md) for the collaboration protocol and [references/upstream.md](references/upstream.md) for attribution.

## Core Rules

1. Never treat hidden reasoning or private conversation state as shared context.
2. Keep requirements, decisions, acceptance criteria, and review findings in `.ai-collab/`.
3. Let the bridge own Grok UUID creation, resume routing, PID tracking, logs, cancellation, and terminal status.
4. Never invent a Grok session ID. New sessions require a UUID; continuation must use the stored thread ID through `--resume`.
5. Never accept Grok's completion claim without inspecting the diff and running independent validation.
6. Do not let Grok commit, push, change branches, or rewrite unrelated user changes.

## Check Readiness

Before the first delegation in a task, run:

```text
node <skill-dir>/../../scripts/grok-bridge.mjs check --cwd <workspace> --json
```

Ready means Node is available, `grok` is on `PATH` or configured with `GROK_BINARY`, and `grok models` succeeds. If authentication fails, stop and report the bridge output instead of inventing another auth flow.

## Inspect and Establish a Baseline

1. Read every applicable `AGENTS.md`.
2. Confirm the repository root and current branch.
3. Inspect `git status --short`, `git diff --stat`, and relevant existing diffs.
4. Record pre-existing user changes in `.ai-collab/context.md`; never discard them.
5. Do not delegate if the user requested planning, discussion, or review only.

Initialize missing collaboration files:

```text
node <skill-dir>/../../scripts/init-workspace.mjs --workspace <workspace>
```

Use the Node entry points on macOS, Linux, and Windows. Optional convenience wrappers are provided as `.sh` for POSIX shells and `.cmd` for Windows Command Prompt.

The bridge stores ignored runtime data under `.ai-collab/.bridge-data/`. Human-readable planning files remain separate from bridge process state.

## Share Context

Use two complementary channels:

- **Durable repository context:** `.ai-collab/context.md`, `plan.md`, `task.md`, `acceptance.md`, and `review.md`.
- **Optional transcript import:** import the current Codex JSONL when Grok needs the broader conversation history.

Import the current Codex task transcript with:

```text
node <skill-dir>/../../scripts/grok-bridge.mjs import --cwd <workspace> --json
```

The adapter resolves `CODEX_THREAD_ID` under `~/.codex/sessions` or `~/.codex/archived_sessions`. Pass `--source <jsonl>` only when automatic resolution fails. Transcript import prints a `grok -r <uuid>` hint but does not replace the repository handoff files.

Never place API keys, tokens, cookies, credential files, private system prompts, or chain-of-thought in shared context.

## Plan the Work

Inspect the repository before writing the plan. Use `apply_patch` to update Codex-owned collaboration files.

Write:

- `.ai-collab/context.md`: objective, constraints, repository facts, decisions, assumptions, and existing changes.
- `.ai-collab/plan.md`: architecture, interfaces, invariants, ordered implementation steps, and risks.
- `.ai-collab/acceptance.md`: observable behavior, compatibility requirements, exact tests, and manual checks.
- `.ai-collab/task.md`: one self-contained Grok assignment.
- `.ai-collab/state.json`: phase, iteration, last bridge job ID, and Grok thread ID reported by the bridge.

Keep Codex ownership of architecture. Ask for user input only when a missing decision is material and a conservative assumption would be unsafe.

## Build the Grok Task Packet

The task must include:

1. Exact objective and current iteration.
2. Required reading: applicable `AGENTS.md` and all relevant `.ai-collab/` files.
3. Scope, non-goals, and fixed architecture decisions.
4. Existing changes that must be preserved.
5. Exact validation commands.
6. Conditions that should be reported as blocked rather than guessed.
7. A concise completion contract listing changed files, tests, risks, and blockers.

Always include these constraints:

- Do not commit, push, rebase, reset, clean, restore, switch branches, or edit credentials.
- Do not redesign architecture or broaden scope without reporting a blocker.
- Do not claim a test passed unless it actually ran successfully.
- Leave the worktree ready for independent Codex review.

## Delegate Implementation

Use foreground execution for bounded tasks:

```text
node <skill-dir>/../../scripts/grok-bridge.mjs run --write --fresh --cwd <workspace> --prompt-file .ai-collab/task.md --model sub2api-grok --json
```

`--write` intentionally enables Grok's write-capable mode. The user's request to delegate implementation authorizes repository edits, but not commits, pushes, destructive Git operations, credential changes, or production actions.

For long tasks, queue a tracked background run:

```text
node <skill-dir>/../../scripts/grok-bridge.mjs run --background --write --fresh --cwd <workspace> --prompt-file .ai-collab/task.md --model sub2api-grok --json
```

Capture the returned job ID in `.ai-collab/state.json`. The bridge records both the worker PID and Grok child PID.

## Monitor, Show, and Stop

List current-task runs:

```text
node <skill-dir>/../../scripts/grok-bridge.mjs runs --cwd <workspace> --json
```

Wait for a known job:

```text
node <skill-dir>/../../scripts/grok-bridge.mjs runs <job-id> --wait --cwd <workspace> --json
```

Show stored output:

```text
node <skill-dir>/../../scripts/grok-bridge.mjs show <job-id> --cwd <workspace> --json
```

Stop a queued or running job:

```text
node <skill-dir>/../../scripts/grok-bridge.mjs stop <job-id> --cwd <workspace> --json
```

The bridge claims `cancelled` before terminating process trees so a finishing worker cannot overwrite cancellation with `completed`.

## Resume for Repairs

Before a follow-up, check whether the current Codex task owns a resumable Grok thread:

```text
node <skill-dir>/../../scripts/grok-bridge.mjs run-resume-candidate --cwd <workspace> --json
```

Use `--resume` for a repair or explicit continuation:

```text
node <skill-dir>/../../scripts/grok-bridge.mjs run --write --resume --cwd <workspace> --prompt-file .ai-collab/task.md --model sub2api-grok --json
```

Use `--fresh` for unrelated work. Do not resume a thread merely because one exists; preserve task and architecture continuity.

## Review and Validate

Do not accept bridge output as evidence. Independently:

1. Inspect `git status --short`, `git diff --stat`, `git diff --check`, and the full relevant diff.
2. Compare changes against the plan, acceptance criteria, repository patterns, and applicable instructions.
3. Run the narrowest relevant tests first, then broader checks when risk warrants them.
4. Check correctness, error handling, security, migrations, compatibility, scope, and missing tests.
5. Confirm no unexpected commit or branch change occurred.
6. Write findings to `.ai-collab/review.md` with severity and file/line references.
7. Update `.ai-collab/state.json` with the bridge job ID, Grok thread ID, iteration, and decision.

Only Codex decides whether the task is accepted.

## Repair Loop

Allow at most three Grok implementation rounds by default.

For each failed review:

1. Preserve the original architecture and acceptance criteria.
2. Rewrite `.ai-collab/task.md` as a focused repair packet referencing `.ai-collab/review.md`.
3. Use `--resume` so Grok continues the tracked thread.
4. Ask Grok to change only what the findings require.
5. Repeat the entire independent review and relevant validation.

Stop when the same issue survives two repair attempts, a product decision is missing, credentials or external systems are unavailable, concurrent edits conflict, or validation would cause an unapproved destructive or production action.

## Final Handoff

Report what Codex planned, what Grok implemented, what Codex independently reviewed, exact validation results, and remaining risks. Do not commit or push unless the user separately requests it.
