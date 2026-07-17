# Codex-Grok Bridge Protocol

## Architecture

Use two state layers:

1. `.ai-collab/*.md` and `.ai-collab/state.json` are human-readable, Codex-owned collaboration state.
2. `.ai-collab/.bridge-data/` is ignored runtime state owned by the bundled xAI bridge: locked job indexes, per-job records, logs, PIDs, and stored output.

The Codex adapter maps `CODEX_THREAD_ID` to the upstream bridge's session ownership field. This lets `runs` and `run-resume-candidate` prefer jobs started from the current Codex task.

The default execution path has two processes:

1. A detached bridge worker owns the Grok process and persists job state.
2. A lightweight follower reads persisted progress and emits compact events to Codex.

Stopping, interrupting, or timing out the follower does not terminate the worker. Cancellation must go through `stop`.

## Workflow State

Use these phases in `.ai-collab/state.json`:

1. `initialized`
2. `planned`
3. `delegated`
4. `reviewing`
5. `repair_requested`
6. `accepted`
7. `blocked`

Only Codex changes the phase to `accepted`. Increment `iteration` immediately before each Grok run. Keep `iteration <= max_iterations` unless the user explicitly authorizes more.

## Ownership

| Resource | Owner | Purpose |
| --- | --- | --- |
| `context.md` | Codex | Requirements, constraints, facts, decisions |
| `plan.md` | Codex | Architecture and ordered implementation plan |
| `task.md` | Codex | Current implementation or repair assignment |
| `acceptance.md` | Codex | Observable criteria and validation commands |
| `review.md` | Codex | Independent findings and repair requirements |
| `state.json` | Codex | Workflow phase, bridge job, Grok thread, iteration |
| `.bridge-data/` | Bridge | Locks, jobs, logs, PIDs, output, terminal state |
| Source and tests | Grok | Implementation inside the assigned scope |

Grok may read Codex-owned files but must not rewrite them unless the task explicitly asks it to update implementation-facing documentation.

## Bridge Commands

Run all commands through:

```text
node <skill-dir>/../../scripts/grok-bridge.mjs <command>
```

Supported commands inherited from the xAI bridge:

- `check`: verify Node, Grok CLI, and soft authentication.
- `run`: start a write-capable or read-only Grok task.
- `review`: ask Grok for an independent read-only code review.
- `critique`: ask Grok for structured design/risk critique.
- `runs`: list or wait on tracked jobs.
- `show`: render stored output.
- `stop`: claim cancellation and terminate tracked process trees.
- `run-resume-candidate`: find the latest resumable task thread.

Codex adapter additions:

- `import`: locate and import the current Codex JSONL transcript.
- `delegate`: alias for `run`.
- `status`: alias for `runs`.
- `cancel`: alias for `stop`.

## Fast Delegation Path

For normal implementation work, use one compact handoff and one bridge command:

```text
node <skill-dir>/../../scripts/grok-bridge.mjs run --background --follow --stream --write --fresh --cwd <workspace> --prompt-file .ai-collab/task.md --model sub2api-grok
```

`run --follow` always launches a detached worker before following it. Do not add shell polling around this command. Use `runs <job-id> --follow --stream` to reconnect to an existing worker.

The run path invokes Grok directly and does not execute a version or models probe first. Binary, startup, and authentication failures are recorded as tracked terminal failures. Use the standalone `check` command for first-time setup, authentication changes, or after one of those failures.

For bounded work, `.ai-collab/task.md` plus `state.json` is sufficient. Split context, plan, and acceptance into separate files only when the task is large enough to benefit from them. Transcript import is optional and should be used only when the repository handoff cannot carry required context.

## Follower Event Contract

With `--stream`, stdout is newline-delimited JSON. Event types are:

- `job.started`: the detached worker was queued and includes its `jobId`.
- `job.progress`: status, phase, elapsed time, and the latest visible Grok text progress.
- `job.completed`, `job.failed`, or `job.cancelled`: terminal status with thread, duration, summary, error, and metrics when available.
- `job.timeout`: the follower reached `--timeout-ms`; the detached worker is still running.

