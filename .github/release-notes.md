# Lynn v0.86.6 Release Notes / 发布说明

> 2026-09-05 · 自动任务可靠性、长会话性能与 harness 完成事件修复

## 国内镜像站下载（推荐）

国内用户请优先使用镜像站；GitHub Assets 作为备用下载。

- **下载页**: https://download.merkyorlynn.com/download.html
- **macOS Apple Silicon / ARM64**: https://download.merkyorlynn.com/downloads/Lynn-0.86.6-macOS-arm64.dmg
- **macOS Intel / x64**: https://download.merkyorlynn.com/downloads/Lynn-0.86.6-macOS-x64.dmg
- **Windows x64**: https://download.merkyorlynn.com/downloads/Lynn-0.86.6-Windows-Setup.exe

```bash
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.86.6.tgz"
Lynn --version
```

## 中文重点

- 修复 Codex app-server 启动响应与回合完成/失败通知同批到达时漏终态、长期等待的问题；子进程提前退出也会立即结束等待。新增确定性竞态回归，保留原有超时门槛。
- 修复 GUI 长回答中的“小于号”被误判为未闭合标签、导致后半段答案消失的问题；完整真实失败答案按多种分块方式重放验证，内部推理与伪工具过滤保持不变。
- CLI 提前关闭输出管道的测试改用原生进程，不再依赖 Windows 上的 Bash 启动和路径转义；Windows 安装包校验包含 CLI 与 llama.cpp 真实加载/生成。
- 自动任务编辑保留月度、范围、步长、一次性和间隔计划；简化控件无法表达的计划明确显示原始规则，不再静默改成每天。
- 创建后测试失败会保留已保存的任务 ID 和持续可见的失败提示；再次保存并测试不会重复创建启用任务。已指定的模型可以恢复默认。
- IM 会话加载加入请求版本和当前会话校验；旧响应、旧错误以及切回本地会话都不会串消息。
- 历史首屏加载最近 80 条，向上分页；富文本按可见页面渲染并保留滚动锚点。长回复按文本规模调整刷新间隔，HTML 消毒保持不变。
- CodeMirror 核心由约 1.56 MB 缩减至约 325 KB，可选语言解析器按需加载；主入口与编辑器入口均有依赖/体积门禁。
- 已有任务和新建模板使用独立入口，中小窗口导航更紧凑，时间和状态元数据更易读。
- 设置 CSS 按功能域拆分，评审模块分为类型、纯策略、上下文和执行层；CLI 持久化从终端呈现中提取。GUI/CLI 共用请求超时和取消管理，原有 Agent 生命周期与 harness 回退契约保留。
- 截图门禁加载真实中文词条，并检查初始、模板、编辑、复杂计划、默认模型及保存后测试失败/重试状态；Windows 按平台和缩放比例维护独立基线。

## English highlights

- Retain early Codex app-server completion/failure events when they arrive with the turn-start response, and reject waiters promptly after process exit. Deterministic race regressions keep the existing timeout thresholds.
- Preserve the complete GUI answer after less-than comparisons instead of treating later planning prose as an unfinished tag. Replay the actual failed answer at multiple chunk sizes without weakening reasoning or pseudo-tool filtering.
- Test early CLI pipe closure with native processes instead of relying on Bash startup and Windows path quoting; validate the packaged CLI and real llama.cpp loading/generation on Windows.
- Preserve arbitrary automation schedules during non-schedule edits, and allow assigned models to return to the default.
- Separate save and test outcomes. A failed test retains the saved ID and a persistent explanation; retrying does not create duplicate enabled jobs.
- Prevent delayed IM history responses or errors from replacing another conversation.
- Load the latest 80 history messages first, page backwards, and window rich-message rendering with scroll-anchor preservation. Long streams use size-aware refresh intervals without weakening sanitization.
- Split optional CodeMirror languages from its core, reducing the core from approximately 1.56 MB to 325 KB; enforce main/editor entry budgets.
- Separate created tasks from templates and improve compact navigation and schedule/status readability.
- Separate settings styles by domain, review policy/context/execution, and CLI persistence/presentation. Share request cancellation and header-deadline handling without replacing the existing Agent lifecycle or harness fallback.
- Initialize real translations in screenshot gates and cover editing and partial-failure states, with native Windows baselines separated by display scale.

## Repositories

- https://github.com/MerkyorLynn/Lynn/releases/tag/v0.86.6
- https://github.com/LynnMerkyor/Lynn/releases/tag/v0.86.6
- https://gitee.com/merkyor/Lynn/releases
