# Lynn CLI v0.80.2 Release Notes

> 发布日期:2026-05-31 · CLI-only 体验与稳定性热修

v0.80.2 只迭代 **Lynn CLI / Lynn Code**。桌面端 GUI 仍停在 v0.80.1,CLI 可以领先一个版本,用于快速修复终端输入稳定性、补齐 Apple Terminal 体验、保留 Ink TUI、decode TPS 与 Fleet/headless 调用能力。

## 重点修复与体验

- **Apple Terminal / 中文输入稳定性**:保留 Ink TUI、输入框、状态栏和 decode TPS,但在 Apple Terminal 自动关闭高频流光/扫描动画、动态 placeholder 和内联图片转义,规避 macOS Terminal + IME 绘制崩溃。
- **完整 TUI 保留**:iTerm2、kitty、VS Code Terminal 等继续使用完整流光等待、Markdown 表格/代码高亮、diff 预览、多行输入、图片/音频/视频路径提示和底部速度表。
- **`-p` / headless 更适合其他智能体**:`Lynn -p`、`Lynn code -p --json`、`Lynn worker run --jsonl` 均不进入 TUI,适合作为 CLI Fleet worker 或被 Claude Code / Codex CLI / Kimi Code 静默调用。
- **同版本更新不打断会话**:同版本 build 热修不弹确认;只有真正版本号升级才提示。升级失败不影响当前版本继续使用。
- **远端 Brain 默认可用**:纯 CLI 用户本地 Brain 不可达时自动使用 Lynn 远端 Brain,无需先安装或打开 Lynn 客户端即可开始体验。

## CLI 安装

```bash
# 1. Node requirement: Node.js 20 LTS or 22 LTS with npm.
node -v

# 2. Install or update Lynn CLI from the CDN.
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.80.2.tgz"

# 3. Launch.
Lynn            # interactive chat TUI
Lynn code       # coding-agent TUI
Lynn --version  # should print 0.80.2
Lynn agents     # copyable headless/Fleet commands for other agents
```

默认 Brain V2 路由为 **StepFun 3.7 Flash(256K 上下文,high 推理,32K 推理/生成预算) → MiMo V2.5 Pro/Omni → Spark Qwen 3.6 35B A3B**。纯 CLI 用户也可以用 `Lynn providers set ...` 绑定自己的 OpenAI 兼容端点。

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

## English Summary

v0.80.2 is a CLI-only stability and UX hotfix. It keeps the modern Ink TUI while using a conservative Apple Terminal profile for Chinese IME stability, preserves decode TPS and headless/Fleet commands, keeps same-version build refreshes quiet, and ships as a CDN tarball without requiring a desktop app.
