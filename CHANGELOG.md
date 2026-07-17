# Changelog

All notable changes to this project will be documented in this file.

## [0.3.0] - 2026-07-17

### Added

- Detached Grok workers with a compact live JSONL follower for visual task progress.
- `--follow`, `--stream`, `--timeout-ms`, polling, and heartbeat controls for tracked runs.
- Terminal thread, duration, token usage, API duration, turn, and cost metrics when available.
- Streaming JSON parsing that exposes visible text while discarding Grok thought events.
- Atomic same-workspace conflict prevention and stale state-lock recovery.

### Changed

- Removed run-path version probes; Grok launch and authentication failures now surface through tracked terminal events.
- Dispatch the Codex adapter in-process, cache workspace/state resolution, and keep the shared job index free of full prompts and outputs.
- Pass prompts through private temporary `--prompt-file` inputs to avoid Windows command-line limits and process-list exposure.
- Bound follower progress, summary, and error fields while preserving complete output for `show`.
- Made compact task packets, on-demand transcript import, one-pass review, and one focused repair the default workflow.
- Kept detached workers alive when a follower is interrupted or reaches its timeout.
- Treat Grok streaming error events as failed runs even if the child process exits zero.
- Documented optional read-only monitor subagents and Codex sandbox requirements on POSIX and Windows.

### Fixed

- Prevented the enqueue parent from regressing an already-running worker to `queued` or clearing its Grok PID.
- Converted worker bootstrap and detached-spawn failures into tracked terminal failures instead of leaving jobs stuck.
- Preserve active jobs during history pruning and commit state before best-effort artifact cleanup.

## [0.2.0] - 2026-07-17

### Added

- Initial public release of the Codex-to-Grok stateful delegation plugin.
- Codex-owned planning, architecture, review, acceptance, and bounded repair workflow.
- Foreground and tracked background Grok Build CLI execution.
- Codex transcript import and Grok thread resume support.
- Cross-platform Node entry points with POSIX and Windows wrappers.
- Windows process-tree cancellation and state-file replacement compatibility.
- Linux, macOS, and Windows GitHub Actions test matrix.
