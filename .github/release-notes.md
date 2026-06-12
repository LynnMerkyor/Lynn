# Lynn v0.84.2 Release Notes / 发布说明

> 发布日期: 2026-06-12 · CLI 实时语音断句 + Issue #74 BYOK Key / DeepSeek 空回复修复 · 晚间热更新补齐 Brain 注册与本地模型启动加固

本次发版覆盖在线 v0.84.1，重点修复两条用户可感知主线：CLI 在当前 chat 内进入 StepFun Realtime 后只显示波形、不出回复；以及 Issue #74 里 macOS BYOK API Key 重启后清空、DeepSeek V4 Pro 偶发“只有思考没有最终答案”导致不回复。

> 2026-06-12 晚间重发同版本资产：补齐 Brain 设备注册真实 IP / 默认不限流防护、本地模型 Windows 启动黑框修复、自定义 `LYNN_HOME` 下 llama.cpp 二进制与 GGUF 查找一致性，以及 CLI 顶部流光条的低闪烁回归。

## 国内镜像站下载（推荐）

国内用户请优先使用以下镜像站地址；GitHub Assets 作为备用下载。

- **CLI**:

  ```bash
  npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.84.2.tgz"
  ```

- **macOS Apple Silicon / ARM64**: [https://download.merkyorlynn.com/downloads/Lynn-0.84.2-macOS-arm64.dmg](https://download.merkyorlynn.com/downloads/Lynn-0.84.2-macOS-arm64.dmg)
- **macOS Intel / x64**: [https://download.merkyorlynn.com/downloads/Lynn-0.84.2-macOS-x64.dmg](https://download.merkyorlynn.com/downloads/Lynn-0.84.2-macOS-x64.dmg)
- **Windows x64**: [https://download.merkyorlynn.com/downloads/Lynn-0.84.2-Windows-Setup.exe](https://download.merkyorlynn.com/downloads/Lynn-0.84.2-Windows-Setup.exe)
- **下载页**: [https://download.merkyorlynn.com/download.html](https://download.merkyorlynn.com/download.html)

## 中文重点

- **CLI 当前 chat 内实时语音修复**：`/voice` 和聊天框内输入 `lynn voice` 都会被本地拦截，直接进入同一个 StepFun Realtime 会话，不再把 `lynn voice` 发给模型回答，也不要求用户退出 chat 另开 shell。
- **CLI 波形有声修复**：CLI 麦克风改为 raw 输入默认路径，使用本地 VAD 断句并以 PTT 模式驱动 Brain Realtime commit；旧 `dynaudnorm` 滤镜只保留为 opt-in，避免抬高静音底噪后让语音轮次永远停在“🎤 在听”。模型播放期间会抑制麦克风采集，减少把回复听回去当成用户输入。
- **Issue #74 API Key 重置修复**：BYOK provider key 加密不再依赖 macOS `os.hostname()`，改为 `~/.lynn` 内固定随机 seed。能解开的旧密文会平滑读取；已经因 hostname 漂移解不开的 key 需要用户升级后重填一次，之后不再随网络/DHCP/局域网重名清空。
- **Issue #74 DeepSeek V4 空回复修复**：DeepSeek V4 Flash/Pro 标记为 DeepSeek thinking format，utility/channel/memory 非流式调用默认关闭 thinking；reasoning-only 响应会先重试一次并要求最终可见答案，仍无正文时只抽取明确“答案/结论”句兜底，主聊天流式路径也会给出可见降级提示，不再静默空屏。
- **Hanako 数据隔离延续**：Lynn 默认不再读取或迁移 `~/.hanako`，只在显式设置 `LYNN_IMPORT_HANAKO_ON_FIRST_RUN=1` 时导入，避免 OpenHanako 的已引导状态和旧模型配置污染 Lynn。
- **GUI 内容串台防护**：Brain V2 主链继续由 Brain 托管工具，不再让客户端本地预取行情/天气插入合成上下文，避免旧搜索/行情结果串入下一轮回答。
- **Brain 注册限流热修复**：设备注册限流改为读取真实客户端 IP，并且默认关闭限流；无效 body / 错误 key 不再消耗 quota，服务端记录注册 analytics，避免反向代理地址导致全网共享 5 次/天的“brain unreachable”事故复发。
- **本地模型启动加固**：Windows 启动本地 `llama-server` 时隐藏控制台窗口，修复回复时弹黑框；自定义 `LYNN_HOME` 时，下载目录和运行时查找目录保持一致，避免隔离数据目录下下载成功但启动找不到模型。
- **CLI 顶部流光条回归修复**：保留顶部流光 banner，同时放慢输入框 placeholder 轮换，避免空闲时高频闪烁。
- **v0.84.1 修复保留**：StepFun 3.7 Flash 默认主链、GUI Realtime 语音、工具 turn 收口、token/cost pipeline、Fleet 入口与发布门禁继续保留。

## 安装

```bash
# 前置:Node.js 20 LTS 或 22 LTS with npm.
node -v

# 从 Lynn 镜像安装或覆盖升级 CLI。
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.84.2.tgz"

# 启动。
Lynn            # 交互式聊天 TUI；输入 /voice 或 lynn voice 进入实时语音
Lynn code       # 编码 agent TUI
Lynn --version  # 应输出 0.84.2
Lynn agents     # 给其他智能体/Fleet 的可复制命令
```

默认 Brain V2 路由：**StepFun 3.7 Flash（256K 上下文，high 推理，48K 推理/生成预算）**。语音默认走 **Brain 托管 StepFun Realtime**。Spark / SenseVoice / CosyVoice / 系统语音只作为 fallback；BYOK 继续可用。

## 验证

- `npm run typecheck`
- `npm run typecheck:runtime`
- `npm --prefix cli run typecheck`
- `npm run build:cli`
- `node scripts/cli-voice-repl-pty-smoke.mjs`
- `npm run test:voice-step`
- `npm run build:server`
- `npm run build:main`
- `npm run build:renderer`
- `npm run test:release:static`
- CLI tarball 镜像站安装 smoke
- macOS 打包签名、公证、staple、Gatekeeper 校验

---

> Release date: 2026-06-12 · CLI realtime voice turn detection + Issue #74 BYOK key / DeepSeek empty-answer fixes · evening refresh for Brain registration and local model startup hardening

This release supersedes the online v0.84.1 build. It focuses on two user-visible paths: CLI realtime voice inside the current chat, and Issue #74 reports where macOS BYOK API keys appeared to reset and DeepSeek V4 Pro could return reasoning without a final visible answer.

> Evening same-version asset refresh: adds Brain device-registration real-IP/default-off quota hardening, Windows local-model console-window suppression, custom `LYNN_HOME` llama.cpp path consistency, and a lower-flicker CLI top banner.

## Highlights

- **CLI realtime voice inside chat**: `/voice` and `lynn voice` typed in the Lynn chat box are intercepted locally and enter the same Brain-hosted StepFun Realtime session. They are not sent to the model as normal chat text.
- **CLI waveform with real replies**: microphone capture now defaults to raw input, local VAD commits turns in PTT mode, and playback suppresses mic capture to reduce echo-as-user-input regressions. The old `dynaudnorm` filter is opt-in only because it can raise the silence floor and prevent turn commits.
- **Issue #74 BYOK key persistence**: provider API key encryption now uses a stable per-`~/.lynn` random seed instead of `os.hostname()`. Existing decryptable keys continue to load; keys already lost to hostname drift need to be re-entered once after upgrade.
- **Issue #74 DeepSeek V4 empty-answer recovery**: DeepSeek V4 Flash/Pro defaults utility calls to thinking-off. Reasoning-only responses are retried with a visible-answer nudge, then fall back only to explicit final-answer/conclusion text when available. Streaming chat also shows a visible fallback instead of going blank.
- **Hanako isolation**: Lynn no longer reads or migrates `~/.hanako` by default. Import remains opt-in via `LYNN_IMPORT_HANAKO_ON_FIRST_RUN=1`.
- **GUI crosstalk protection**: Brain V2 owns realtime tools server-side; client-side market/weather prefetch stays disabled for Brain turns so stale local results cannot leak into a later answer.
- **Brain registration hardening**: device registration now resolves the real client IP and defaults the quota to disabled; invalid bodies / bad keys no longer consume quota, and registration analytics are recorded server-side to prevent the proxy-address global-limit failure mode.
- **Local model startup hardening**: Windows local `llama-server` startup hides console windows, and custom `LYNN_HOME` installs use the same root for downloaded GGUF files and runtime discovery.
- **CLI top-banner regression fix**: the flowing-light header stays animated, while input placeholder rotation is slowed to avoid high-frequency flicker.
- **v0.84.1 fixes remain**: StepFun 3.7 Flash default routing, GUI realtime voice, honest tool-turn close, token/cost pipeline, Fleet entry points, and release gates remain in place.

## Install

```bash
# Prerequisite:Node.js 20 LTS or 22 LTS with npm.
node -v

# Install or update from the Lynn mirror.
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.84.2.tgz"

# Launch.
Lynn            # interactive chat TUI; type /voice or lynn voice for realtime voice
Lynn code       # coding-agent TUI
Lynn --version  # should print 0.84.2
Lynn agents     # copyable headless/Fleet commands
```

Default Brain V2 route: **StepFun 3.7 Flash (256K context, high reasoning, 48K reasoning/generation budget)**. Voice defaults to **Brain-hosted StepFun Realtime**. Spark / SenseVoice / CosyVoice / system voice are fallback paths only. BYOK remains available.
