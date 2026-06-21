# Lynn v0.85.0 Release Notes / 发布说明

> 发布日期: 2026-06-21 · 自研核心进入主链 · 证据质量升级 · GUI/CLI 同核收敛

## 国内镜像站下载（推荐）

国内用户请优先使用以下镜像站地址；Gitee Release 页面作为版本记录，下载请以镜像站为准。

- **CLI**:

  ```bash
  npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.85.0.tgz"
  ```

- **macOS Apple Silicon / ARM64**: https://download.merkyorlynn.com/downloads/Lynn-0.85.0-macOS-arm64.dmg
- **macOS Intel / x64**: https://download.merkyorlynn.com/downloads/Lynn-0.85.0-macOS-x64.dmg
- **Windows x64**: https://download.merkyorlynn.com/downloads/Lynn-0.85.0-Windows-Setup.exe
- **下载页**: https://download.merkyorlynn.com/download.html

## 中文重点

- **划时代的自研核心版本**: Lynn 的桌面主链、Bridge、isolated dry-run、Hub agent executor 已收敛到 `core/agent-runtime`，把工具事件、证据账本、空答防污染和可见收口纳入自研运行时，而不是靠一串外围补丁补洞。
- **GUI / CLI 同核**: CLI 已验证的 Brain SSE、OpenAI-compatible transport、JSONL session、runtime frames、prefix-cache 纪律和工具事件回收进桌面 core，GUI 和 CLI 不再各走一套证据逻辑。
- **搜索质量从“快兜底”升级为“证据优先”**: Brain V2 的 evidence handoff 会在拿到足够工具证据后快速交给 StepFun 3.7 Flash 总结；DeepSeek / StepFun / GLM fallback 只在有明确必要时介入，减少工具风暴，也避免无证据空答。
- **体育/实时问题证据修复**: 世界杯赛程、比分、预测类问题统一走 `sports_score` 证据口径。预测问题会使用已知对阵给出赛前预测，并明确标注“预测，不是赛果，也不是博彩建议”；不会再因为实时源暂时失败就秒回空答。
- **本地 Brain 优先**: CLI 默认优先连接 `http://127.0.0.1:8790` 本地 Brain，只有本地不可用才回到托管 Brain，避免本地 GUI/CLI 与线上旧 Brain 行为不一致。
- **证据边界更诚实**: `directSourceStatus`、`userIntent`、fallback 来源会进入预取上下文和流式工具摘要，模型不能把内置赛程兜底包装成实时官方数据。
- **Gitee + 镜像站发布纪律继续收紧**: 更新清单和站点下载链接继续指向腾讯镜像，Gitee Release 作为版本记录；国内用户默认走镜像站下载。

## 已验证

- CLI 50 本地证据质量集: 50 ok / 0 fail。
- GUI 50 证据质量集通过。
- 真实 GUI 追问链路: “今晚世界杯有几场比赛” → “你能预测比分吗？” 可正确复用赛程上下文并给出预测。
- `npm run typecheck`
- Brain critical tests / stream bridge / search context / sports tool tests
- GUI research answer / realtime market-weather / chat route tests
- CLI brain-client tests
- packaged server / packaged CLI smoke
- macOS 打包签名、公证、staple、Gatekeeper 校验（发布包生成后记录最终 hash）

---

> Release date: 2026-06-21 · self-built core on the main path · evidence-quality upgrade · GUI/CLI convergence

## English highlights

- **A milestone self-built core release**: Lynn's desktop chat path, Bridge, isolated dry-run, and Hub agent executor now converge on `core/agent-runtime`, bringing tool events, evidence ledgers, empty-answer protection, and visible fallback summaries into Lynn's own runtime.
- **GUI and CLI share the same evidence path**: Brain SSE, OpenAI-compatible transport, JSONL sessions, runtime frames, prefix-cache discipline, and tool events proven in the CLI are now reused by the desktop runtime.
- **Search quality moves from fast fallback to evidence-first answers**: Brain V2 performs evidence handoff after useful tool results, while StepFun 3.7 Flash synthesizes quickly. Fallback models only enter when needed.
- **Sports and realtime queries are grounded**: World Cup schedule, score, and prediction questions use the `sports_score` evidence path. Prediction turns now answer from known matchups and label the result as a prediction, not a final score or betting advice.
- **Local Brain is preferred by default**: the CLI now connects to `http://127.0.0.1:8790` first, falling back to hosted Brain only when local Brain is unavailable.
- **Source boundaries are explicit**: `directSourceStatus`, `userIntent`, and fallback source labels are preserved in the injected evidence context and visible tool summaries, so fallback schedule data cannot be overstated as live official data.
