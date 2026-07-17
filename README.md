# Grok Build Codex

**English** | [简体中文](./README.zh-CN.md)

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Release](https://img.shields.io/github/v/release/damian2848/grok-build-codex)](https://github.com/damian2848/grok-build-codex/releases)
[![Tests](https://github.com/damian2848/grok-build-codex/actions/workflows/test.yml/badge.svg)](https://github.com/damian2848/grok-build-codex/actions/workflows/test.yml)

A stateful Codex plugin that lets **Codex plan, design, review, and accept**, while the local **Grok Build CLI implements the code**.

The plugin creates a compact collaboration contract in the repository, starts Grok in a detached worker, streams live implementation progress back to Codex, resumes focused repair sessions, and returns control to Codex for independent diff review and validation.

## Workflow

```mermaid
flowchart LR
    U[User request] --> C[Codex planning and architecture]
    C --> H[.ai-collab handoff files]
    H --> B[Detached bridge worker]
    B --> G[Grok Build CLI implementation]
    B --> P[Live progress follower]
    P --> C
    G --> W[Worktree changes]
    W --> R[Codex review and validation]
    R -->|repair required| H
    R -->|accepted| D[Done]
```

## Features

- Keeps requirements, architecture, acceptance criteria, and review decisions owned by Codex.
- Shares durable context through `.ai-collab/` instead of relying on hidden model state.
- Optionally imports the current Codex JSONL transcript into a Grok session.
- Runs implementation in a detached worker and follows it with compact live JSONL events.
- Stores job state, logs, worker PID, Grok PID, output, and resumable Grok thread IDs.
- Keeps the shared job index metadata-only so large prompts and outputs are not reparsed on every follower refresh.
- Keeps the Grok worker running if the follower is interrupted or times out.
- Reports terminal duration, thread ID, token usage, API duration, turns, and cost when Grok provides them.
- Streams visible Grok text while discarding `thought` events and private reasoning.
- Launches Grok directly without a version preflight; startup and authentication failures become tracked terminal events.
- Supports `check`, `run`, `runs`, `show`, `stop`, `run-resume-candidate`, and `import`.
- Uses cancellation-first terminal-state handling so a late worker cannot overwrite `cancelled` with `completed`.
- Atomically blocks overlapping jobs when either job can write, recovers stale state locks, and preserves all active jobs before pruning terminal history.
- Prevents delegated instructions from authorizing commits, pushes, branch switching, destructive Git commands, or credential edits.
- Supports macOS, Linux, and Windows with Node entry points, POSIX `.sh` wrappers, Windows `.cmd` wrappers, private temporary prompt files, and `taskkill` process-tree cancellation.

## Requirements

- [Codex](https://github.com/openai/codex) with plugin support.
- Node.js `>= 18.18.0`.
- Git.
- A locally installed and authenticated Grok Build CLI.

When Codex itself runs in a sandbox, the bridge also needs outbound network access and write access to Grok's session directory. On POSIX systems this is normally `$HOME/.grok`; on Windows it is `%USERPROFILE%\.grok`.

Verify Grok before installing the plugin:

```console
grok --version
grok models
```

## Install from GitHub

Add this repository as a Codex plugin marketplace, then install the plugin:

```console
codex plugin marketplace add damian2848/grok-build-codex
codex plugin add grok-build-codex@grok-build-codex
```

Start a new Codex task after installation so the new skill is loaded.

To update later:

```console
codex plugin marketplace upgrade grok-build-codex
codex plugin add grok-build-codex@grok-build-codex
```

## Local Development Install

Clone the repository and add it as a local marketplace:

```console
git clone https://github.com/damian2848/grok-build-codex.git
cd grok-build-codex
codex plugin marketplace add .
codex plugin add grok-build-codex@grok-build-codex
```

## Use

Start a new Codex task and ask:

```text
Use $delegate-to-grok to plan this task, delegate implementation to Grok, and review the result.
```

Codex will inspect the repository, write a compact task packet, start a detached Grok worker, show live progress, inspect the resulting diff once, run the declared validation, and either accept the work or send one focused repair request back to the same Grok thread.

## Live Progress

The default delegation command starts a background worker and follows it in one invocation:

```console
node scripts/grok-bridge.mjs run --background --follow --stream --write --fresh --cwd /path/to/repository --prompt-file .ai-collab/task.md --model sub2api-grok
```

It emits compact newline-delimited JSON that a Codex task can display as progress:

```json
{"type":"job.started","jobId":"task-...","status":"queued","progress":"Queued for background execution.","watcherDetachedSafe":true}
{"type":"job.progress","jobId":"task-...","status":"running","phase":"running","elapsed":"4s","progress":"Updating the bridge tests.","watcherDetachedSafe":true}
{"type":"job.completed","jobId":"task-...","status":"completed","duration":"8s","threadId":"...","metrics":{"totalTokens":220},"watcherDetachedSafe":true}
```

`job.timeout` means only the follower stopped waiting. The detached Grok worker continues. Reconnect without starting another worker:

```console
node scripts/grok-bridge.mjs runs JOB_ID --follow --stream --cwd /path/to/repository
```

Use one lightweight, read-only Codex monitor subagent only for a long Grok run when the main agent has non-conflicting work. Normal tasks should use the built-in follower directly to avoid extra orchestration latency and tokens.

## Collaboration Files

| File | Owner | Purpose |
| --- | --- | --- |
| `.ai-collab/context.md` | Codex | Requirements, constraints, facts, decisions, and existing changes |
| `.ai-collab/plan.md` | Codex | Architecture and ordered implementation plan |
| `.ai-collab/task.md` | Codex | Current implementation or repair assignment |
| `.ai-collab/acceptance.md` | Codex | Observable acceptance criteria and validation commands |
| `.ai-collab/review.md` | Codex | Independent findings and repair requirements |
| `.ai-collab/state.json` | Codex | Workflow phase, iteration, job ID, and Grok thread ID |
| `.ai-collab/.bridge-data/` | Bridge | Ignored runtime state, locks, logs, PIDs, and stored output |

## Bridge Commands

Use the platform-independent Node entry point:

```console
node scripts/grok-bridge.mjs check --cwd /path/to/repository --json
node scripts/grok-bridge.mjs run --background --follow --stream --write --fresh --cwd /path/to/repository --prompt-file .ai-collab/task.md --model sub2api-grok
node scripts/grok-bridge.mjs runs JOB_ID --follow --stream --cwd /path/to/repository
node scripts/grok-bridge.mjs runs --cwd /path/to/repository --json
node scripts/grok-bridge.mjs show JOB_ID --cwd /path/to/repository --json
node scripts/grok-bridge.mjs stop JOB_ID --cwd /path/to/repository --json
node scripts/grok-bridge.mjs run-resume-candidate --cwd /path/to/repository --json
node scripts/grok-bridge.mjs import --cwd /path/to/repository --json
```

Convenience wrappers:

- macOS/Linux: `scripts/init-workspace.sh` and `scripts/run-grok.sh`
- Windows Command Prompt: `scripts/init-workspace.cmd` and `scripts/run-grok.cmd`
- All platforms: `scripts/init-workspace.mjs` and `scripts/run-grok.mjs`

## Configuration

| Environment variable | Purpose |
| --- | --- |
| `GROK_BINARY` | Override the Grok executable path |
| `GROK_BINARY_ARGS_JSON` | JSON string array of fixed arguments prepended without shell interpolation |
| `GROK_CODEX_DATA` | Override the bridge runtime-state directory |
| `CODEX_THREAD_ID` | Associates bridge jobs with the current Codex task |
| `CODEX_TRANSCRIPT_PATH` | Explicit Codex JSONL transcript path when automatic discovery fails |

## Safety Model

The plugin deliberately separates implementation from acceptance:

1. Codex owns architecture and scope.
2. Grok edits only within the task packet.
3. Grok may not commit, push, rebase, reset, clean, restore, switch branches, or edit credentials.
4. Codex independently inspects the diff and runs validation.
5. Only Codex may mark the task accepted.

Do not put API keys, tokens, cookies, credential files, private system prompts, or chain-of-thought in `.ai-collab/` or transcript imports.

## Development

```console
npm test
node --check scripts/grok-bridge.mjs
```

The test suite includes cross-platform Node entry points, background-state race coverage, compact-index checks, worker bootstrap failure handling, and simulated Windows coverage for command execution, prompt files, process-tree cancellation, and state-file replacement. GitHub Actions runs the suite on Linux, macOS, and Windows.

The optimized path dispatches the adapter in-process, caches repository resolution, keeps `state.json` compact, and invokes Grok once with `--prompt-file`. Normal runs do not execute `grok version` or `grok models` first; launch and authentication failures are recorded on the tracked job. Use `check --json` only for setup, authentication changes, or after such a failure.

## Attribution

The stateful bridge runtime is adapted from xAI's Apache-2.0 licensed [`xai-org/grok-build-plugin-cc`](https://github.com/xai-org/grok-build-plugin-cc), version `0.2.0`, commit `5a9f924a8d1ca802b3e6dc0ce0e1a602fb35ec9e`.

See [LICENSE](./LICENSE), [NOTICE](./NOTICE), and [THIRD_PARTY.md](./THIRD_PARTY.md).

## KaiyunCode

Need a convenient AI API relay for development and agent workflows? Visit **[KaiyunCode.com](https://kaiyuncode.com/)** for a unified API access experience covering popular text and multimodal models, with developer-friendly integration options.
