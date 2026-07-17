# Grok Build Codex

[English](./README.md) | **简体中文**

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Release](https://img.shields.io/github/v/release/damian2848/grok-build-codex)](https://github.com/damian2848/grok-build-codex/releases)
[![Tests](https://github.com/damian2848/grok-build-codex/actions/workflows/test.yml/badge.svg)](https://github.com/damian2848/grok-build-codex/actions/workflows/test.yml)

一个有状态的 Codex 插件，让 **Codex 负责需求规划、架构设计、代码审查和最终验收**，由本地 **Grok Build CLI 负责代码落地**。

插件会在仓库内建立精简的协作协议，在独立后台 worker 中启动 Grok，把实时实现进度返回给 Codex，续接聚焦的修复会话，最后由 Codex 独立检查代码差异并运行验证。

## 工作流程

```mermaid
flowchart LR
    U[用户需求] --> C[Codex 规划与架构设计]
    C --> H[.ai-collab 协作文件]
    H --> B[独立后台桥接 Worker]
    B --> G[Grok Build CLI 代码实现]
    B --> P[实时进度跟随器]
    P --> C
    G --> W[工作区代码改动]
    W --> R[Codex 审查与验证]
    R -->|需要修复| H
    R -->|验收通过| D[完成]
```

## 功能特性

- 需求、架构、验收标准和审查结论始终由 Codex 管理。
- 通过 `.ai-collab/` 共享持久化上下文，不依赖模型之间不可见的隐藏状态。
- 可选导入当前 Codex JSONL 会话记录到 Grok 会话。
- 在独立后台 worker 中执行实现任务，并通过紧凑 JSONL 事件实时跟随进度。
- 保存任务状态、日志、桥接器 PID、Grok PID、输出内容和可恢复的 Grok 线程 ID。
- 共享任务索引只保存必要元数据，避免跟随器每次刷新都重复解析大型提示词和输出。
- 跟随器被中断或超时后，Grok worker 仍会继续运行。
- Grok 提供数据时，终态事件会报告耗时、线程 ID、Token、API 耗时、轮次与成本。
- 只流式输出 Grok 的可见文本，丢弃 `thought` 事件和私有推理内容。
- 不做版本预探测，直接启动 Grok；启动或认证失败会写入可跟踪的终态事件。
- 支持 `check`、`run`、`runs`、`show`、`stop`、`run-resume-candidate` 和 `import`。
- 取消操作优先锁定终态，避免延迟结束的进程把 `cancelled` 覆盖成 `completed`。
- 当任一任务具有写权限时，原子阻止同工作区重叠任务；自动恢复陈旧状态锁，并优先保留所有活动任务。
- 委派任务不会授权 Grok 提交、推送、切换分支、执行破坏性 Git 命令或修改凭据。
- 支持 macOS、Linux 和 Windows，包含 Node 入口、POSIX `.sh` 包装器、Windows `.cmd` 包装器、私有临时提示词文件以及 `taskkill` 进程树终止。

## 环境要求

- 支持插件的 [Codex](https://github.com/openai/codex)。
- Node.js `>= 18.18.0`。
- Git。
- 已在本机安装并完成认证的 Grok Build CLI。

如果 Codex 自身运行在沙箱中，桥接器还需要出站网络权限以及 Grok 会话目录的写权限。POSIX 系统通常是 `$HOME/.grok`，Windows 是 `%USERPROFILE%\.grok`。

安装插件前先验证 Grok：

```console
grok --version
grok models
```

## 从 GitHub 安装

将本仓库添加为 Codex 插件市场，然后安装插件：

```console
codex plugin marketplace add damian2848/grok-build-codex
codex plugin add grok-build-codex@grok-build-codex
```

安装后请新建一个 Codex 任务，让新 Skill 被正确加载。

后续更新：

```console
codex plugin marketplace upgrade grok-build-codex
codex plugin add grok-build-codex@grok-build-codex
```

## 本地开发安装

克隆仓库并添加为本地插件市场：

```console
git clone https://github.com/damian2848/grok-build-codex.git
cd grok-build-codex
codex plugin marketplace add .
codex plugin add grok-build-codex@grok-build-codex
```

## 使用方式

新建一个 Codex 任务，然后输入：

```text
使用 $delegate-to-grok 规划这个任务，把代码实现交给 Grok，完成后审查改动并验收。
```

Codex 会检查仓库、编写精简任务包、启动独立 Grok worker、展示实时进度、集中检查一次代码差异、运行约定的验证，并决定验收或将一次聚焦的修复任务发回同一个 Grok 线程。

## 实时进度

默认委派命令会在一次调用中启动后台 worker 并跟随其进度：

```console
node scripts/grok-bridge.mjs run --background --follow --stream --write --fresh --cwd /path/to/repository --prompt-file .ai-collab/task.md --model sub2api-grok
```

命令输出紧凑的逐行 JSON，Codex 任务可以直接将其展示为进度：

```json
{"type":"job.started","jobId":"task-...","status":"queued","progress":"Queued for background execution.","watcherDetachedSafe":true}
{"type":"job.progress","jobId":"task-...","status":"running","phase":"running","elapsed":"4s","progress":"Updating the bridge tests.","watcherDetachedSafe":true}
{"type":"job.completed","jobId":"task-...","status":"completed","duration":"8s","threadId":"...","metrics":{"totalTokens":220},"watcherDetachedSafe":true}
```

`job.timeout` 只表示跟随器停止等待，独立 Grok worker 仍会继续运行。可在不启动重复 worker 的情况下重新连接：

```console
node scripts/grok-bridge.mjs runs JOB_ID --follow --stream --cwd /path/to/repository
```

只有 Grok 长时间运行且主 Codex 智能体有不冲突的工作可做时，才使用一个轻量、只读的监控子智能体。普通任务应直接使用内置跟随器，避免额外的编排延迟和 Token 消耗。

## 协作文件

| 文件 | 所有者 | 用途 |
| --- | --- | --- |
| `.ai-collab/context.md` | Codex | 需求、约束、事实、决策和已有改动 |
| `.ai-collab/plan.md` | Codex | 架构设计和有序实施计划 |
| `.ai-collab/task.md` | Codex | 当前实现或修复任务 |
| `.ai-collab/acceptance.md` | Codex | 可观察的验收标准和验证命令 |
| `.ai-collab/review.md` | Codex | 独立审查发现和修复要求 |
| `.ai-collab/state.json` | Codex | 工作流阶段、迭代次数、任务 ID 和 Grok 线程 ID |
| `.ai-collab/.bridge-data/` | 桥接器 | 被忽略的运行状态、锁、日志、PID 和保存的输出 |

## 桥接命令

推荐使用跨平台 Node 入口：

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

便捷包装器：

- macOS/Linux：`scripts/init-workspace.sh` 和 `scripts/run-grok.sh`
- Windows 命令提示符：`scripts/init-workspace.cmd` 和 `scripts/run-grok.cmd`
- 全平台：`scripts/init-workspace.mjs` 和 `scripts/run-grok.mjs`

## 配置项

| 环境变量 | 用途 |
| --- | --- |
| `GROK_BINARY` | 覆盖 Grok 可执行文件路径 |
| `GROK_BINARY_ARGS_JSON` | 以 JSON 字符串数组形式配置固定前置参数，不经过 Shell 插值 |
| `GROK_CODEX_DATA` | 覆盖桥接器运行状态目录 |
| `CODEX_THREAD_ID` | 将桥接任务关联到当前 Codex 任务 |
| `CODEX_TRANSCRIPT_PATH` | 自动查找失败时显式指定 Codex JSONL 会话路径 |

## 安全模型

插件刻意将代码实现和最终验收分离：

1. Codex 管理架构和任务边界。
2. Grok 只能在任务包指定的范围内修改代码。
3. Grok 不得提交、推送、变基、重置、清理、恢复、切换分支或修改凭据。
4. Codex 独立检查差异并运行验证。
5. 只有 Codex 可以将任务标记为验收通过。

不要把 API Key、Token、Cookie、凭据文件、私有系统提示词或思维链写入 `.ai-collab/` 或会话导入内容。

## 开发与测试

```console
npm test
node --check scripts/grok-bridge.mjs
```

测试包含跨平台 Node 入口、后台状态竞态、紧凑索引、worker 启动失败处理，以及针对 Windows 命令执行、提示词文件、进程树终止和状态文件替换的模拟覆盖。GitHub Actions 会在 Linux、macOS 和 Windows 上运行测试。

优化后的路径会在同一进程内分发适配器、缓存仓库解析、保持 `state.json` 紧凑，并通过一次 `--prompt-file` 调用 Grok。普通任务不会预先执行 `grok version` 或 `grok models`；启动与认证失败会记录到对应任务。仅在首次配置、认证变化或出现此类失败后使用 `check --json`。

## 上游归属

有状态桥接运行时改编自 xAI 以 Apache-2.0 开源的 [`xai-org/grok-build-plugin-cc`](https://github.com/xai-org/grok-build-plugin-cc)，对应版本 `0.2.0`、提交 `5a9f924a8d1ca802b3e6dc0ce0e1a602fb35ec9e`。

详见 [LICENSE](./LICENSE)、[NOTICE](./NOTICE) 和 [THIRD_PARTY.md](./THIRD_PARTY.md)。

## KaiyunCode

如果你需要便捷的 AI API 中转服务来支持开发和智能体工作流，欢迎访问 **[KaiyunCode.com](https://kaiyuncode.com/)**。平台提供热门文本与多模态模型的统一 API 接入体验，并提供面向开发者的便捷集成方式。
