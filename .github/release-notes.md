# Lynn v0.85.3 Release Notes / 发布说明

> 发布日期: 2026-06-25 · issue 修复热修 / sports 实时证据修复 / 本地数据分析修复 / 更新源切换 / Session Runtime 拆分

## 国内镜像站下载（推荐）

国内用户请优先使用以下镜像站地址；Gitee Release 页面作为版本记录，下载请以镜像站为准。

- **CLI**:

  ```bash
  npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.85.3.tgz"
  ```

- **macOS Apple Silicon / ARM64**: https://download.merkyorlynn.com/downloads/Lynn-0.85.3-macOS-arm64.dmg
- **macOS Intel / x64**: https://download.merkyorlynn.com/downloads/Lynn-0.85.3-macOS-x64.dmg
- **Windows x64**: https://download.merkyorlynn.com/downloads/Lynn-0.85.3-Windows-Setup.exe
- **下载页**: https://download.merkyorlynn.com/download.html

## 中文重点

- **06-25 正式包**: 生成 v0.85.3 的 macOS ARM64、macOS x64、Windows x64 三个 GUI 安装包和 CLI tarball；macOS DMG 均走 Apple notarization、staple 和 Gatekeeper 验证。
- **修复 GUI sports 实时证据被泛搜覆盖**: 当 `sports_score` 命中 ESPN 直接赛程/比分证据时，GUI 会直接基于该证据闭环，不再继续让泛搜索或模型脑补覆盖结果。`今晚世界杯有比赛吗/有几场比赛` 这类问题会稳定返回当晚赛程，而不是旧比分、自动任务列表或无关搜索摘要。
- **强化未知问题 ReAct 循环**: 默认路径按“是否需要工具 → 执行/观测 → 证据可用性判断 → 最终总结”收口；如果工具证据为空或不相关，会继续补证据或明确说明缺口，不再把无关工具结果包装成答案。
- **修复世界杯日期窗口解析**: `6月25日`、`2026-06-25`、`20260625` 等日期会被 sports scoreboard 正确识别；“今晚”窗口限制到次日上午，避免把整届赛事历史窗口混进当前问题。
- **修复 GUI 小型数据分析误触工具链**: `华东 Q1 120 Q2 150...算环比增长率` 这类纯本地算术/经营建议问题会直接给出可见答案，不再错误进入 `step_execute` 或其它工具导致 40 秒后只显示工具失败。
- **更新源从 GitHub 切出**: 客户端原生更新 feed 改为 `https://download.merkyorlynn.com/downloads/`，应用内“关于”页和项目主页链接改为 Gitee；GitHub 账号未恢复期间，Gitee 作为源码/Release 记录，镜像站作为下载源。
- **拆分 Session Runtime 巨石文件**: `create-session.ts` 拆出 OpenAI/工具续轮适配与证据兜底 helper，对外 `createLynnAgentSession` API 不变，后续修复空答、工具链、fallback 不再挤在一个 1700+ 行文件里。
- **修复 Windows D 盘工作区选择**: 选择 `D:\...` 等非用户主目录工作区后，会立即写入 `last_cwd`、`cwd_history` 和 `desk.trusted_roots`；书桌文件列表和后续会话会使用新的受信任工作区，不再回退到旧目录。
- **修复工作区路径显示**: Windows 盘符路径、正斜杠路径和 UNC 路径在侧边栏、欢迎页、书桌和应用标签中会正确显示为目录名，避免 `D:`/数字/空标题混乱。
- **修复 IJV6WH 证据兜底误判**: 本地文件 read 只返回路径、LaTeX 模板包名、`\includegraphics` 等结构片段时，不再被当作“我能确认”的事实结论；系统会明确提示证据不足，而不是把文档结构噪声当成论文分析。
- **继续加固旧任务污染回归**: 编辑重发、助手重做和流式中继续发送的回归测试会确认旧分支被正确截断，发送失败不乐观上屏，避免“问新问题却继续回答上一个任务”。
- **保留 v0.85 工作地图主线**: Session Map 工作地图、超大 session health 标记、从当前会话分支、GUI/CLI 同核和 Brain V2 证据优先链路继续保留。

## 已验证

- IJV6WH 图片复现样例：LaTeX 结构片段不再被当作可靠事实证据。
- GUI/CLI sports 回归：`今晚世界杯有几场比赛`、`今晚世界杯有比赛吗`、预测比分等 sports 场景走 `sports_score` 直证据，不再落到自动任务/旧比分/泛搜摘要。
- GUI 数据分析回归：DATA-01 环比增长率题直接输出 `25%`、`-10%`、`30%` 和 3 条管理建议，不再调用模型工具。
- targeted regression：`shared/__tests__/evidence-safety-answer.test.ts`、`tests/agent-runtime-create-session.test.js`、`desktop/src/react/__tests__/stores/prompt-actions.test.ts`、`desktop/src/react/components/input/edit-resend-target.test.ts`、`tests/stream-sanitizer.test.js`、`desktop/src/react/__tests__/utils/message-parser.test.ts`。
- 正式 `release:preflight`、macOS notarization/staple/Gatekeeper、安装包 smoke 和公网 URL 验证结果随发布执行记录更新。

---

> Release date: 2026-06-25 · issue hotfix / sports grounding fix / local data-analysis fix / update-feed migration / Session Runtime split

## English highlights

- **06-25 final packages**: builds the v0.85.3 macOS ARM64, macOS x64, Windows x64 GUI installers and CLI tarball; both macOS DMGs go through Apple notarization, stapling, and Gatekeeper validation.
- **Fixes GUI sports grounding being overwritten by generic search**: when `sports_score` returns direct ESPN schedule/score evidence, the GUI now closes on that evidence instead of letting generic web search or model guesses overwrite the answer.
- **Strengthens the ReAct loop for first-seen questions**: the default path follows need-tool → execute/observe → usable-evidence check → final synthesis; empty or irrelevant evidence now triggers repair or an explicit gap instead of wrapping unrelated tool output as an answer.
- **Fixes World Cup date-window parsing**: dates such as `6月25日`, `2026-06-25`, and `20260625` are parsed by the sports scoreboard, and “tonight” is scoped to the evening through the next morning instead of broad tournament history.
- **Fixes GUI tool misrouting for small local data analysis**: prompts such as Q1/Q2 regional growth calculations now answer directly with the arithmetic and management suggestions instead of falling into `step_execute` and surfacing a tool failure.
- **Moves update sources off GitHub**: native app update feed now uses `https://download.merkyorlynn.com/downloads/`; the About tab and project homepage link point to Gitee while GitHub access is unavailable.
- **Splits the Session Runtime giant file**: `create-session.ts` now delegates OpenAI/tool-continuation adapter code and evidence fallback helpers to focused modules while keeping `createLynnAgentSession` stable.
- **Fixes Windows D-drive workspace selection**: choosing a workspace outside the user home now persists it immediately to `last_cwd`, `cwd_history`, and `desk.trusted_roots`, so the Desk file list and new sessions use the selected folder.
- **Fixes workspace path labels**: Windows drive paths, slash-normalized paths, and UNC paths now render as stable folder names across the sidebar, welcome screen, Desk, and app labels.
- **Fixes IJV6WH evidence fallback regression**: file-read paths, LaTeX package/template fragments, and `\includegraphics` snippets are no longer treated as completed factual analysis.
- **Keeps edit-resend / retry pollution guards covered**: targeted tests verify branch truncation, no optimistic stale messages after send failure, pseudo-tool stripping, and visible-answer closure.
