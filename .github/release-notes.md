# Lynn v0.86.0 Release Notes / 发布说明

> 发布日期: 2026-07-12 · 安全边界 / Agent 运行时可靠性 / Windows 本地模型修复

## 国内镜像站下载（推荐）

国内用户请优先使用镜像站；GitHub 与 Gitee Releases 保留相同版本记录。

- **GitHub Releases**: https://github.com/MerkyorLynn/Lynn/releases/tag/v0.86.0
- **GitHub Releases（镜像仓）**: https://github.com/LynnMerkyor/Lynn/releases/tag/v0.86.0
- **Gitee Releases**: https://gitee.com/merkyor/Lynn/releases/tag/v0.86.0
- **下载页**: https://download.merkyorlynn.com/download.html

```bash
# Node.js 20 LTS or 22 LTS with npm.
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.86.0.tgz"
Lynn
```

- **macOS Apple Silicon / ARM64**: https://download.merkyorlynn.com/downloads/Lynn-0.86.0-macOS-arm64.dmg
- **macOS Intel / x64**: https://download.merkyorlynn.com/downloads/Lynn-0.86.0-macOS-x64.dmg
- **Windows x64**: https://download.merkyorlynn.com/downloads/Lynn-0.86.0-Windows-Setup.exe

## 中文重点

- **模型浏览器默认拒绝敏感权限**:网页不能静默取得麦克风、摄像头、定位、通知或浏览器敏感数据；导航与子资源请求统一通过 DNS/SSRF 校验。
- **本地信任边界收紧**:Electron IPC 只信任已知窗口对象，本地 HTTP/WS 同时校验 Host、Origin 与启动 token，敏感配置和日志统一使用仅当前用户可读权限。
- **执行沙箱真正生效**:授权执行仍受 OS 沙箱约束，SSH、云凭证、浏览器资料、Lynn token 与 Agent 配置均是禁止读取路径。
- **回合状态可靠收口**:同一会话 prompt 串行进入运行时，`turn_end` 兜底矩阵有独立契约测试，废弃的 internal retry 状态已移除，断线恢复容量可配置。
- **Brain 双层输出净化**:腾讯 Brain 已部署跨 chunk sanitizer，客户端继续保留末端清理；伪工具、内部推理和模型结构标签不会泄漏，普通代码与 JSX 不会被误删。
- **Windows 27B 启动修复**:支持从 PATH 发现 `llama-server`；手动 GGUF 启动会明确报告 runtime 缺失、端口冲突、超时、崩溃或 ready 状态。
- **CLI 更适合脚本和长任务**:流式回答支持 Ctrl+C 取消，未知参数立即失败，命令级帮助、非 TTY 退出码、manager/worker JSONL 行为和 Windows argv 执行保持一致。
- **GUI 状态更直观**:Fleet worker 进入活动面板，语音显示 RTT/上下行统计，renderer 恢复有明确提示，Bridge、Provider 与快捷键补齐中英文和键盘焦点。
- **发版门禁扩大**:根仓、Brain、Agent regression、CLI100、GUI100、真实安装、PTY、语音、架构循环与生产 Brain 漂移均为硬门槛。

## English highlights

- Model-driven browser sessions deny sensitive permissions and browser data by default; navigation and subresources pass DNS/SSRF checks.
- Electron IPC trusts known window identities, while local HTTP/WS validates Host, Origin, and the per-launch token.
- Authorized execution remains inside the OS sandbox with credential and profile deny-read paths.
- Per-session prompt admission, explicit turn-end fallback contracts, and removal of legacy retry state prevent cross-turn contamination.
- Brain and client sanitizers stop split pseudo-tool markup without damaging ordinary code or JSX.
- Windows discovers `llama-server` through PATH and reports actionable GGUF startup failures.
- CLI cancellation, strict flags, command help, non-TTY exits, JSONL output, and Windows-safe worker invocation are now consistent.
- Fleet, voice telemetry, renderer recovery, localization, and dialog keyboard behavior are visible in the desktop app.
