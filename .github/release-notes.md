# Lynn CLI v0.80.5 Release Notes / 发布说明

> 发布日期: 2026-06-01 · CLI-only 前置缓存与长任务稳定性热修

v0.80.5 只迭代 **Lynn CLI / Lynn Code**；桌面端 GUI 仍为 v0.80.1。本版把
Reasonix 风格的前置缓存命中变成可见但低打扰的信号，同时补齐长任务工具循环中的
运行时压缩与 Brain 早期断流重试。

## 中文重点

- **前置缓存命中可见**：usage、session、replay 和 `Lynn cache doctor --json`
  统一显示 `prefix-cache ... hit`，但不在聊天界面里放 ctx% 焦虑条。
- **长任务运行时压缩**：`Lynn code --long` 会压缩旧轮次，同时保留原始目标、当前计划和最近工具结果；JSONL 发出
  `code.runtime.compacted`，人类 TUI 显示轻量信息卡。
- **Brain 早期断流自动重试**：SSE 在还没有任何可见回答、reasoning 或工具调用前断开时，CLI 会退避重试；一旦已经开始输出，就不重试，避免重复半轮工具调用。
- **计划/工具卡片继续打磨**：`update_plan` 与 resume 计划回显使用 Claude Code 风格 plan card，工具、路由、压缩状态保持同一套左 gutter 卡片语言。
- **门禁覆盖压缩路径**：`cli-longrun-smoke` 会制造大工具结果，并要求出现 `code.runtime.compacted`，避免长任务稳定性只停留在单测。

## 安装

```bash
# 前置: Node.js 20 LTS 或 22 LTS with npm.
node -v

# 从 Lynn 镜像安装或覆盖升级。
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.80.5.tgz"

# 启动。
Lynn            # 交互式聊天 TUI
Lynn code       # 编码 agent TUI
Lynn --version  # 应输出 0.80.5
Lynn agents     # 给其他智能体/Fleet 的可复制命令
```

默认 Brain 路由: **StepFun 3.7 Flash(256K 上下文, high 推理, 32K 推理/生成预算) -> MiMo V2.5 Pro/Omni -> Spark Qwen 3.6 35B A3B**。纯 CLI 首装在本地 Brain 不可达时会走 Lynn 远端 Brain；BYOK 仍可用。

---

> Release date: 2026-06-01 · CLI-only prefix-cache and long-run stability hotfix

v0.80.5 focuses on Lynn CLI / Lynn Code. The desktop app remains v0.80.1. This
release makes Reasonix-style prefix-cache behavior visible without creating
context anxiety, hardens long-running code-agent loops, and adds release gates
that prove runtime compaction happens during a real tool loop.

## Highlights

- **Prefix-cache visibility without anxiety**: usage summaries, session stats,
  replay, and `Lynn cache doctor --json` now surface `prefix-cache ... hit`
  rather than a live context-budget meter.
- **Runtime compaction in long tool loops**: `Lynn code --long` compacts older
  runtime turns while preserving the original task, current plan, and recent tool
  results. JSONL emits `code.runtime.compacted`; human output shows a lightweight
  info card.
- **Early Brain stream retry**: if a Brain SSE stream disconnects before any
  visible answer, reasoning, or tool call, the CLI retries with backoff. Once
  output has started, retries stop to avoid duplicate half-turn tool calls.
- **Plan/card polish**: `update_plan` and resume plan echoes use the same
  left-gutter plan card language as tool and route cards.
- **Release gate tightened**: `cli-longrun-smoke` now creates large tool results
  and fails unless `code.runtime.compacted` appears, so long-task stability is
  checked outside narrow unit tests.

## Install

```bash
# Prerequisite: Node.js 20 LTS or 22 LTS with npm.
node -v

# Install or update from the Lynn mirror.
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.80.5.tgz"

# Launch.
Lynn            # interactive chat TUI
Lynn code       # coding-agent TUI
Lynn --version  # should print 0.80.5
Lynn agents     # copyable headless/Fleet commands
```

Default Brain route: **StepFun 3.7 Flash (256K context, high reasoning, 32K
reasoning/generation budget) -> MiMo V2.5 Pro/Omni -> Spark Qwen 3.6 35B A3B**.
Fresh CLI installs use the hosted Lynn Brain when local Brain is unavailable;
BYOK via `Lynn providers set ...` remains available.

## Headless / Fleet

```bash
Lynn -p "summarize this repository" --json --cwd /path/to/repo

Lynn code -p "fix tests, run the suite, summarize the diff" \
  --json \
  --cwd /path/to/worktree \
  --approval yolo \
  --sandbox workspace-write \
  --save-session

Lynn worker run --brief task.md --worktree /path/to/worktree \
  --jsonl \
  --approval yolo \
  --sandbox workspace-write
```

## Verification

- `npm --prefix cli exec tsc -- --noEmit`
- `npm --prefix cli run build`
- `npm --prefix cli test` -> 60 files / 446 tests
- `npm run test:cli-fleet` -> CLI + server/desktop Fleet + long-run compaction smoke
