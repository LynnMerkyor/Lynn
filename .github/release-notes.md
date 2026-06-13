# Lynn v0.84.3 Release Notes / 发布说明

> 发布日期: 2026-06-13 · Agent 本地文件任务热修 + GUI/CLI 工具边界门禁 + BYOK 内容过滤误杀修复

本次热修覆盖 v0.84.2，重点修复默认模型下 Lynn Agent 在 GUI / CLI 里处理本地文件、小说章节、代码与工具任务时的两个高频问题：模型错误声明“无法访问本地文件系统”，以及部分本地模型把伪 `<tool_call>` 文本直接吐到界面里。此次覆盖包还追加修复 #74 里暴露的 BYOK 输入侧内容过滤误杀。

## 国内镜像站下载（推荐）

国内用户请优先使用以下镜像站地址；GitHub Assets 作为备用下载。

- **CLI**:

  ```bash
  npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.84.3.tgz"
  ```

- **macOS Apple Silicon / ARM64**: [https://download.merkyorlynn.com/downloads/Lynn-0.84.3-macOS-arm64.dmg](https://download.merkyorlynn.com/downloads/Lynn-0.84.3-macOS-arm64.dmg)
- **macOS Intel / x64**: [https://download.merkyorlynn.com/downloads/Lynn-0.84.3-macOS-x64.dmg](https://download.merkyorlynn.com/downloads/Lynn-0.84.3-macOS-x64.dmg)
- **Windows x64**: [https://download.merkyorlynn.com/downloads/Lynn-0.84.3-Windows-Setup.exe](https://download.merkyorlynn.com/downloads/Lynn-0.84.3-Windows-Setup.exe)
- **下载页**: [https://download.merkyorlynn.com/download.html](https://download.merkyorlynn.com/download.html)

## 中文重点

- **GUI / CLI 本地文件任务修复**：默认模型现在会收到真实本地 workspace 摘要；“找本地第一章小说”“读桌面文件”“查看当前目录”这类只读任务不再被模型误判成无权限。
- **本地文件直接回答兜底**：对简单只读文件搜索，Lynn 会先用本地扫描结果给模型提供确定上下文；能直接回答的文件暗号/章节内容会稳定返回，避免云端或本地模型凭空拒绝。
- **工具边界修复**：Brain 托管的实时工具与客户端本地工具分离，只过滤 Brain 自己管理的工具，不再把 GUI/CLI 的本地文件、搜索、代码工具整批压掉。
- **本地 Qwen direct bridge 收窄**：utility / coding 任务不再绕过工具链直连本地模型，避免本地 A3B / 9B 在需要工具时只靠语言猜测。
- **伪工具调用清理**：如果模型输出 `<tool_call>` / `<function=...>` 这类模拟工具文本，服务端流式与前端渲染都会清理，不再把假工具 XML 展示给用户。
- **BYOK 内容过滤误杀修复**：普通软件反馈/报错描述不再被短词片段误判拦截；BYOK / 本地模型命中过滤时默认只记录警告，不再硬拦用户自己的模型调用。
- **过滤错误文案修复**：`error.contentFiltered` 不再裸露内部 key，拦截时会显示“本地内容安全过滤 + 命中类别”。
- **Provider Key 状态更清楚**：模型设置页会在已保存且可解密的 API Key 输入框显示“已保存，留空保持不变”；不能解密的旧 Key 不再假装已配置，用户重填一次后即可稳定保存。
- **Agent 任务矩阵门禁**：新增 release gate，覆盖 GUI + CLI 本地小说/文件读取、路由分类、工具边界、伪工具泄漏与 live smoke，防止今晚修过的问题再次回归。
- **v0.84.2 修复保留**：CLI 实时语音断句、BYOK Key 持久化、Brain 注册限流、本地模型启动、DeepSeek 空答恢复等修复继续保留。

## 安装

```bash
# 前置:Node.js 20 LTS 或 22 LTS with npm.
node -v

# 从 Lynn 镜像安装或覆盖升级 CLI。
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.84.3.tgz"

# 启动。
Lynn            # 交互式聊天 TUI；输入 /voice 或 lynn voice 进入实时语音
Lynn code       # 编码 agent TUI
Lynn --version  # 应输出 0.84.3
Lynn agents     # 给其他智能体/Fleet 的可复制命令
```

默认 Brain V2 路由：**StepFun 3.7 Flash（256K 上下文，high 推理，48K 推理/生成预算）**。语音默认走 **Brain 托管 StepFun Realtime**。Spark / SenseVoice / CosyVoice / 系统语音只作为 fallback；BYOK 继续可用。

## 验证

- `npm run typecheck`
- `npm run typecheck:runtime`
- `npm run build:server`
- `npm run build:main`
- `npm run build:renderer`
- `npm run build:cli`
- `npm test`
- `npm run test:release:static`
- `npm run test:release:ui`
- `npm run gate:startup`
- `npm run gate:cli-task`
- `npm run gate:gui-task`
- `npm run gate:agent-matrix`
- CLI tarball 镜像站安装 smoke
- macOS 打包签名、公证、staple、Gatekeeper 校验

---

> Release date: 2026-06-13 · Agent local-file task hotfix + GUI/CLI tool-boundary gate + BYOK content-filter false-positive fix

This hotfix supersedes v0.84.2. It targets two user-visible failures in default-model GUI/CLI agent workflows: local file and novel-reading tasks incorrectly claiming that Lynn has no filesystem access, and local models leaking pseudo `<tool_call>` text into visible chat output. This overwritten build also includes the #74 BYOK input-side content-filter false-positive fix.

## Highlights

- **GUI / CLI local-file task fix**: default model turns now receive a real local workspace summary. Read-only requests such as "find the first local novel chapter", "read my desktop file", or "inspect this folder" no longer fail with a false no-filesystem-access refusal.
- **Deterministic read-only fallback**: simple local file searches can be answered from the local scan before a model guesses or refuses, so file secrets / chapter snippets return reliably.
- **Tool-boundary fix**: Brain-managed realtime tools and client-side local tools are filtered separately. Lynn no longer suppresses the entire GUI/CLI client-tool surface during Brain turns.
- **Local Qwen bridge narrowed**: utility and coding tasks no longer bypass the tool chain through the direct local-model bridge.
- **Pseudo tool-call cleanup**: fake `<tool_call>` / `<function=...>` style text is stripped from server streaming and frontend rendering.
- **BYOK content-filter false-positive fix**: ordinary support/bug-report wording is no longer blocked by short embedded dictionary fragments. BYOK/local model hits now default to warning-only instead of hard-blocking the user's own model call.
- **Readable content-filter errors**: `error.contentFiltered` no longer leaks as a raw internal key; hard blocks now show the local safety filter and matched category.
- **Clearer provider key state**: saved, decryptable API keys now show a "Saved. Leave blank to keep the current key" placeholder. Old undecryptable keys no longer appear configured; re-enter once to migrate them.
- **Agent task-matrix gate**: a new release gate covers GUI + CLI local novel/file reads, routing, tool boundaries, pseudo-tool leakage, and live smoke tests.
- **v0.84.2 fixes remain**: CLI realtime voice turn detection, BYOK key persistence, Brain registration hardening, local-model startup hardening, and DeepSeek empty-answer recovery remain in place.

## Install

```bash
# Prerequisite:Node.js 20 LTS or 22 LTS with npm.
node -v

# Install or update from the Lynn mirror.
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.84.3.tgz"

# Launch.
Lynn            # interactive chat TUI; type /voice or lynn voice for realtime voice
Lynn code       # coding-agent TUI
Lynn --version  # should print 0.84.3
Lynn agents     # copyable headless/Fleet commands
```

Default Brain V2 route: **StepFun 3.7 Flash (256K context, high reasoning, 48K reasoning/generation budget)**. Voice defaults to **Brain-hosted StepFun Realtime**. Spark / SenseVoice / CosyVoice / system voice are fallback paths only. BYOK remains available.
