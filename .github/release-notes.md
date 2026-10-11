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

2026-10-11 · Step 5、实时语音与 Coder390 本地模型

## 中文重点

- **安装容量门槛**：低于 14GiB（如 13GB）或检测失败时禁止安装；14～不足 16GiB 仅达到 Q2 最低门槛，16GB 推荐 Q2，24GB 及以上推荐 Q3。Apple Silicon 看统一内存，NVIDIA 看单卡显存，不叠加多卡、不混用系统内存。手动选档不能绕过检查，文件之外还需预留上下文缓存和运行缓冲。

- **GUI / CLI 默认工作模型**：统一使用 `step-5-preview`，保留已有配置的兼容入口。
- **实时语音**：恢复 `stepaudio-2.5-realtime`，GUI 与 CLI 共用 Brain 托管的语音链路。
- **工具参数由模型分析**：天气、体育、行情和汇率接收模型填写的地点、联赛、日期、球队、代码和货币对；取消从用户整句问题猜参数的预取路径。体育数据源不再猜日期或从句子抽球队，缺日期时明确要求模型补齐。
- **复合地点**：保留“顺德大良”等完整地点；必要的上级地点由模型明确提供，不自动裁剪或猜测。
- **模型回答收尾**：不再把“本次证据不足或上游失败”误判为没有工具能力。候选耗尽时只做一次有界模型收尾；原始工具账本不再冒充成功答案。
- **客户端收尾修复**：工具轮数用尽后让原模型基于完整证据做无工具收尾，不再裁剪搜索片段拼答案。持续思考或输出会刷新工具后空闲计时，总时限保持不变。
- **纯整理任务**：GUI 与 CLI 共用任务遵循提示，保留用户原文的相对日期与全部行动项，不擅自增加日历查询；需要查证、换算或实时信息时仍由模型决定工具参数。
- **Coder390 本地模型**：Qwen3.8-27B Coder390 EfficientThink Q3 / Q2，来自指定 ModelScope GGUF 仓库。Q3 为 17.30 GB、8K 初始上下文；Q2 为 13.28 GB、4K 初始上下文。24GB 及以上默认选择 Q3，24GB 以下（16GB 档）选择 Q2；实际运行还需缓存与缓冲空间。
- **内置 Q4 MTP**：两档使用内置 MTP，不另下载 DFlash2 草稿；本次安装不含视觉组件。按固定字节数与 SHA-256 校验文件，保留已经下载的旧模型和手动导入入口。
- **设置与说明对齐**：默认安装选项保留 Q3 / Q2，更新五种语言提示、中英文 README 和运行时帮助。
- **固定数据输出**：要求输出指定 JSON 或字面数据时，运行时信息不得改写用户给定的常量值。
- 延续 V0.87.0 的窗边树影、斜杠模板、文件与图片面板，以及按需安装的专家圆桌插件。

## English highlights

- Block installation below 14GiB or when hardware detection fails. Q2 is recommended at 16GB, Q3 at 24GB; 14 to under 16GiB only meets Q2's minimum. Detect Apple Silicon unified memory or the largest single NVIDIA GPU's VRAM, not summed GPUs or host RAM. Manual selection cannot bypass memory checks.

- GUI and CLI request `step-5-preview` by default, retaining migration compatibility.
- Restore `stepaudio-2.5-realtime` for the shared Brain-hosted realtime voice path.
- Let the model supply places, leagues, dates, teams, tickers and currency pairs. Remove entity guessing from whole-question prefetch; sports sources require explicit dates instead of guessing dates or teams from sentences.
- Preserve compound places such as Shunde Daliang; parent-place fallbacks must be supplied explicitly by the model.
- Preserve model-written explanations of missing evidence or upstream failures instead of misclassifying them as missing tool capability. Exhausted routes use one bounded model recovery; raw tool ledgers no longer masquerade as successful answers.
- Let the original model finalize complete tool evidence without further tools, rather than constructing answers from clipped snippets. Active reasoning or text refreshes the post-tool idle timer without extending the hard turn deadline.
- Share task-fidelity guidance across GUI and CLI: preserve supplied relative dates and every action item during pure transformations, without unrequested calendar lookups. Requested verification, date conversion and realtime research still use model-chosen tool parameters.
- Switch local tiers to Qwen3.8-27B Coder390 EfficientThink: Q3 is 17.30 GB with an initial 8K context; Q2 is 13.28 GB with an initial 4K context. The default tier selection is Q3 at 24GB and above, Q2 below 24GB (16GB tier). Caches and runtime buffers require additional memory.
- Both GGUF tiers include Q4 MTP, with no separate DFlash2 draft or vision component downloaded by this installation. Verify pinned sizes and SHA-256 values; preserve older files and manual import.
- Align settings, five-language hints, runtime help and both READMEs.
- Preserve user-supplied constants when emitting requested JSON or other literal data.
- Retain V0.87.0 interface features and the optional expert-roundtable plugin.

## 模型与仓库 / Models and repositories

- [Coder390 Q3 / Q2 模型卡](https://modelscope.cn/models/Merkyor/Qwen3.8-27B-Coder390-EfficientThink-Opus5.5-GPT6Astra-Grok4.7-DSV4Pro-K3-SFT-RLOO-GGUF-NInfer)
- [GitHub · LynnMerkyor/Lynn](https://github.com/LynnMerkyor/Lynn/releases/tag/v0.87.1)
- [GitHub · MerkyorLynn/Lynn](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.87.1)
- [Gitee · merkyor/Lynn](https://gitee.com/merkyor/Lynn/releases/tag/v0.87.1)
