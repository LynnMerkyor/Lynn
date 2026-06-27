# Lynn v0.85.5 Release Notes / 发布说明

> 发布日期: 2026-06-27 · 会话进展右栏 / 本地模型推荐链路 / 发版回归门禁

## 国内镜像站下载（推荐）

国内用户请优先使用以下镜像站地址；正式版本记录见 GitHub Releases，下载请以镜像站为准。

- **GitHub Releases**: https://github.com/LynnMerkyor/Lynn/releases/tag/v0.85.5

- **CLI**:

  ```bash
  npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.85.5.tgz"
  ```

- **macOS Apple Silicon / ARM64**: https://download.merkyorlynn.com/downloads/Lynn-0.85.5-macOS-arm64.dmg
- **macOS Intel / x64**: https://download.merkyorlynn.com/downloads/Lynn-0.85.5-macOS-x64.dmg
- **Windows x64**: https://download.merkyorlynn.com/downloads/Lynn-0.85.5-Windows-Setup.exe
- **下载页**: https://download.merkyorlynn.com/download.html

## 中文重点

- **右侧栏从“工作地图”收敛为“会话进展”**: 右侧不再像内部调试面板，而是优先展示当前会话、需要处理的信号、最近会话和轻量预览；历史会话卡片有明确“打开”按钮，当前会话也能直接“继续输入”。
- **减少内部术语和空白面板**: “地图/资料/巡检/推进中/已收口”等文案改为“进展/文件/同步/进行中/已完成/需要处理”；没有相关会话时不再显示大块空白，底部更早会话提示用户去左侧搜索。
- **端侧模型推荐链路确认**: 默认推荐本地 **Qwen3.6-27B DSV4Pro Distill Q5_K_M imatrix MTP**；32GB+ 机器可选 **Qwen3.6-35B-A3B DSV4Pro Distill Q5_K_M imatrix MTP**；9B / 4B 只作为低配置显式降级。低配机器不会主动弹 27B 安装引导。
- **本地模型启动入口更直接**: 聊天输入区的本地模型提示可以直接准备并启动 27B，不再把用户先丢到设置页；已运行模型仍保留停止和状态查看能力。
- **隐藏推理短答兜底**: 如果模型把大量内容放进 reasoning，最终可见答案只剩半句，Lynn 会补一个明确的可见收口并进入自动复查，避免用户只看到残缺回答。
- **保留 v0.85.4 重新回答污染修复**: 点击“重新回答”后再问新问题，不再复用旧 prompt、旧 `replaceFromMessageId` 或旧回滚目标。
- **发布产物版本统一到 v0.85.5**: GUI 安装包、CLI tarball、README、CLI 安装片段、更新 manifest 和下载链接统一使用 `0.85.5`。

## 已验证

- 右侧会话进展文案和交互回归: `desktop/src/react/components/desk/session-map-view.test.ts`。
- 本地模型推荐 / 启动链路回归: `desktop/src/react/settings/tabs/providers/local-qwen-provider.test.ts`、`desktop/src/react/components/input/local-qwen-status.test.ts`。
- 正式发版门禁: 全量 Vitest、Brain v2、agent-regression、typecheck、CLI pack/install/stress/PTY/Fleet、voice、release static/UI、startup、CLI live task、GUI live task、agent matrix 均需通过。
- 正式产物验证: macOS ARM64/x64 DMG 将完成 Apple notarization、staple、Gatekeeper 验证和 `latest-mac.yml` 双架构校验；Windows x64 安装包将完成签名与 `latest.yml` 生成；packaged server / packaged CLI smoke 必须通过。

---

> Release date: 2026-06-27 · session progress rail / local model recommendation chain / release regression gates

## English highlights

- **Turns the right rail into Session Progress**: the rail now prioritizes the current session, items needing attention, recent sessions, and a lightweight preview. Historical session cards have an explicit Open button, and the current session can focus input directly.
- **Removes internal jargon and empty panels**: "map/materials/patrol/in progress/closed" copy is simplified to "progress/files/sync/active/done/needs attention". Empty related-session space now falls back to recent sessions, while older history points users to left-side search.
- **Confirms the local-model recommendation ladder**: Lynn recommends **Qwen3.6-27B DSV4Pro Distill Q5_K_M imatrix MTP** by default, exposes **Qwen3.6-35B-A3B DSV4Pro Distill Q5_K_M imatrix MTP** for 32GB+ machines, and keeps 9B / 4B as explicit low-config downgrade lanes. Low-config hardware does not get a proactive 27B install prompt.
- **Makes local-model startup more direct**: the chat input local-model prompt can prepare and start the 27B path directly instead of sending users through Settings first.
- **Guards against hidden-reasoning short answers**: when a model spends most of the turn in hidden reasoning but leaves only a tiny visible fragment, Lynn adds a clear visible fallback and schedules auto-review.
- **Keeps the v0.85.4 retry-answer pollution fix**: retrying an assistant answer no longer pollutes later fresh prompts with stale replacement targets.
- **Unifies release artifacts on v0.85.5**: GUI installers, CLI tarball, README, CLI install snippet, update manifest, and download links all use `0.85.5`.
- **Release verification**: full Vitest, Brain v2, agent-regression, typechecks, CLI pack/install/stress/PTY/Fleet, voice, release static/UI, startup, CLI live task, GUI live task, agent matrix, macOS notarization/staple/Gatekeeper, Windows signing, and packaged server/CLI smokes are the blocking gates for this release.
