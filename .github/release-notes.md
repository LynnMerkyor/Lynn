# Lynn CLI v0.80.9 / GUI v0.80.3 Release Notes / 发布说明

> 发布日期: 2026-06-06 · 端侧模型策略 + 工具扫描守卫

本次发版同步更新 **Lynn CLI v0.80.9** 与 **Lynn GUI v0.80.3**。CLI 侧重点是
端侧 9B/35B 与云端 StepFun 3.7 Flash 的角色分工、可观测运行时状态和工具扫描守卫;GUI 侧同步
本地模型策略与 provider/route 展示。

## 中文重点

- **默认云端 StepFun,本地模型显式启用**:StepFun 3.7 Flash 继续作为主路由;本地 9B 只在用户明确启用时启动,默认不占 GPU/统一内存。
- **端侧 9B 工程策略**:KV cache 复用、warm pool 默认关闭、空闲自动 unload、小上下文、稳定前缀、3-5 个工具 schema、底栏本地 TPS 和失败升云 StepFun。
- **端侧 35B/Spark 定位清晰**:35B/Spark 是显式高端本地档与第三兜底,不是默认主路由,避免误伤普通用户机器。
- **运行时自知**:`Lynn version`、运行时回答和 `docs/ops/lynn-cli-runtime-knowledge.md` 会解释本地模型、记忆、前置缓存、decode TPS、checkpoint/resume/rewind 与 Fleet worker 的真实能力。
- **CLI 工具扫描守卫**:交互式工具里禁止默认执行 `find / ...` 这类全盘扫描;glob 遇到 `.Trash` 或权限目录会跳过并记录,不再把整轮弄失败。

## 安装

```bash
# 前置: Node.js 20 LTS 或 22 LTS with npm.
node -v

# 从 Lynn 镜像安装或覆盖升级。
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.80.9.tgz"

# 启动。
Lynn            # 交互式聊天 TUI
Lynn code       # 编码 agent TUI
Lynn --version  # 应输出 0.80.9
Lynn agents     # 给其他智能体/Fleet 的可复制命令
```

默认 Brain 路由: **StepFun 3.7 Flash(256K 上下文, high 推理, 32K 推理/生成预算) -> MiMo V2.5 Pro/Omni -> Spark Qwen 3.6 35B A3B**。纯 CLI 首装在本地 Brain 不可达时会走 Lynn 远端 Brain;BYOK 仍可用。

---

> Release date: 2026-06-06 · local model routing policy + scan guards

This release ships **Lynn CLI v0.80.9** and **Lynn GUI v0.80.3**. The CLI focuses
on matching local 9B/35B inference with the cloud StepFun 3.7 Flash route, runtime
observability, and safer tool scans. The GUI carries the same local-model policy
into provider and route surfaces.

## Highlights

- **Cloud StepFun remains the default**: StepFun 3.7 Flash stays the primary route; local 9B only starts after explicit user action and no longer consumes GPU/unified memory by default.
- **Local 9B runtime policy**: KV cache reuse, warm pool off by default, idle unload, small-context prompts, stable prefix, 3-5 tool schemas, visible local TPS, and automatic promotion to StepFun when local inference fails.
- **Local 35B/Spark positioning**: 35B/Spark is the explicit high-end local tier and third fallback, not the default primary path.
- **Runtime self-knowledge**: `Lynn version`, local runtime answers, and `docs/ops/lynn-cli-runtime-knowledge.md` explain local models, memory, prefix cache, decode TPS, checkpoint/resume/rewind, and Fleet workers from inside Lynn.
- **CLI scan guards**: tool mode blocks default `find / ...` whole-disk scans; glob skips `.Trash` and permission-denied directories instead of failing the whole turn.

## Install

```bash
# Prerequisite: Node.js 20 LTS or 22 LTS with npm.
node -v

# Install or update from the Lynn mirror.
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.80.9.tgz"

# Launch.
Lynn            # interactive chat TUI
Lynn code       # coding-agent TUI
Lynn --version  # should print 0.80.9
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
  --sandbox danger-full-access \
  --save-session

Lynn worker run --brief task.md --worktree /path/to/worktree \
  --jsonl \
  --approval yolo \
  --sandbox danger-full-access
```

## Verification

- `npm run typecheck`
- `npm run test:brain-v2`
- `npm run test:cli`
- `npm run test:cli-cache-usage`
- `npm run test:cli-toolchain`
- `npm run test:cli-file-size`
- `npm run test:cli-pack`
- `npm run test:cli-install`
- GUI build/sign/notarize gates for the desktop artifacts
