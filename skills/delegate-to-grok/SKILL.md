---
name: delegate-to-grok
description: Orchestrate implementation work between Codex and the local Grok Build CLI through a stateful bridge. Use when the user asks Codex to plan requirements or architecture, delegate investigation or coding to Grok, share repository context, monitor or stop background Grok runs, resume a prior Grok thread, then independently review diffs, run validation, and send a bounded repair back to Grok.
---

# Delegate to Grok

Keep Codex responsible for requirements, architecture, review, and acceptance. Use Grok as the implementation worker. Use `.ai-collab/` for durable handoff state and the bundled bridge for Grok execution, progress, cancellation, usage, and session resume.

This file is self-contained for normal delegation. Do not read `references/protocol.md`, upstream source, or bridge implementation unless troubleshooting a concrete bridge failure.

## Core Rules

1. Never share hidden reasoning, private system prompts, credentials, or unfiltered transcripts.
2. Let the bridge own Grok UUIDs, resume routing, detached workers, PID tracking, logs, usage, cancellation, and terminal state.
3. Never accept Grok's completion claim without inspecting the diff and running independent validation.
4. Do not let Grok commit, push, switch branches, run destructive Git commands, edit credentials, or rewrite unrelated user changes.
5. Keep review strictly aligned with the requested contract. Do not create repair rounds for hypothetical behavior outside requirements and acceptance criteria.

## Performance Defaults

Use the shortest workflow that preserves correctness:

- Do not run `check` before every delegation. A normal run invokes Grok directly without a version or models preflight and records launch/authentication failures on the tracked job. Use `check` for first-time setup, after authentication changes, or after such a failure.
- Inspect repository state once with grouped reads. Do not repeatedly print full files, full diffs, or the protocol.
- For a bounded task, write one self-contained `.ai-collab/task.md`; do not populate and reread every collaboration template.
- Import the Codex transcript only when repository files and the task packet cannot carry required context.
- Launch one detached Grok worker and follow it in the same bridge command. Do not poll from repeated Codex turns.
- After success, review the diff once and run the declared validation once. Add targeted checks only for a concrete uncovered risk.
- Do not call `show` after a successful followed run unless its final summary reports a blocker or the diff is ambiguous.

## Establish the Baseline

Read applicable `AGENTS.md`, the task description, relevant source/tests, and existing user diffs. Confirm repository root, branch, HEAD, and `git status --short`. Preserve pre-existing changes.

Initialize `.ai-collab/` only when missing:

```text
node <skill-dir>/../../scripts/init-workspace.mjs --workspace <workspace>
```

The bridge stores ignored runtime state under `.ai-collab/.bridge-data/`. Use Node entry points on macOS, Linux, and Windows.

## Build a Compact Handoff

For bounded work, write only `.ai-collab/task.md` and update `.ai-collab/state.json`. The task packet must contain:

1. Exact outcome and current iteration.
2. Required repository files to read.
3. Scope and explicit non-goals.
4. Fixed architecture decisions and behavioral invariants.
5. Existing changes that must be preserved.
6. Exact validation commands.
7. Blocked conditions and the completion report contract.

Use `.ai-collab/context.md`, `plan.md`, and `acceptance.md` as separate documents only for substantial cross-module work where they materially reduce ambiguity. Do not duplicate their full contents into `task.md`; reference them.

Always include these guardrails:

- Do not commit, push, rebase, reset, clean, restore, switch branches, or edit credentials.
- Do not redesign architecture or broaden scope; report a blocker instead.
- Do not claim validation passed unless it ran successfully.
- Leave the worktree ready for independent Codex review.

## Dispatch and Visualize

Default to a detached worker with a compact JSONL follower:

```text
node <skill-dir>/../../scripts/grok-bridge.mjs run --background --follow --stream --write --fresh --cwd <workspace> --prompt-file .ai-collab/task.md --model sub2api-grok
```

This single command:

- returns the job ID immediately in a `job.started` event;
- keeps Grok running in a detached worker;
- streams compact `job.progress` events without exposing Grok thought events;
- emits one terminal event with status, thread ID, duration, summary, and available token/cost metrics;
- lets the worker continue if the follower is interrupted or reaches its timeout.

The bridge rejects a new job when it could overlap an active write-capable job in the same workspace. Wait for the active job or stop it explicitly; do not bypass the conflict guard with a second bridge data directory.

Do not wrap this command in additional shell polling. Capture the job ID and Grok thread ID from its events, then update `.ai-collab/state.json` once after the terminal event.

For fire-and-continue behavior, omit `--follow --stream`:

```text
node <skill-dir>/../../scripts/grok-bridge.mjs run --background --write --fresh --cwd <workspace> --prompt-file .ai-collab/task.md --model sub2api-grok --json
```

Follow an existing job without starting another worker:

```text
node <skill-dir>/../../scripts/grok-bridge.mjs runs <job-id> --follow --stream --cwd <workspace>
```

Inspect or stop a job:

```text
node <skill-dir>/../../scripts/grok-bridge.mjs runs <job-id> --cwd <workspace> --json
node <skill-dir>/../../scripts/grok-bridge.mjs stop <job-id> --cwd <workspace> --json
```

The bridge claims `cancelled` before terminating process trees, so late worker completion cannot overwrite cancellation.

## Optional Monitor Subagent

Do not spawn a Codex subagent merely to poll; the follower is faster and cheaper. Use exactly one lightweight monitor subagent only when all are true:

- Codex multi-agent tools are available;
- the Grok task is long-running;
- the main Codex agent has useful non-conflicting work to do while Grok edits;
- the monitor is instructed not to edit repository files.

The monitor assignment is limited to running `runs <job-id> --follow --stream`, returning the terminal event, and reporting a user-action request. The main Codex agent remains responsible for review and acceptance. Never let the monitor and main agent review a changing worktree concurrently.

## Review and Validate

After the terminal event:

1. Inspect `git status --short`, `git diff --stat`, `git diff --check`, and the relevant diff.
2. Compare behavior against the task packet and repository conventions.
3. Run the exact acceptance commands.
4. Confirm branch and HEAD did not move and no unrelated files changed.
5. Record only actionable findings in `.ai-collab/review.md` and update `.ai-collab/state.json`.

Only Codex decides whether the task is accepted.

## Focused Repair

Allow one Grok repair round by default. Use `--resume` so the same thread retains implementation context:

```text
node <skill-dir>/../../scripts/grok-bridge.mjs run --background --follow --stream --write --resume --cwd <workspace> --prompt-file .ai-collab/task.md --model sub2api-grok
```

The repair packet must contain only concrete, contract-relevant findings. Re-run the affected validation and the final acceptance suite. Ask the user before additional repair rounds unless the original request explicitly authorizes them.

## Failure Handling

- If Grok exits nonzero, inspect the worktree because partial edits may exist.
- If a terminal event reports DNS/network denial or Grok session storage permission failure, do not spend multiple turns probing Grok internals. Report the exact failure and required Codex sandbox capability.
- A sandboxed Codex CLI invocation may need `-c 'sandbox_workspace_write.network_access=true' --add-dir "$HOME/.grok"`; on Windows use the equivalent `%USERPROFILE%\.grok` path.
- If authentication fails, run `check --json` once and report its next steps. Do not invent another authentication flow.
- If the bridge rejects a conflicting run, follow or stop the reported active job instead of launching an untracked Grok process.
- If concurrent edits appear, stop and reconcile ownership before another run.

## Final Handoff

Report what Codex planned, what Grok changed, the bridge job/thread IDs, terminal usage when available, validation actually run, review decision, and remaining risks. Do not commit or push unless separately requested.
