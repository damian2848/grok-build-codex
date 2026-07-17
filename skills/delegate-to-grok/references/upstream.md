# Upstream Runtime

The bundled bridge runtime is adapted from:

- Repository: `xai-org/grok-build-plugin-cc`
- Commit: `5a9f924a8d1ca802b3e6dc0ce0e1a602fb35ec9e`
- Version: `0.2.0`
- License: Apache-2.0

The upstream runtime is stored under the plugin root at `scripts/upstream/`. The Codex adapter at `scripts/grok-bridge.mjs`:

- maps `CODEX_THREAD_ID` to the upstream run ownership environment;
- stores bridge state under the current repository's `.ai-collab/.bridge-data` directory;
- imports Codex transcripts from `~/.codex/sessions` or `~/.codex/archived_sessions`;
- exposes `delegate`, `status`, and `cancel` aliases for `run`, `runs`, and `stop`.

See this directory's `upstream/LICENSE` and `upstream/NOTICE`, plus the plugin root `LICENSE` and `NOTICE`, for attribution.
