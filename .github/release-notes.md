# Lynn v0.85.9 Release Notes / 发布说明

> 发布日期: 2026-07-11 · 会话进度 / Agent 回合隔离 / Brain 兜底与工具边界

## 国内镜像站下载（推荐）

国内用户请优先使用镜像站地址；正式版本记录见 GitHub / Gitee Releases，下载以镜像站为准。

- **GitHub Releases (old)**: https://github.com/LynnMerkyor/Lynn/releases/tag/v0.85.9
- **GitHub Releases (new)**: https://github.com/MerkyorLynn/Lynn/releases/tag/v0.85.9
- **Gitee Releases**: https://gitee.com/merkyor/Lynn/releases/tag/v0.85.9

- **CLI**:

  ```bash
  npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.85.9.tgz"
  ```

- **macOS Apple Silicon / ARM64**: https://download.merkyorlynn.com/downloads/Lynn-0.85.9-macOS-arm64.dmg
- **macOS Intel / x64**: https://download.merkyorlynn.com/downloads/Lynn-0.85.9-macOS-x64.dmg
- **Windows x64**: https://download.merkyorlynn.com/downloads/Lynn-0.85.9-Windows-Setup.exe
- **下载页**: https://download.merkyorlynn.com/download.html

## 中文重点

- **会话进度更直观**: 右栏只突出一次当前会话，最近会话默认收起详情；打开会话、新建分支和展开状态更明确并支持键盘操作。
- **回合状态彻底隔离**: 每轮开始统一清理工具、重试、解析器、定时器、sanitizer 和临时输出，避免“重新回答”后的上一题状态污染下一题。
- **普通回答不再误生成文件**: 只有用户明确要求报告、HTML、PDF、PPT、附件或导出物时才开放交付物工具；清单、设定表、代码和解释留在聊天正文。
- **Brain 兜底真正可执行**: Step、DS V4 Flash、MiMo Token Plan、端侧和 GLM 候选各有独立尝试时限；reasoning-only、空答和半句截断会交给下一候选。
- **外部证据工具按需注入**: 查证、来源、天气、行情、比分、新闻等请求继续使用实时工具；普通写作、规划和解释不再无意义启动搜索。
- **前端边界更清楚**: 拆出 WebSocket transport、布局控制器和 Engine/Agent 帮助模块，新增运行时循环依赖门禁和真实 Session Progress 组件回归。
- **本地 27B Agent 保持完整**: 默认仍下载 Q4 imatrix MTP 四分片并用 `draft-mtp` 启动；代码和工具任务继续进入完整 Agent loop。

## 已验证

- 根仓与 Brain 全量单测、TypeScript 双门禁、前端运行时循环依赖门禁通过。
- Agent regression、CLI100、GUI100 与 release preflight 纳入本次发布验证。
- macOS Apple Silicon / Intel DMG 完成 Developer ID 签名、Apple notarization、staple 和 Gatekeeper 验证后发布。
- Windows x64 NSIS 安装包完成构建验证；CLI tarball 同步镜像站并执行远程安装 smoke。

---

> Release date: 2026-07-11 · Session Progress / isolated Agent turns / bounded Brain fallbacks and tool exposure

## English highlights

- **Clearer Session Progress**: the current session appears once, older details start collapsed, and Open Session / New Branch actions are keyboard-accessible.
- **Isolated turn state**: tool, retry, parser, timer, sanitizer, and temporary-output state are reset centrally before each turn.
- **Deliverables only on explicit intent**: lists, world-building tables, code, and explanations stay in chat unless the user asks for a file, report, HTML, PDF, PPT, attachment, or export.
- **Bounded Brain fallbacks**: Step, DS V4 Flash, MiMo Token Plan, local, and GLM candidates each get a real attempt budget; empty or incomplete outputs hand off.
- **Intent-scoped evidence tools**: live lookup remains available for citations, weather, markets, scores, and news without slowing timeless planning or writing.
- **Stronger architecture gates**: transport/layout/runtime boundaries are separated and protected by import-cycle and real component regressions.
- **The local 27B Agent path remains intact**: Q4 imatrix MTP stays the default and coding/tool turns continue through the full Agent loop.
