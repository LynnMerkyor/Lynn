# Lynn v0.84.0 Release Notes / 发布说明

> 发布日期: 2026-06-10 · StepFun 默认主链稳定性 + GUI 空答修复 + 发版门禁补强

本次发版把 Lynn CLI 与桌面 GUI 同步到 **v0.84.0**。默认对话和任务执行统一回到 **StepFun 3.7 Flash 一条龙主链**，优先保证“能正常对话、能完成工具任务、能给出最终答案”。本地蒸馏 A3B manager 仍作为显式 `Lynn manager run` 能力保留，但不会抢占默认 GUI/CLI 对话链路；考虑本地并发与稳定性，默认编排器切换继续暂缓。

## 中文重点

- **GUI 空答根因修复**：旧会话复用过期设备签名时，客户端会为每次请求刷新签名；工具链最终答案晚到时，Brain 不再 8 秒硬关流并丢弃 late final answer。
- **StepFun 3.7 Flash 默认主链**：普通 GUI/CLI 对话、`Lynn -p`、编码执行默认走 StepFun 3.7 Flash。Spark/A3B manager 仅在显式 `Lynn manager run` 或后续实验链路中使用。
- **reasoning-only 空答重试**：Brain 在源头识别“只有思考、没有可见正文”的响应并重试，避免用户看到“思考完但不说话”。
- **工具 turn 收口更诚实**：工具完成后如果仍需等待模型最终答复，会显示事实性的工具完成状态，不再静默关闭或伪造本地总结。
- **GUI token/cost pipeline**：SDK usage → WebSocket → store → 输入行 chip 打通，桌面端能长期显示会话 token/cost 状态。
- **Fleet 可发现性与验收面板**：桌面端增加 Fleet 入口和 acceptance panel，方便把 Lynn 作为黑灯工厂 worker 调度。
- **Issue #72 回归门禁**：新增 GUI headless 启动恢复门禁、CLI 真任务门禁、release SOP 和文档漂移检查，覆盖 legacy memory db、Hanako/OpenHanako 冲突和“能启动但不能对话”的回归。

## 安装

```bash
# 前置:Node.js 20 LTS 或 22 LTS with npm.
node -v

# 从 Lynn 镜像安装或覆盖升级 CLI。
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.84.0.tgz"

# 启动。
Lynn            # 交互式聊天 TUI
Lynn code       # 编码 agent TUI
Lynn --version  # 应输出 0.84.0
Lynn agents     # 给其他智能体/Fleet 的可复制命令
```

默认 Brain V2 路由：**StepFun 3.7 Flash（256K 上下文，high 推理，48K 推理/生成预算）**。本地 A3B / Spark 继续作为显式高端本地档与实验 manager 能力存在，不作为普通 GUI/CLI 默认主链。BYOK 仍可用。

## 验证

- `npm run release:preflight`
- `npm run gate:startup`
- `npm run gate:cli-task`
- `npm run test:release:ui`
- `npm run test:release:static`
- CLI tarball 镜像站安装 smoke
- macOS 打包签名、公证、staple、Gatekeeper 校验

---

> Release date: 2026-06-10 · StepFun default-route stability + GUI empty-answer recovery + release gates

This release unifies Lynn CLI and desktop GUI at **v0.84.0**. The default chat and task path is now the direct **StepFun 3.7 Flash** route again, prioritizing the baseline product contract: normal conversation works, tool tasks complete, and the final answer is visible. The local distilled A3B manager remains available through explicit `Lynn manager run`, but it does not take over the default GUI/CLI path. Default local-manager routing remains deferred until local concurrency and stability are proven.

## Highlights

- **GUI empty-answer recovery**: stale device signatures are refreshed per request, and Brain no longer closes a tool turn after 8 seconds if the final assistant answer is still arriving.
- **StepFun 3.7 Flash default**: normal GUI/CLI chat, `Lynn -p`, and coding execution use StepFun 3.7 Flash by default. Spark/A3B manager is explicit only.
- **reasoning-only retry**: Brain retries responses that contain reasoning but no visible answer at the source.
- **honest tool-turn close**: tool completion is rendered factually while waiting for the model's final answer; no silent close and no fake local summary.
- **GUI token/cost pipeline**: SDK usage now flows through WebSocket, store, and the input-row chip.
- **Fleet discoverability and acceptance panel**: desktop Fleet entry points and acceptance UI are easier to find and inspect.
- **Issue #72 gates**: headless GUI startup recovery, real CLI task execution, release SOP, doc-drift checks, and repo hygiene gates were added.

## Install

```bash
# Prerequisite:Node.js 20 LTS or 22 LTS with npm.
node -v

# Install or update from the Lynn mirror.
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.84.0.tgz"

# Launch.
Lynn            # interactive chat TUI
Lynn code       # coding-agent TUI
Lynn --version  # should print 0.84.0
Lynn agents     # copyable headless/Fleet commands
```

Default Brain V2 route: **StepFun 3.7 Flash (256K context, high reasoning, 48K reasoning/generation budget)**. Local A3B/Spark remains available as an explicit high-end local tier and experimental manager path, but it is not the ordinary GUI/CLI default. BYOK remains available.
