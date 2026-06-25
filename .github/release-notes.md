# Lynn v0.85.4 Release Notes / 发布说明

> 发布日期: 2026-06-25 · 重新回答污染修复 / GUI 回归门禁 / v0.85.3 质量修复延续

## 国内镜像站下载（推荐）

国内用户请优先使用以下镜像站地址；Gitee Release 页面作为版本记录，下载请以镜像站为准。

- **CLI**:

  ```bash
  npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.85.4.tgz"
  ```

- **macOS Apple Silicon / ARM64**: https://download.merkyorlynn.com/downloads/Lynn-0.85.4-macOS-arm64.dmg
- **macOS Intel / x64**: https://download.merkyorlynn.com/downloads/Lynn-0.85.4-macOS-x64.dmg
- **Windows x64**: https://download.merkyorlynn.com/downloads/Lynn-0.85.4-Windows-Setup.exe
- **下载页**: https://download.merkyorlynn.com/download.html

## 中文重点

- **修复“重新回答”后污染下一问**: 点击助手消息的重新回答后,Lynn 会定位上一条用户消息,从那里回滚旧分支,再走正常发送链路重新请求。之后继续提新问题时,不会复用上一轮 prompt、旧 `replaceFromMessageId` 或旧回滚目标。
- **发送失败不再污染当前会话**: 重新回答或编辑重发如果发送失败,只恢复输入草稿,不会把失败轮次乐观上屏,也不会把半截旧状态留给下一次发送。
- **补齐精确回归测试**: 新增 GUI store 测试覆盖“点重新回答后再问新问题”,断言第二次 WebSocket payload 是新问题,且没有携带旧分支替换参数。
- **保留 v0.85.3 主线质量修复**: sports 直证据闭环、本地数据分析直答、证据兜底安全、Windows D 盘工作区、工作区路径显示、Session Runtime 拆分和镜像更新源继续保留。
- **发布产物版本统一到 v0.85.4**: GUI 安装包、CLI tarball、README、CLI 安装片段、更新 manifest 和下载链接统一使用 `0.85.4`。

## 已验证

- 重新回答污染回归: `desktop/src/react/__tests__/stores/prompt-actions.test.ts`。
- 输入/编辑/重发相关回归: `desktop/src/react/__tests__/utils/composer-state.test.ts`、`desktop/src/react/components/input/edit-resend-target.test.ts`、`desktop/src/react/components/input/composer-text.test.ts`。
- 正式发版门禁:全量 Vitest、Brain v2、typecheck、CLI pack/install/stress/PTY/Fleet、voice、release static/UI、startup、CLI live task、GUI live task、agent matrix 均通过。
- 正式产物验证:macOS ARM64/x64 DMG 已完成 Apple notarization、staple、Gatekeeper 验证和 `latest-mac.yml` 双架构校验；Windows x64 安装包已完成签名与 `latest.yml` 生成；packaged server / packaged CLI smoke 已通过。

---

> Release date: 2026-06-25 · retry-answer pollution fix / GUI regression gate / v0.85.3 quality fixes retained

## English highlights

- **Fixes retry-answer pollution after "regenerate"**: when retrying an assistant answer, Lynn now rolls back from the matching previous user message and resends through the normal prompt path. Later fresh questions no longer reuse the previous prompt, old `replaceFromMessageId`, or stale branch target.
- **Failed sends stay out of the active transcript**: retry and edit-resend failures restore the draft only; they no longer optimistically add a failed turn that can poison the next request.
- **Adds an exact regression test**: the GUI store test covers retry followed by a new question and asserts the second WebSocket payload is the fresh prompt with no stale replacement parameters.
- **Keeps v0.85.3 quality fixes**: sports direct evidence closure, local data-analysis direct answers, safer evidence fallback, Windows workspace fixes, Session Runtime split, and mirror update feed remain included.
- **Unifies release artifacts on v0.85.4**: GUI installers, CLI tarball, README, CLI install snippet, update manifest, and download links all use `0.85.4`.
- **Verified for release**: full Vitest, Brain v2, typechecks, CLI pack/install/stress/PTY/Fleet, voice, release static/UI, startup, CLI live task, GUI live task, agent matrix, macOS notarization/staple/Gatekeeper, and packaged server/CLI smokes passed.