Every event includes `watcherDetachedSafe: true`. Terminal `metrics` can include input, cached input, output, reasoning, and total tokens, model calls, API duration, turns, and cost when Grok reports them.

The Grok process uses `streaming-json`. Only user-visible `text` events enter progress and stored output. `thought` events and other private reasoning are deliberately discarded. Non-JSON stdout is retained as a compatibility fallback.

Follower tuning options:

- `--timeout-ms`: stop following without cancelling the worker.
- `--poll-interval-ms`: persisted-state refresh interval.
- `--heartbeat-ms`: maximum quiet interval before a heartbeat progress event.

Do not use a Codex subagent only to poll. One read-only monitor subagent is appropriate only for a genuinely long task when the main Codex agent has useful, non-conflicting work. Its sole responsibility is following the known job and returning the terminal event.

## Session Rules

- Let the bridge create a random UUID for every fresh Grok thread.
- Use bridge `--resume` or `--resume-last` to continue the latest tracked thread.
- Never pass a human-readable string to Grok's `--session-id`; current Grok CLI requires a valid UUID and uses `-r` for resuming.
- Store the reported bridge job ID and Grok thread ID in `.ai-collab/state.json`.
- Treat transcript import as optional context transfer, not as a replacement for tracked delegation.

## Background Run Safety

The bundled runtime follows the xAI reference implementation:

- write the job file before spawning the detached worker;
- reserve jobs atomically and reject same-workspace overlap when either active or candidate work can write;
- track `bridgePid` and `agentPid` separately;
- keep full requests/results in per-job files and only compact metadata in the shared index;
- use atomic writes, recover abandoned state locks, and prune terminal history before active jobs;
- claim terminal state with compare-and-set semantics;
- let `cancelled` win over late `completed` writes;
- stop both process trees when available.

Do not manually edit `.bridge-data/` while a run is active.

## Task Packet Checklist

Every task must answer:

1. What exact outcome is required?
2. What is out of scope?
3. Which files or modules are relevant?
4. Which architecture decisions are fixed?
5. Which existing changes must be preserved?
6. Which commands prove the work?
7. What should Grok report at completion?
8. What conditions should be reported as blocked?

## Completion Contract

Ask Grok to end with:

```text
STATUS: completed | partial | blocked
CHANGED: comma-separated files
VALIDATION: commands and pass/fail results
RISKS: remaining risks or "none"
BLOCKERS: blockers or "none"
```

Treat this as navigation, not acceptance evidence.

## Review Gates

Codex must verify:

- scope and unrelated changes;
- behavior and edge cases;
- architecture and interface compatibility;
- secrets, destructive operations, and migration safety;
- error handling and maintainability;
- tests and proportional coverage;
- preservation of user changes;
- absence of unexpected commits or branch movement.

Review the diff once after the terminal event and run the declared validation once. Request a repair only for a concrete contract or acceptance failure. Default to one focused repair through `--resume`; additional rounds require user authorization unless already requested.

## Failure Handling

- If Grok exits nonzero, inspect the worktree before retrying because partial edits may exist.
- If stored output is malformed, do not infer success from logs.
- If baseline tests already fail, separate baseline failures from regressions.
- If concurrent edits appear, stop and reconcile ownership before another run.
- If the same finding persists after two repairs, stop the loop and report it.
- If cancellation reports a process may still be running, inspect `runs <job-id>` and the stored PID details before starting another worker.
- If a follower times out, reconnect with `runs <job-id> --follow --stream`; do not start a duplicate worker.
- If Codex sandboxing blocks network access or Grok session storage, enable network access and make the user Grok directory writable. POSIX environments commonly need `--add-dir "$HOME/.grok"`; Windows needs the equivalent `%USERPROFILE%\.grok` directory.
