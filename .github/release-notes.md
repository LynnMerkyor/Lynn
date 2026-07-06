# Lynn v0.85.6 Release Notes / 发布说明

> 发布日期: 2026-06-28 · 本地文件读取修复 / 串题污染回归 / Agent regression 32/32 + CLI200 + GUI100 门禁覆盖

> 2026-07-07 Windows 热修:重新覆盖 Windows 安装包与 CLI 包，修复后台工具/MCP/本地模型/语音/worker 子进程缺少 `windowsHide` 导致 CMD 窗口反复闪现的问题。

## 国内镜像站下载（推荐）

国内用户请优先使用以下镜像站地址；正式版本记录见 GitHub Releases，下载请以镜像站为准。

- **GitHub Releases**: https://github.com/LynnMerkyor/Lynn/releases/tag/v0.85.6

- **CLI**:

  ```bash
  npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.85.6.tgz"
  ```

- **macOS Apple Silicon / ARM64**: https://download.merkyorlynn.com/downloads/Lynn-0.85.6-macOS-arm64.dmg
- **macOS Intel / x64**: https://download.merkyorlynn.com/downloads/Lynn-0.85.6-macOS-x64.dmg
- **Windows x64**: https://download.merkyorlynn.com/downloads/Lynn-0.85.6-Windows-Setup.exe
- **下载页**: https://download.merkyorlynn.com/download.html

## 中文重点

- **修复 IJV6WH 本地绝对路径读取**: 用户明确要求“阅读 `/Users/.../main.tex`”时，Lynn 会按那个文件读取，不再退回当前 workspace 目录，也不再把空目录当成答案。
- **修复 `file://` 说明类问题误触发读目录**: 询问“为什么 `file://` 协议被阻止”这类元问题时，不会把 `file://` 当成本地文件路径预取，避免答非所问。
- **修复上一题路径/ComfyUI 任务污染**: 上一轮 ComfyUI、`main.tex` 或其它文件任务不会继续污染下一轮普通追问；回归测试覆盖“先问 ComfyUI、再读 main.tex”的串题场景。
- **大文件读取更稳**: 用户点名的大文件只做可控 preview，避免一次性把巨大 LaTeX/代码文件塞进模型上下文导致卡顿、截断或空答。
- **Windows 路径更兼容**: `D:\...`、`D:/...` 和 `%20` 编码路径都按本地文件处理，不会误判成 URL 或协议说明。
- **Windows 不再反复弹 CMD 窗口**: GUI、CLI、Agent 工具、MCP、本地模型安装、语音和 worker 后台进程统一显式隐藏 Windows console 子进程；release static gate 会扫描生产代码和主进程 bundle，漏掉 `windowsHide` 直接阻断发布。
- **设置页入口更稳**: 从聊天窗/本地模型提示跳到“模型服务”设置时，不再偶发落回“关于”页；安装态门禁已覆盖设置页供应商列表和模型删除回归。
- **保留 v0.85.5 体验改动**: 右侧“会话进度”、27B 端侧默认推荐、低配不主动弹本地模型引导、隐藏推理短答兜底继续保留。
- **发版门禁继续加严**: 本次客户端包纳入 Agent regression、CLI200、GUI100、typecheck 和 release preflight；日常生活、政务/法律、医疗、教育、旅行、招聘、办公、行业运营、代码和小说写作场景都已进同一套回归门禁，CLI/GUI 同核回归不再只靠人工体验。

## 已验证

- release full-gate 组件通过：`release:preflight` + agent regression gates + CLI200 + GUI100。
- `npm run release:preflight` 通过。
- `npm test -- tests/local-workspace-context.test.js` 通过。
- `npm run test:agent-regression` 32/32 通过，包含本次本地文件读取、串题污染、reasoning-only 空答和 BYOK 假 provider case。
- `npm run test:agent-regression:gates` 3/3 通过。
- CLI200: 200/200 通过。
- CLI 扩展综合场景：146/146 通过。
- GUI 扩展综合场景：146/146 通过；发版 GUI100 采样门禁 100/100 通过。
- `npm run release:installed-gate` 通过，包含安装态 GUI/server/CLI/settings/main-ui/review concurrency。
- macOS arm64/x64 DMG 已签名、公证、staple，并通过 Gatekeeper 校验。
- Windows x64 安装包已重新打包并签名。
- Windows child_process 静态门禁通过：生产路径和主进程 bundle 的后台子进程均显式设置 `windowsHide`。

---

> Release date: 2026-06-28 · local file-read fix / stale-task regression / Agent regression 32/32 + CLI200 + GUI100 gate coverage

> 2026-07-07 Windows hotfix: republished the Windows installer and CLI package to stop repeated CMD window flashes from background tool/MCP/local-model/voice/worker child processes missing `windowsHide`.

## English highlights

- **Fixes IJV6WH explicit absolute file reads**: when the user asks Lynn to read `/Users/.../main.tex`, Lynn reads that file instead of falling back to the current workspace or reporting an empty directory.
- **Stops `file://` meta-questions from triggering fake directory reads**: questions like "why was the `file://` protocol blocked?" are treated as explanation requests, not local prefetch requests.
- **Prevents previous file-task pollution**: a prior ComfyUI, `main.tex`, or other file task no longer leaks into the next ordinary question; regression coverage includes the ComfyUI → main.tex stale-answer path.
- **Handles large explicit files more safely**: pointed local files use a capped preview so a huge LaTeX/code file does not freeze or flood the model context.
- **Improves Windows path compatibility**: `D:\...`, `D:/...`, and `%20` encoded paths are treated as local file paths instead of URL/protocol text.
- **Stops repeated Windows CMD flashes**: GUI, CLI, Agent tools, MCP, local-model setup, voice, and worker subprocesses now explicitly hide Windows console windows; release static regression scans production code and the main-process bundle for missing `windowsHide`.
- **Stabilizes settings deep links**: opening Model Services from chat or local-model prompts no longer occasionally lands on About; the installed-app gate now covers provider-list and model-removal regressions.
- **Keeps v0.85.5 UX changes**: Session Progress, 27B local recommendation, no proactive low-config local-model prompt, and hidden-reasoning fallback remain in place.
- **Keeps release gates strict**: Agent regression, CLI200, GUI100, typecheck, and release preflight cover this client build. The shared gate now includes daily life, public-service/legal, medical, education, travel, recruiting, office, industry-ops, coding, and fiction-writing prompts, so GUI/CLI parity is not left to manual spot checks alone.
