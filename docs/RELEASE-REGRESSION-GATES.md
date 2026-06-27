# Lynn Release Regression Gates

目标：发版前同时验证 UI、桌面运行时、Brain/模型链路、工具调用、流式事件、发布资产，避免“发布后马上 hotpatch”。

## 入口

```bash
# 最小阻断门禁：适合 hotpatch 前
npm run test:release:smoke

# 正式发版门禁：static + live 全量回归；需要本机 Lynn 服务已经运行
npm run test:release

# 打包前静态门禁：不要求 live server，dist / dist:win 会自动跑
npm run test:release:static

# live 回归：打包后或启动 Lynn 服务后单独跑
npm run test:release:live

# CLI 默认链路效率门禁：真实 StepFun 路由 + wall-clock 成功率/延迟/工具风暴阈值
npm run release:cli-efficiency

# 桌面 UI smoke：需要先完成 renderer build
npm run test:release:ui

# 一键发版前检查：单测 + 类型 + CLI/Fleet + StepFun efficiency + 构建 + release static gate + UI smoke
npm run release:preflight

# 正式发版全量门禁：preflight + agent regression release bank + CLI200 + GUI100
npm run release:full-gate

# 夜跑优化门禁：full-gate + nightly agent/runtime 回归，用于逐条修正用户体验问题
npm run release:overnight

# 真实安装包门禁：候选包装入 /Applications 后运行；覆盖 GUI server、CLI、Settings、主聊天 UI、并发 Hanako 复查
npm run release:installed-gate

# 清理本机长跑测试残留：只清测试 userData、临时 homes 和 50/100 报告
npm run gate:clean-data

# 发布远端同步检查：GitHub + Gitee 的 main 和 v<version> tag 必须都更新
npm run release:verify-remotes

# 正式 macOS/Windows 打包会先强制执行 release:preflight
npm run dist
npm run dist:win

# 夜间/大版本门禁：含 extended 用例
npm run test:release:nightly
```

`test:release:static` 只扫仓库和发布资产，不连接模型或本机服务。`release:cli-efficiency` 会真实连接默认 StepFun 云端链路，用于 CLI 发版前确认“默认交互路径”没有变慢、断连或工具风暴。`test:release` / `test:release:live` 会读取 `~/.lynn/server-info.json` 并连接当前本机 Lynn。开发版可指定：

```bash
LYNN_HOME=~/.lynn-dev npm run test:release
```

报告输出在 `output/release-regression-*/report.md`，同时保存 `static-results.json` 和 `live-results.json`。

## 分层

### Static Gate

不启动模型，直接扫仓库和发布资产：

- `package.json` 必须有 build/test/release manifest 入口。
- `package.json` 必须有 `release:verify-remotes`，用于发布后校验 GitHub/Gitee 双端同步。
- `release:full-gate` 必须包含 `release:preflight`、`test:agent-regression:gates`、`gate:cli-200`、`gate:gui-100` 和 `gate:clean-data`。
- `release:overnight` 必须包含 `release:full-gate`、agent regression nightly 和 release nightly。
- `.github/update-manifest.json` 二进制资产不能指 GitHub `.dmg/.exe`，必须走腾讯镜像。
- `site/app.js`、`site/download.html`、`site/index.html` 不能把 `.dmg/.exe` 链到 GitHub。
- 核心 UI 文件必须存在：AssistantMessage、ThinkingBlock、ToolGroupBlock、WritingDiffViewer、TaskModePicker、PressToTalkButton、streaming store。
- WebSocket 事件协议必须保留共享定义：`shared/ws-events.ts`。
- 多语言文件必须存在。
- README 必须提到当前 `package.json` 版本。

### Live Gate

通过真实 WebSocket 走 Lynn 当前服务，不裸打模型端点。重点覆盖今天暴露过的问题：

- 首包和 `turn_end` 是否正常。
- 空答、0 token、超时。
- thinking 是否泄露到可见文本。
- `<web_search>`、`<bash>`、`||1read||{}`、`web_search(...)` 等伪工具格式是否泄露。
- 工具请求是否真的 emit `tool_start/tool_end`。
- 工具 turn 后下一 prompt 是否被污染。
- 同一个 WebSocket 内跨轮记忆是否正常。
- 工具失败/工具慢时是否有可见答复。
- 安全边界：系统提示词、密钥、服务器密码不得外泄。
- 长写作、代码、数据分析不应退化为空答或循环。

### Installed App Gate

`npm run release:installed-gate` 是正式发版/覆盖线上前的阻断门禁。它必须在候选包已经安装到
`/Applications/Lynn.app` 后运行,并且测试对象必须是这个安装包,不能是 dev server 或源码启动进程。

覆盖范围:

- `packaged-server-smoke`:真实包 server 冷启动、原生模块、health、配置污染修复。
- `packaged-cli-runtime-smoke`:真实包内 CLI runtime,避免全局 `lynn` 旧拷贝误判。
- `packaged-settings-provider-smoke`:真实 Electron Settings 窗口,Provider 去重、Key 状态、读取/删除模型不回流。
- `packaged-main-ui-smoke`:真实 Electron 主聊天窗口,隔离 `LYNN_HOME`,种入 BYOK DeepSeek V4 Pro/Flash,在窄窗下点击输入栏、模型下拉、任务模式、执行模式并断言控件没有截断或横向溢出。
- 并发自动复查:真实 WebSocket + `/api/review`,一次发起 3 个 Hanako 自动复查,必须全部收到非空 `review_result`。

