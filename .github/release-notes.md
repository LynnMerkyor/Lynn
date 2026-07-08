# Lynn v0.85.8 Release Notes / 发布说明

> 发布日期: 2026-07-09 · 本地 27B 启动兼容热修 / Mac manager 稳定性 / CLI 与镜像站同步

## 国内镜像站下载（推荐）

国内用户请优先使用镜像站地址；正式版本记录见 GitHub / Gitee Releases，下载以镜像站为准。

- **GitHub Releases (old)**: https://github.com/LynnMerkyor/Lynn/releases/tag/v0.85.8
- **GitHub Releases (new)**: https://github.com/MerkyorLynn/Lynn/releases/tag/v0.85.8
- **Gitee Releases**: https://gitee.com/merkyor/Lynn/releases/tag/v0.85.8

- **CLI**:

  ```bash
  npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.85.8.tgz"
  ```

- **macOS Apple Silicon / ARM64**: https://download.merkyorlynn.com/downloads/Lynn-0.85.8-macOS-arm64.dmg
- **macOS Intel / x64**: https://download.merkyorlynn.com/downloads/Lynn-0.85.8-macOS-x64.dmg
- **Windows x64**: https://download.merkyorlynn.com/downloads/Lynn-0.85.8-Windows-Setup.exe
- **下载页**: https://download.merkyorlynn.com/download.html

## 中文重点

- **修复 GitHub #2 Windows 27B 启动失败**: 部分 Win11 环境中的 llama.cpp 不支持 v0.85.7 固定传入的新版 MTP / reasoning / KV cache 参数，导致模型校验完成后服务立即退出。v0.85.8 会按本机 llama.cpp 实际支持的参数自动降级启动。
- **本地 27B Qwen 工具调用适配**: 本地 BYOK 27B 如果输出 Qwen XML / special-token / legacy `function_call` 工具格式，Lynn runtime 会转成真实 GUI/CLI 工具执行，再把工具结果回写给模型继续总结，避免“只清洗伪工具文本但没实际执行”。
- **主聊天和设置页都显示明确失败原因**: 本地 27B 启动失败时不再像“没反应”，会显示 llama.cpp 退出原因和最近 stderr/stdout，便于用户和开发者定位。
- **Mac 本地模型 manager 稳定性补强**: `--help` 能力探测结果会正确缓存，空输出/异常二进制也不会在一次启动中反复 probe；停止/崩溃状态更清楚。
- **CLI 同步发版**: CLI 包版本、README、下载页、update manifest、镜像站安装命令统一升级到 v0.85.8，避免用户安装到旧包或看到旧版本提示。
- **保留 v0.85.7 端侧模型链路**: 默认仍是公开 27B Coding Q4 imatrix MTP；低配设备不主动弹安装引导，9B / 4B 作为显式降级选择保留。
- **保留 v0.85.6+ 回归修复**: 本地绝对路径读取、`file://` 元问题、防串题污染、Windows CMD 弹窗、会话进度右栏和 Agent regression 门禁继续保留。

## 已验证

- `npm test` 通过。
- `npm run test:agent-regression` 通过。
- `npm run test:agent-regression:gates:smoke` 通过。
- `npm run typecheck` 与 `npm run typecheck:runtime` 通过。
- `npm run build:cli`、`npm run build:main`、`npm run build:renderer`、`npm run build:server:win` 通过。
- `gate:cli-100` 作为本轮 CLI 体验门禁执行。
- macOS Apple Silicon / Intel DMG 将完成 Developer ID 签名、Apple notarization、staple 和 Gatekeeper 校验。
- Windows x64 NSIS 安装包将生成并签名；CLI tarball 同步镜像站。

---

> Release date: 2026-07-09 · local 27B startup compatibility hotfix / Mac manager hardening / CLI and mirror sync

## English highlights

- **Fixes GitHub #2 Windows 27B startup failure**: some Win11 environments have a llama.cpp binary that does not support the v0.85.7 MTP / reasoning / KV-cache flags. Lynn now strips unsupported optional flags based on the local binary's actual `--help` output.
- **Adapts local 27B Qwen tool calls**: Qwen XML / special-token / legacy `function_call` output is converted into real Lynn tool execution before final synthesis, so the local model works as an agent instead of a chat-only fallback.
- **Makes local-model failures visible**: both chat and Settings now surface the llama.cpp failure reason plus recent child stdout/stderr instead of looking idle.
- **Hardens the Mac local-model manager**: llama.cpp capability probing is cached reliably, including empty or failed help output, avoiding repeated probes during a single launch.
- **Ships CLI as part of the same release**: CLI package version, README, download page, update manifest, and mirror install command all move to v0.85.8.
- **Keeps the v0.85.7 edge-model chain**: the public 27B Coding Q4 imatrix MTP model remains the default local recommendation; 9B / 4B stay as explicit downgrade choices.
