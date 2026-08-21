# Lynn v0.86.2 Release Notes / 发布说明

> 发布日期: 2026-08-22 · Codex app-server harness、GUI/CLI Loop 稳定性与 Windows 本地模型运行时更新

## 国内镜像站下载（推荐）

国内用户请优先使用镜像站地址；GitHub Assets 仅作为备用下载。两个 GitHub 仓库与 Gitee Release 保留相同版本记录。

- **GitHub Releases**: https://github.com/MerkyorLynn/Lynn/releases/tag/v0.86.2
- **GitHub Releases（镜像仓）**: https://github.com/LynnMerkyor/Lynn/releases/tag/v0.86.2
- **Gitee Releases**: https://gitee.com/merkyor/Lynn/releases
- **下载页**: https://download.merkyorlynn.com/download.html

```bash
# Node.js 20 LTS or 22 LTS with npm.
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.86.2.tgz"
Lynn
```

- **macOS Apple Silicon / ARM64**: https://download.merkyorlynn.com/downloads/Lynn-0.86.2-macOS-arm64.dmg
- **macOS Intel / x64**: https://download.merkyorlynn.com/downloads/Lynn-0.86.2-macOS-x64.dmg
- **Windows x64**: https://download.merkyorlynn.com/downloads/Lynn-0.86.2-Windows-Setup.exe

## 中文重点

- **Codex app-server harness 默认自动选择**:GUI 与 CLI 的编码任务默认使用 `auto`。每次启动前先探测 app-server 可执行文件、协议版本、认证、provider/model 和 Brain 能力；全部兼容才进入 Codex harness，否则在任务开始前直接使用 Lynn 原架构。
- **新旧架构互不污染**:`legacy` 与 `codex` 仍可显式选择。多模态附件、JSON 逐工具审计、Ultra、多数严格审批场景以及不兼容的 BYOK/Brain 路由继续使用已验证的原 Loop；任务运行中不会临时切换 harness。
- **GUI/CLI Loop 生命周期更稳**:统一记录请求与实际选择的 harness、协议和原因，补强完成、取消、失败、续跑与可见回答的终态处理，避免工具或上游异常留下半轮状态。
- **Windows 本地 GGUF 开箱即用**:Windows 安装包内置固定版本的 `llama-server.exe`、所需 DLL、许可证与逐文件 SHA-256 清单；导入本地 GGUF 不再要求用户手工安装 llama.cpp。
- **Windows 运行时做真实加载门禁**:从最终 NSIS 安装器反解实际 payload，在 Windows 上执行内置 `llama-server.exe`，加载固定 SHA-256 的 GGUF，等待健康检查并连续完成两次生成，验证服务在稳定窗口内保持存活。
- **Brain 能力门改为运行态硬检查**:发布门禁同时验证镜像代码声明与生产 `/v2/providers/status` 的 `responses` / `appServerHarness` 能力，避免本地代码与线上路由能力不一致。
- **发布门禁保持完整**:根仓、Brain、Agent regression、CLI100、GUI100、全部 UI、真实安装、Ink PTY、语音、Windows 模拟/真机、本地模型实机和生产 Brain 漂移均为发布硬门槛。

## English highlights

- Code tasks now default to an `auto` Codex app-server harness. Lynn probes the executable, protocol, authentication, provider/model, and Brain capability before the run; incompatible configurations select the legacy loop before any task or tool starts.
- Explicit `legacy` and `codex` modes remain available. Multimodal attachments, JSON per-tool auditing, Ultra, strict approval semantics, and unsupported BYOK/Brain routes stay on Lynn's verified legacy architecture.
- GUI and CLI now record the requested and selected harness, protocol, and selection reason, with stronger completed/cancelled/failed/resumable terminal-state handling.
- The Windows installer bundles a pinned llama.cpp CPU runtime, required DLLs, its license, and a per-file SHA-256 manifest, so local GGUF import no longer requires a manual llama.cpp installation.
- The Windows release gate extracts the final NSIS payload, starts the packaged `llama-server.exe`, loads a pinned GGUF, waits for health, runs two completions, and verifies that the server remains alive.
- Release verification now requires both source declarations and live production Brain `responses` / `appServerHarness` capabilities.
