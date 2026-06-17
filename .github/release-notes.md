# Lynn v0.84.7 Release Notes / 发布说明

> 发布日期: 2026-06-18 · Hanako 自动复查 + 真实 GUI/CLI installed gate + 工具兜底稳定性修复

## 国内镜像站下载（推荐）

国内用户请优先使用以下镜像站地址；Gitee Release 页面仅作为版本记录，下载请以镜像站为准。

- **CLI**:

  ```bash
  npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.84.7.tgz"
  ```

- **macOS Apple Silicon / ARM64**: https://download.merkyorlynn.com/downloads/Lynn-0.84.7-macOS-arm64.dmg
- **macOS Intel / x64**: https://download.merkyorlynn.com/downloads/Lynn-0.84.7-macOS-x64.dmg
- **Windows x64**: https://download.merkyorlynn.com/downloads/Lynn-0.84.7-Windows-Setup.exe
- **下载页**: https://download.merkyorlynn.com/download.html

## 中文重点

- **复杂工具成功但无总结兜底**: 当看图、文件、搜索等复杂工具均已成功执行,但模型没有返回最终总结时,Lynn 会基于工具证据生成可见收口摘要,不再只显示“已执行 N 个操作”。
- **编辑重发恢复修复**: 在上一轮仍处理、WS 繁忙或发送失败时点击“编辑重发”,不会把旧的替换目标残留到下一条普通消息里,避免后续误截上下文或出现 error。
- **Hanako 自动复查兜底**: 默认模型或 BYOK 模型没有返回可见内容、或回答需要复核时，Hanako 会自动启动后台复查并展示复查模型 `Hanako · MiMo/GLM`、结论、发现与建议执行结论。
- **Hanako 复查模型链路修正**: 自动复查优先使用 MiMo,GLM 作为低并发 fallback,避免 GLM 并发 429 导致复查卡住或显示“暂时没跑完”。
- **真实 GUI / CLI installed gate**: 发布前新增真实安装包门禁,会在 `/Applications/Lynn.app` 上点击设置页、provider 列表、主聊天输入区、模型下拉、任务模式、执行模式、语音入口和 Hanako 自动复查;CLI 同步跑真实安装包命令。
- **主聊天窄窗输入区修复**: 不全屏或打开左侧栏时,输入框、底部按钮和模型下拉不再横向溢出或被裁切。
- **DeepSeek V4 Pro / V4 Flash 实测可用**: 本地包已用 DeepSeek V4 Pro 与 V4 Flash 做多轮对话、世界杯/NBA/金价/NVDA 等工具场景验证。
- **Issue #74 provider 配置修复**: provider id 大小写归一去重，旧版不可读 API Key 明确提示重填，重复 DeepSeek 条目不再把模型路由到空 key provider。
- **BYOK 思考模型空答污染修复**: 纯空 assistant 轮会写入可见兜底文本，并在下一轮 prompt 前清理历史里的空 assistant 轮，避免一次空答污染整条会话。
- **DeepSeek V4 参数修正**: DeepSeek V4 Pro / V4 Flash 保持 1M 上下文，输出预算回到 provider 安全上限。
- **模型配置页修复**: 删除 deprecated / 误读出的模型后不会循环回到添加列表；留空保存不会覆盖已有 Key。
- **实时搜索、比分、行情工具加强**: BYOK 工具搜索优先走 Brain GLM/MiMo 链路；世界杯赛程、NBA 比分、金价、NVDA 等场景使用结构化/可解析数据源，避免 Baidu/Bing 搜索页或 JS 行情页污染证据。
- **伪工具流式清理加强**: 跨 chunk 的伪 `<tool_call>` / `<function=...>` 标记会被缓存并清理，合法 HTML/JSX/泛型文本不会被误吞。
- **安全与运行时加固**: self-update 校验 SHA256，PDF/RAG 外部命令改为安全参数调用，worker shell 调用收紧，Brain web-search 需要设备签名。
- **已保留 v0.84.4 修复**: 会话重启保留、编辑重发真实回退上下文、内容过滤误杀修复、右上角图标重叠修复、CLI 实时语音主链等继续有效。

## 验证

- `npm run typecheck`
- `npm run typecheck:runtime`
- `npm run build:server`
- `npm run build:main`
- `npm run build:renderer`
- `npm run build:cli`
- `npm test`（当前发布机 PTY 池耗尽，真 TTY 子集无法在本会话完成；非 PTY 测试、GUI/CLI/Agent gates 已通过）
- `npm run test:release:static`
- `npm run test:release:ui`
- `npm run gate:startup`
- `npm run gate:cli-task`
- `npm run gate:gui-task`
- `npm run gate:agent-matrix`
- `npm run test:brain-v2`
- CLI tarball pack/install smoke
- macOS arm64/x64 打包签名、公证、staple、Gatekeeper 校验
- Windows x64 NSIS 打包签名

---

> Release date: 2026-06-18 · Hanako automatic review + real GUI/CLI installed gate + tool fallback stability

## English highlights

- **Tool-success fallback summaries**: when complex tools such as vision, files, or search complete successfully but the model returns no final prose, Lynn now summarizes the retained tool evidence instead of only saying that operations ran.
- **Edit-resend recovery fix**: clicking edit-resend while a turn is still processing, the socket is busy, or a send fails no longer leaves a stale replacement target that can affect the next normal prompt.
- **Hanako automatic review fallback**: when the default model or a BYOK model returns no visible content, or a response needs verification, Hanako can start a background review and show the review model `Hanako · MiMo/GLM`, findings, conclusion, and suggested execution result.
- **Hanako review model chain corrected**: automatic reviews prefer MiMo and use GLM as a low-concurrency fallback, avoiding GLM 429s that previously left reviews unfinished.
- **Real GUI / CLI installed gate**: release gates now exercise the installed `/Applications/Lynn.app`, including Settings, provider lists, the main composer, model picker, task/security modes, voice entry, and Hanako auto-review; CLI commands are checked from the installed package as well.
- **Main chat narrow-window composer fix**: when the window is not fullscreen or the sidebar is open, the composer, bottom controls, and model picker no longer overflow or get clipped.
- **DeepSeek V4 Pro / V4 Flash verified**: the local package was tested with DeepSeek V4 Pro and V4 Flash across multi-turn chat and tool-backed World Cup, NBA, gold, and NVDA scenarios.
- **Issue #74 provider configuration fixes**: provider ids are normalized, duplicate DeepSeek entries are merged, unreadable legacy API keys now ask the user to re-enter once, and models no longer route to an empty-key provider.
- **BYOK thinking-model empty-turn protection**: empty assistant turns persist a visible fallback and are stripped before the next prompt, preventing one empty answer from poisoning the whole thread.
- **DeepSeek V4 parameters corrected**: V4 Pro / V4 Flash keep 1M context while output budget is capped to a provider-safe value.
- **Provider model list fixes**: deleted deprecated/discovered models no longer loop back into the add list; saving with a blank key no longer overwrites an existing key.
- **Realtime search, sports, gold, and US-stock paths improved**: BYOK tools prefer the Brain GLM/MiMo chain and structured quote sources instead of polluted Baidu/Bing search pages or JS-only quote pages.
- **Pseudo tool-call stream cleanup**: split pseudo-tool markers are buffered and stripped without swallowing legitimate HTML/JSX/generic text.
- **Runtime hardening**: self-update now verifies SHA256, PDF/RAG command execution uses safe argv calls, worker shell execution is tightened, and Brain web-search requires device signatures.