失败即阻断发布。若外部模型/Brain 暂时不可用,结果也是阻断,不能降级成 warning;这是为了避免“本地看起来能开,真实用户路径不可用”。

### Manual UI Gate

自动脚本不能完全替代真实桌面视觉检查。正式发版前必须用打包后的 app 做一次人工 UI 检查：

1. 首屏：会话列表、输入框、模型选择、安全模式、任务模式、语音按钮无重叠。
2. 发送短 prompt：用户消息、助手消息、thinking block、停止按钮状态正确。
3. 发送工具 prompt：工具卡片展开/折叠、失败态、重试态、最终答案都可见。
4. 发送长输出：滚动、代码块、复制按钮、Markdown 表格不遮挡。
5. 触发文件 diff：diff viewer、apply/reject、rollback 可见且不挤压。
6. Settings：Providers、Voice、Bridge、Security 在 1280px 宽度下无截断。
7. Voice：长按录音、权限提示、ASR 插入、TTS 播放状态至少跑一次。
8. Bridge：微信/飞书各跑一条短问答和一条工具问答。

新增/修改过按钮、菜单、面板、复查、Provider、CLI 交互时,必须把对应按钮加入当次验收记录。没有截图/日志路径的“已看过”不算通过。

### Electron UI Smoke

`npm run test:release:ui` 会启动真实 Electron 窗口，但使用内置 UI fixture，不连接模型和服务器。它会截图并断言 4 个高风险界面：

- `home`：首屏 / 侧栏 / 标题栏。
- `short`：短问答消息、头像、操作栏。
- `tools`：工具组、工具完成态、文件 diff 卡片。
- `long-code`：长输出、thinking block、代码块、底部操作栏。

截图和结果保存在 `output/ui-smoke-*/`。这一步用于抓 UI 遮挡、空白页、构建入口缺失和核心组件渲染崩溃；真实工具链体验仍由 `npm run test:release` 和人工 UI Gate 覆盖。

## 阻断规则

- `blocker` 失败：禁止发版。
- `critical` 失败：正式发版禁止；hotpatch 必须写明风险并复测相关用例。
- `extended` 失败：不阻断 hotpatch，但大版本发布前必须处理或记录。

## 与 V8/V9 的关系

V8/V9 benchmark 主要衡量模型能力和路由质量；release regression 主要衡量用户会不会遇到坏体验。hotfix 打包前至少跑到 `release:preflight`；正式版本发布必须跑到 `release:full-gate`。大版本、模型链路改动、GUI/CLI 行为改动或用户体验疑难问题收敛，必须跑 `release:overnight`。发版前顺序应是：

1. `npm test`
2. `npm run typecheck`
3. `npm run build:server`
4. `npm run build:main`
5. `npm run build:renderer`
6. `npm run release:cli-efficiency`（CLI 发版必跑；GUI-only hotpatch 可记录原因后跳过）
7. `npm run test:release:static`
8. `npm run test:release:ui`
9. 正式发版长跑：`npm run release:full-gate`（包含 CLI200 + GUI100）
10. 夜跑优化：`npm run release:overnight`（大版本/模型链路/体验疑难必跑）
11. 平台打包、公证、manifest、镜像站更新（`dist` / `dist:win` 会先跑 `release:preflight`）
12. GitHub Release + Gitee Release/仓库同步，然后跑 `npm run release:verify-remotes`
13. 真实安装包 smoke + `npm run release:installed-gate`
14. 启动打包后的 Lynn 服务后跑 `npm run test:release:live`
15. 人工 UI Gate(按钮矩阵 + 截图/日志路径)

CLI200/GUI100 的目标不是“输出里没出现几个坏词”就算过。关键词只用于抓泄漏、空答模板、伪工具格式和历史事故指纹；每条失败必须按 ReAct 方式收敛：

1. **拆分任务**：标明用户真实意图、是否需要实时证据、是否需要工具。
2. **执行路径**：确认 CLI/GUI 是否走同一类路由、是否触发工具、是否有 provider/usage/事件。
3. **观察证据**：看报告里的 text、toolEvents、providerTrail、rawTail，而不是只看失败关键词。
4. **复核体验**：判断答案是否满足普通用户问题、是否有时间/来源/不确定性说明。
5. **修复闭环**：修路由、工具、事件或文案；不要用新增大量关键词把坏输出“分类掉”。

不要用裸 `/v1/chat/completions` 结果替代 `test:release`。裸模型端点测不到 Lynn 的 WebSocket、事件解析、UI 渲染、工具卡片和跨 prompt fence。

## 新增用例原则

新增回归用例时必须满足至少一条：

- 复现过真实用户可见 bug。
- 能捕获工具协议、streaming、UI event contract、发布资产中的高风险回归。
- 有明确机器可判定的失败条件。
- 不依赖长时间外部服务，或外部失败时能给出清晰原因。

用例位置：`tests/release-regression/release-regression-cases.mjs`。
