## 国内镜像站下载（推荐） / Downloads

国内用户请优先使用镜像站；GitHub Assets 作为备用下载。

```bash
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.87.1.tgz"
Lynn --version
```

- [macOS Apple Silicon / ARM64](https://download.merkyorlynn.com/downloads/Lynn-0.87.1-macOS-arm64.dmg)
- [macOS Intel / x64](https://download.merkyorlynn.com/downloads/Lynn-0.87.1-macOS-x64.dmg)
- [Windows x64](https://download.merkyorlynn.com/downloads/Lynn-0.87.1-Windows-Setup.exe)
- [国内下载页](https://download.merkyorlynn.com/download.html)

# Lynn v0.87.1 Release Notes / 发布说明

2026-10-09 · Step 5、实时语音与 Coder390 本地模型

## 中文重点

- **GUI / CLI 默认工作模型**：统一使用 `step-5-preview`，保留已有配置的兼容入口。
- **实时语音**：恢复 `stepaudio-2.5-realtime`，GUI 与 CLI 共用 Brain 托管的语音链路。
- **工具参数由模型分析**：天气、体育、行情和汇率接收模型填写的地点、联赛、代码和货币对；取消从用户整句问题猜参数的预取路径。
- **复合地点**：保留“顺德大良”等完整地点；必要的上级地点由模型明确提供，不自动裁剪或猜测。
- **Coder390 本地模型**：Qwen3.8-27B Coder390 EfficientThink Q3 / Q2，来自指定 ModelScope GGUF 仓库。Q3 为 17.30 GB、8K 初始上下文；Q2 为 13.28 GB、4K 初始上下文。16GB 及以上默认选择 Q3，16GB 以下选择 Q2；实际运行还需缓存与缓冲空间。
- **内置 Q4 MTP**：两档使用内置 MTP，不另下载 DFlash2 草稿；本次安装不含视觉组件。按固定字节数与 SHA-256 校验文件，保留已经下载的旧模型和手动导入入口。
- **设置与说明对齐**：默认安装选项保留 Q3 / Q2，更新五种语言提示、中英文 README 和运行时帮助。
- **固定数据输出**：要求输出指定 JSON 或字面数据时，运行时信息不得改写用户给定的常量值。
- 延续 V0.87.0 的窗边树影、斜杠模板、文件与图片面板，以及按需安装的专家圆桌插件。

## English highlights

- GUI and CLI request `step-5-preview` by default, retaining migration compatibility.
- Restore `stepaudio-2.5-realtime` for the shared Brain-hosted realtime voice path.
- Let the model supply places, leagues, tickers and currency pairs. Remove entity guessing from whole-question prefetch.
- Preserve compound places such as Shunde Daliang; parent-place fallbacks must be supplied explicitly by the model.
- Switch local tiers to Qwen3.8-27B Coder390 EfficientThink: Q3 is 17.30 GB with an initial 8K context; Q2 is 13.28 GB with an initial 4K context. The default tier selection is Q3 at 16GB and above, Q2 below 16GB. Caches and runtime buffers require additional memory.
- Both GGUF tiers include Q4 MTP, with no separate DFlash2 draft or vision component downloaded by this installation. Verify pinned sizes and SHA-256 values; preserve older files and manual import.
- Align settings, five-language hints, runtime help and both READMEs.
- Preserve user-supplied constants when emitting requested JSON or other literal data.
- Retain V0.87.0 interface features and the optional expert-roundtable plugin.

## 模型与仓库 / Models and repositories

- [Coder390 Q3 / Q2 模型卡](https://modelscope.cn/models/Merkyor/Qwen3.8-27B-Coder390-EfficientThink-Opus5.5-GPT6Astra-Grok4.7-DSV4Pro-K3-SFT-RLOO-GGUF-NInfer)
- [GitHub · LynnMerkyor/Lynn](https://github.com/LynnMerkyor/Lynn/releases/tag/v0.87.1)
- [GitHub · MerkyorLynn/Lynn](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.87.1)
- [Gitee · merkyor/Lynn](https://gitee.com/merkyor/Lynn/releases/tag/v0.87.1)
