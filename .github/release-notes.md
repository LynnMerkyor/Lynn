# Lynn v0.85.1 Release Notes / 发布说明

> 发布日期: 2026-06-23 · 新内核稳定版 · Session Map 工作地图 · GUI/CLI 同核门禁

## 国内镜像站下载（推荐）

国内用户请优先使用以下镜像站地址；Gitee Release 页面作为版本记录，下载请以镜像站为准。

- **CLI**:

  ```bash
  npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.85.1.tgz"
  ```

- **macOS Apple Silicon / ARM64**: https://download.merkyorlynn.com/downloads/Lynn-0.85.1-macOS-arm64.dmg
- **macOS Intel / x64**: https://download.merkyorlynn.com/downloads/Lynn-0.85.1-macOS-x64.dmg
- **Windows x64**: https://download.merkyorlynn.com/downloads/Lynn-0.85.1-Windows-Setup.exe
- **下载页**: https://download.merkyorlynn.com/download.html

## 中文重点

- **稳定 v0.85 自研核心**: 保留 v0.85 完全替换 Pi SDK 主链、NO Fork、自主 runtime 的方向，并把这轮审计中发现的空答、证据完整性、CLI/GUI 差异和 Brain provider 抖动问题纳入门禁验收。
- **Session Map 工作地图**: 右侧便签区升级为围绕当前会话的工作地图/工作台，显示当前线索、巡检状态、证据/资料和从当前会话继续分支的入口，不再让左侧一串重复“新对话”和数字承担全部导航。
- **超大 session health 标记**: 会话巡检会识别 large / huge / blocked 等状态，让 7GB 级历史会话以健康标记和地图节点呈现，避免一打开巨型会话就拖死 GUI。
- **从当前会话开分支**: GUI 增加“从此分支”入口，让长对话可以保留血缘、摘要和下一步，同时用新会话继续工作，减少把完整长上下文反复拖入模型。
- **GUI / CLI 继续同核**: 本地 GUI 包和 CLI 包都走同一套 Brain V2、证据优先、工具事件和最终可见收口门禁；CLI 不再作为另一个临时补丁面存在。
- **Brain 运维修复**: 修复一条损坏 device JSON 导致的 `internal auth error`，把 v2 healthcheck / cron-smoke 切到 HMAC 签名请求，并停止旧 v1 smoke 对 MiMo 过期 key 的周期性噪声调用。
- **镜像站与发布纪律**: 更新清单和下载页继续指向腾讯镜像，Gitee Release 作为版本记录；GitHub 暂未恢复期间不依赖 GitHub Assets 作为国内主下载入口。

## 已验证

- `npm run typecheck`
- `npm run typecheck:runtime`
- 核心单测矩阵：7 files / 157 tests passed
- `npm run test:release:static`：70/70 passed
- CLI 100 扩展对话门禁：100 ok / 0 fail
- GUI 100 扩展对话门禁：100 ok / 0 fail
- macOS arm64 / macOS x64 / Windows x64 安装包重新打包；macOS 本轮按快速发布流程跳过 Apple notarization。
- packaged server / packaged CLI smoke 通过；真实 `/Applications/Lynn.app` 安装版 packaged server / CLI smoke 通过。

---

> Release date: 2026-06-23 · stabilized self-built core · Session Map workbench · GUI/CLI gates

## English highlights

- **Stabilizes the v0.85 self-built core**: Lynn keeps the no-fork, no-Pi-SDK main path and folds the latest empty-answer, evidence-integrity, GUI/CLI parity, and provider-reliability findings into release verification.
- **Session Map workbench**: the right sidebar is now centered on the current thread's work map, inspection status, evidence, and branch-from-here controls instead of a loose note pile.
- **Huge-session health markers**: session inspection marks large, huge, blocked, and archived states so multi-GB histories become visible health nodes instead of GUI-freezing sidebar entries.
- **Branch from the current session**: long work can continue from a summarized branch with lineage preserved, without dragging the entire old context into every new turn.
- **GUI and CLI stay on the same core path**: both packages verify against Brain V2, evidence-first routing, tool events, and visible final-answer closure.
- **Brain ops fixes**: repaired one corrupt device JSON behind `internal auth error`, moved v2 healthcheck / cron-smoke to signed HMAC requests, and stopped old v1 smoke noise from probing an expired MiMo key.
