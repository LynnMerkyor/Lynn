# Lynn v0.84.1 Release Notes / 发布说明

> 发布日期: 2026-06-12 · StepFun 默认主链稳定性 + 实时语音 + Hanako 数据隔离 + GUI 空答修复 + 发版门禁补强

本次发版把 Lynn CLI 与桌面 GUI 同步到 **v0.84.1**。默认对话和任务执行统一回到 **StepFun 3.7 Flash 一条龙主链**，语音主入口统一到 **Brain 托管 StepFun Realtime**，优先保证“能正常对话、能完成工具任务、能自然实时说话”。本地蒸馏 A3B manager 仍作为显式 `Lynn manager run` 能力保留，但不会抢占默认 GUI/CLI 对话链路；考虑本地并发与稳定性，默认编排器切换继续暂缓。

## 国内镜像站下载（推荐）

国内用户请优先使用以下镜像站地址；GitHub Assets 作为备用下载。

- **CLI**:

  ```bash
  npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.84.1.tgz"
  ```

- **macOS Apple Silicon / ARM64**: [https://download.merkyorlynn.com/downloads/Lynn-0.84.1-macOS-arm64.dmg](https://download.merkyorlynn.com/downloads/Lynn-0.84.1-macOS-arm64.dmg)
- **macOS Intel / x64**: [https://download.merkyorlynn.com/downloads/Lynn-0.84.1-macOS-x64.dmg](https://download.merkyorlynn.com/downloads/Lynn-0.84.1-macOS-x64.dmg)
- **Windows x64**: [https://download.merkyorlynn.com/downloads/Lynn-0.84.1-Windows-Setup.exe](https://download.merkyorlynn.com/downloads/Lynn-0.84.1-Windows-Setup.exe)
- **下载页**: [https://download.merkyorlynn.com/download.html](https://download.merkyorlynn.com/download.html)

## 中文重点

- **GUI 空答根因修复**：旧会话复用过期设备签名时，客户端会为每次请求刷新签名；工具链最终答案晚到时，Brain 不再 8 秒硬关流并丢弃 late final answer。
- **StepFun 3.7 Flash 默认主链**：普通 GUI/CLI 对话、`Lynn -p`、编码执行默认走 StepFun 3.7 Flash。Spark/A3B manager 仅在显式 `Lynn manager run` 或后续实验链路中使用。
- **实时语音主入口**：GUI 麦克风与 CLI 当前 chat 内 `/voice` / `lynn voice` 默认进入 Brain 托管 StepFun Realtime 连续对话；CLI 在聊天框下方显示状态与采样波形。`--file/--record` ASR 转写和 `--speak` TTS 朗读仍作为辅助工具保留。
- **reasoning-only 空答重试**：Brain 在源头识别“只有思考、没有可见正文”的响应并重试，避免用户看到“思考完但不说话”。
- **工具 turn 收口更诚实**：工具完成后如果仍需等待模型最终答复，会显示事实性的工具完成状态，不再静默关闭或伪造本地总结。
- **GUI token/cost pipeline**：SDK usage → WebSocket → store → 输入行 chip 打通，桌面端能长期显示会话 token/cost 状态。
- **Fleet 可发现性与验收面板**：桌面端增加 Fleet 入口和 acceptance panel，方便把 Lynn 作为黑灯工厂 worker 调度。
- **Issue #72/#74 数据隔离与自愈**：Lynn 默认不再读取或迁移 `~/.hanako`，只在显式设置 `LYNN_IMPORT_HANAKO_ON_FIRST_RUN=1` 时导入；已被旧版污染的 `~/.lynn` 会在启动时把已下线 MiMo/TokenPlan 模型引用修回 Brain 默认路由，同时保留用户 API key。
- **安全与 BUG 修复附带**：设备签名刷新、工具 turn 收口、reasoning-only 空答重试、Fleet 验收面板、发布门禁与文档漂移检查随本版一起落地。

## 安装

```bash
# 前置:Node.js 20 LTS 或 22 LTS with npm.
node -v

# 从 Lynn 镜像安装或覆盖升级 CLI。
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.84.1.tgz"

# 启动。
Lynn            # 交互式聊天 TUI；输入 /voice 或 lynn voice 进入实时语音
Lynn code       # 编码 agent TUI
Lynn --version  # 应输出 0.84.1
Lynn agents     # 给其他智能体/Fleet 的可复制命令
```

默认 Brain V2 路由：**StepFun 3.7 Flash（256K 上下文，high 推理，48K 推理/生成预算）**。语音默认走 **Brain 托管 StepFun Realtime**。本地 A3B / Spark 继续作为显式高端本地档与实验 manager/fallback 能力存在，不作为普通 GUI/CLI 默认主链。BYOK 仍可用。

## 验证

- `npm run release:preflight`
- `npm run gate:startup`
- `npm run gate:cli-task`
- `npm run test:voice-cli`
- `npm run test:release:ui`
- `npm run test:release:static`
- CLI tarball 镜像站安装 smoke
- macOS 打包签名、公证、staple、Gatekeeper 校验

---

> Release date: 2026-06-12 · StepFun default-route stability + realtime voice + Hanako data isolation + GUI empty-answer recovery + release gates

This release unifies Lynn CLI and desktop GUI at **v0.84.1**. The default chat and task path is now the direct **StepFun 3.7 Flash** route again, and the default voice path is Brain-hosted **StepFun Realtime**. The priority is the baseline product contract: normal conversation works, tool tasks complete, final answers are visible, and realtime voice feels natural. The local distilled A3B manager remains available through explicit `Lynn manager run`, but it does not take over the default GUI/CLI path. Default local-manager routing remains deferred until local concurrency and stability are proven.

## Highlights

- **GUI empty-answer recovery**: stale device signatures are refreshed per request, and Brain no longer closes a tool turn after 8 seconds if the final assistant answer is still arriving.
- **StepFun 3.7 Flash default**: normal GUI/CLI chat, `Lynn -p`, and coding execution use StepFun 3.7 Flash by default. Spark/A3B manager is explicit only.
- **Realtime voice default**: GUI microphone and `/voice` / `lynn voice` inside the CLI chat use Brain-hosted StepFun Realtime for continuous conversation; CLI renders status and a live waveform below the chat. ASR transcription and TTS save commands remain auxiliary.
- **reasoning-only retry**: Brain retries responses that contain reasoning but no visible answer at the source.
- **honest tool-turn close**: tool completion is rendered factually while waiting for the model's final answer; no silent close and no fake local summary.
- **GUI token/cost pipeline**: SDK usage now flows through WebSocket, store, and the input-row chip.
- **Fleet discoverability and acceptance panel**: desktop Fleet entry points and acceptance UI are easier to find and inspect.
- **Issue #72/#74 data isolation and repair**: Lynn no longer reads or migrates `~/.hanako` by default; import is opt-in via `LYNN_IMPORT_HANAKO_ON_FIRST_RUN=1`. Existing polluted `~/.lynn` installs repair retired MiMo/TokenPlan model references back to the Brain default route while preserving user API keys.
- **Safety and bug-fix rollup**: device-signature refresh, honest tool-turn close, reasoning-only retry, Fleet acceptance UI, release gates, and doc-drift checks ship together in this release.

## Install

```bash
# Prerequisite:Node.js 20 LTS or 22 LTS with npm.
node -v

# Install or update from the Lynn mirror.
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.84.1.tgz"

# Launch.
Lynn            # interactive chat TUI; type /voice or lynn voice for realtime voice
Lynn code       # coding-agent TUI
Lynn --version  # should print 0.84.1
Lynn agents     # copyable headless/Fleet commands
```

Default Brain V2 route: **StepFun 3.7 Flash (256K context, high reasoning, 48K reasoning/generation budget)**. Voice defaults to **Brain-hosted StepFun Realtime**. Local A3B/Spark remains available as an explicit high-end local tier and experimental manager/fallback path, but it is not the ordinary GUI/CLI default. BYOK remains available.
