# Lynn v0.85.7 Release Notes / 发布说明

> 发布日期: 2026-07-07 · 27B Coding Q4 MTP 默认端侧模型 / 本地模型安装链路修复 / 三远端+镜像发版纪律

## 国内镜像站下载（推荐）

国内用户请优先使用以下镜像站地址；正式版本记录见 GitHub / Gitee Releases，下载请以镜像站为准。

- **GitHub Releases (old)**: https://github.com/LynnMerkyor/Lynn/releases/tag/v0.85.7
- **GitHub Releases (new)**: https://github.com/MerkyorLynn/Lynn/releases/tag/v0.85.7
- **Gitee Releases**: https://gitee.com/merkyor/Lynn/releases/tag/v0.85.7

- **CLI**:

  ```bash
  npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.85.7.tgz"
  ```

- **macOS Apple Silicon / ARM64**: https://download.merkyorlynn.com/downloads/Lynn-0.85.7-macOS-arm64.dmg
- **macOS Intel / x64**: https://download.merkyorlynn.com/downloads/Lynn-0.85.7-macOS-x64.dmg
- **Windows x64**: https://download.merkyorlynn.com/downloads/Lynn-0.85.7-Windows-Setup.exe
- **下载页**: https://download.merkyorlynn.com/download.html

## 中文重点

- **端侧默认模型换成 27B Coding Q4 MTP**: 本地模型推荐改为公开可下载的 `Qwen3.6-27B-DSV4Pro-GLM52-SFT-GPT55-RL-Coding-GGUF` Q4 imatrix MTP 四分片，默认下载 `Q4_LynnStyle/Q4-imatrix-MTP-00001-of-00004.gguf` 到 `00004`，总量约 19.6GB。
- **公开模型链接修正**: README、下载页、Release notes 和模型入口不再指向打不开的非 GGUF 页面，ModelScope / HuggingFace 都指向 GGUF 镜像。
- **低配不主动打扰**: 硬件不足时聊天窗不会主动弹 27B 安装引导；9B / 4B 只保留为设置页里的低配降级选择。
- **修复 GitHub #75 本地模型 `python3_not_found`**: 桌面端本地模型安装优先走 Electron 主进程 downloader，不再把用户带回旧 Python bootstrap；缺 Python 不再阻断“设置 → 模型 → 加载本地模型”。
- **下载链路支持四分片校验**: 27B Q4 默认档会按 shard 顺序下载、校验 SHA256、保留已完成分片，并在完成后按用户授权启动 llama.cpp MTP 端点。
- **发版流程加严**: 每次新版本/同版本热修都必须同步 `LynnMerkyor/Lynn`、`MerkyorLynn/Lynn`、Gitee `merkyor/Lynn` 和腾讯镜像下载站；`release:verify-remotes` 默认校验三个代码远端。
- **保留 v0.85.6 修复**: 本地绝对路径读取、`file://` 元问题、防串题污染、Windows CMD 弹窗、会话进度右栏和 GUI/CLI 回归门禁继续保留。

## 已验证

- `npm test -- tests/llamacpp-profiles.test.js desktop/src/react/settings/tabs/providers/local-qwen-provider.test.ts tests/migrate-providers.test.js` 通过。
- `npm test -- desktop/__tests__/ProviderDetail.helpers.test.ts` 通过。
- `node --check` 通过：`desktop/llamacpp-profiles.cjs`、`desktop/local-model-controller.cjs`、`desktop/llamacpp-manager.cjs`、`desktop/model-downloader.cjs`、`scripts/verify-release-remotes.mjs`。
- 正式发布前仍需跑完整 `release:preflight` / 打包 / 公证 / 安装态门禁 / 三远端同步校验。

---

> Release date: 2026-07-07 · 27B Coding Q4 MTP default edge model / local-model setup fix / three-remote + mirror release discipline

## English highlights

- **Switches the default local edge model to 27B Coding Q4 MTP**: Lynn now recommends the public `Qwen3.6-27B-DSV4Pro-GLM52-SFT-GPT55-RL-Coding-GGUF` Q4 imatrix MTP split GGUF by default, about 19.6GB across four shards.
- **Fixes public model links**: README, release notes, download pages, and model entry points now link to the public GGUF mirrors instead of unavailable non-GGUF pages.
- **Keeps low-config machines quiet**: Lynn no longer proactively prompts underpowered devices to install 27B; 9B / 4B remain explicit downgrade choices in Settings.
- **Fixes GitHub #75 `python3_not_found`**: desktop local-model setup now uses the Electron main-process downloader first, so missing Python no longer blocks Settings → Models → load local model.
- **Supports four-shard download and verification**: the 27B Q4 default downloads each shard, verifies SHA256, preserves completed shards, and starts the llama.cpp MTP endpoint only after user authorization.
- **Hardens release discipline**: every release or same-version hotfix must update both GitHub repos, Gitee, and the Tencent download mirror; `release:verify-remotes` checks all three code remotes by default.
