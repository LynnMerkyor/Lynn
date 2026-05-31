# Lynn v0.80.1 Release Notes

> 发布日期:2026-05-31 · 稳定性热修

v0.80.1 是 v0.80 CLI Worker Fleet 的稳定性热修版本,重点把 **Lynn 客户端 GUI 内置 CLI** 和公开 CDN CLI 包对齐,并减少 CLI 更新提示对交互会话的打断。

## 重点修复

- **GUI 内置 CLI 对齐 CDN CLI**:重新打包 macOS GUI,内置 `Lynn` / `Lynn code` / `Lynn worker` 运行时与当前 `@lynn/cli` 包保持一致。
- **CLI 更新提示降噪**:同版本 build 热修不再弹交互确认;只有真正版本号升级才提示用户接受更新,升级失败也不影响当前版本继续使用。
- **StepFun/MiMo 路由说明修正**:明确 StepFun 3.7 Flash 是 256K 上下文,high 推理,32K 是推理/生成预算而不是上下文窗口。
- **远端 Brain 默认可用**:纯 CLI 用户在本地 Lynn Brain 不可达时会自动回到 Lynn 远端 Brain,无需先安装或打开 Lynn 客户端即可开始体验。
- **发布入口同步**:README、CLI README、下载镜像站和 GitHub Release 均更新 Node 要求、CLI 安装命令、启动命令和 Fleet/headless 调用说明。

## CLI 安装

```bash
# 1. Node requirement: Node.js 20 LTS or 22 LTS with npm.
node -v

# 2. Install or update Lynn CLI from the CDN.
npm install -g --force https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.80.1.tgz

# 3. Launch.
Lynn            # interactive chat TUI
Lynn code       # coding-agent TUI
Lynn --version  # should print 0.80.1
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

v0.80.1 is a stability hotfix for the v0.80 CLI Worker Fleet release. It rebuilds the macOS desktop app with the latest embedded Lynn CLI, reduces same-version build update prompts, clarifies the StepFun 256K context / 32K reasoning budget wording, and keeps the CDN CLI install and GitHub Release documentation aligned.
