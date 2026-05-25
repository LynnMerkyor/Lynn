# Lynn v0.79.1 Release Notes

> 发布日期: 2026-05-25 · 代号: "9B MTP 默认回归"

v0.79.1 是 v0.79 本地模型体验的正式收口版本。默认本地引导模型保持为 **Qwen3.5-9B Q4_K_M imatrix MTP**(5.38GB,24GB 显存/统一内存推荐)。Spark 复测确认 4B imatrix 在 thinking-on 下仍可能出现长思考后无正文,因此 4B 只保留为低配降级档,并在模型页明确提示风险。

## 2026-05-25 架构与安全补打包

- `server/routes/chat.js` 已把内容抽取、session 持久化、local Qwen direct policy、rate limit、tool summary、artifact shape 和编辑回滚状态拆到独立模块,降低聊天主链回归风险。
- 本地模型下载器增加安全边界:只接受 `http/https` GGUF 源,拒绝 URL 凭证、本机/私网源和非 GGUF 初始文件名;重定向后继续复核来源安全。
- 本地模型 profile 与 provider state 收敛到共享模块,设置页/输入区不再把非默认端点误写成 4B 占用,token 统计明确为本地端点累计处理量。
- Deep Research / session 历史 / tool recovery 共用同一个 artifact payload 规范,HTML 报告在本地模型、BYOK 和默认模型路径下都能落为聊天内可点击预览卡片。

## 重点更新

### 默认本地模型保持 Qwen3.5-9B MTP
- 设置 → 模型内的"本地模型"卡片默认指向 **Qwen3.5-9B Q4_K_M imatrix MTP**,5.38 GB,24GB 显存/统一内存推荐。
- 9B 保留 MTP 加速和更稳的 thinking-on 路径,避免 4B 在短问候、天气、GPQA 等场景出现长思考后无正文。
- 4B imatrix 直连 smoke:thinking-off 短问候正常、门禁工具调用正常;thinking-on 短问候/GPQA probe 可能长思考后无正文。Spark MMLU500 thinking-on 为 81.20%;GPQA thinking-on 本轮只跑出 15/198,判定无效。thinking-off 口径 MMLU500 为 73.00%,GPQA Diamond 为 16.67%。
- 模型源: ModelScope `Merkyor/Qwen3.5-9B-GGUF-imatrix` · HF mirror `hf-mirror.com/nerkyor/Qwen3.5-9B-GGUF-imatrix`(2 源 fallback,sha256 校验)。

### 三档硬件分级
| 档位 | 模型 | 推荐硬件 | 体积 |
|------|------|---------|:----:|
| **默认** | Qwen3.5-9B Q4_K_M imatrix MTP | **24GB 显存/统一内存+** | 5.38 GB |
| 降级 | Qwen3.5-4B Q4_K_M imatrix (Lynn) | 8~16GB 可选 · 建议 thinking-off | 2.6 GB |
| 高端 | Qwen3.6-35B-A3B Q4_K_M imatrix | 24GB 显存/统一内存+ | 21 GB |

4B/35B 按硬件浮现到模型卡的"可选本地模型"区,无需手动配置。

### Deep Research HTML 报告
- 深度调研现在会生成聊天内可点击预览的 HTML 报告,并在 session JSONL 中持久化 `create_artifact`。
- 本地 9B / BYOK thinking 模型如果出现 reasoning-only 空正文,服务端会自动 no-think fallback,避免用户得到空结果。
- 403/401/429 非 JSON 错误会按认证/限流分类,不再误报为 invalid JSON。

### 兼容性与迁移
- 已有 4B/旧 4B thinking provider 会自动迁回默认 9B provider;35B 配置不强迁。
- API endpoint `/api/local-qwen35-9b/*` 路径保留(backward compat);文件 ID 回到 `local-qwen35-9b-q4km-imatrix` / `qwen35-9b-q4km-imatrix`。
- 模型页、输入区、状态条、README / README_EN / 镜像站 copy 已统一到 9B 默认、4B 降级风险口径。

### 回归门禁
- `npm test`: **172 files / 1390 passed / 1 skipped** ✓
- TypeScript: `tsc --noEmit` ✓
- ESLint: `npm run lint` ✓
- Build gates:server / main / renderer build ✓
- Deep Research 安装版三路门禁:本地 9B / BYOK GLM-5.1 / 默认 Brain 均输出正文 + HTML artifact + session 持久化 ✓
- 安装版 smoke:本地 9B / GPT-5.4 / 默认模型均 `Failed:0; blocker:0; critical:0` ✓

## English Summary

v0.79.1 finalizes the v0.79 local-model onboarding path. The default local model remains **Qwen3.5-9B Q4_K_M imatrix MTP** (5.38GB, 24GB VRAM/unified memory recommended). The 4B imatrix build is kept as a low-config downgrade only because Spark retests reproduced a thinking-on risk where the model can spend a long time reasoning and return no visible answer.

Highlights:
- Default local tier: Qwen3.5-9B Q4_K_M imatrix MTP with MTP acceleration and a clearer 24GB recommendation.
- Low-config downgrade: Qwen3.5-4B Q4_K_M imatrix, thinking-off recommended; thinking-on risk is documented in the Models page.
- Deep Research now creates a clickable HTML report inside chat and persists the artifact into the session JSONL.
- Local 9B and BYOK thinking models retry with no-think fallback when the first response contains reasoning only but no visible answer.
- Same-version architecture refresh splits the chat route, hardens local GGUF downloads, unifies provider state, and normalizes Deep Research artifact payloads across local, BYOK, and default paths.
- Installed-app gates passed for local 9B, GPT-5.4, the default model, and Deep Research across local/BYOK/default paths.

---

# Lynn v0.79.0 Release Notes

> 发布日期: 2026-05-22 · 代号: "Local 9B"

v0.79.0 是 Lynn 的本地模型大版本。它把 Qwen3.5-9B Q4_K_M imatrix 接入为一键安装、离线使用的默认本地模型路径,同时补齐本地模型状态、暖机提示、GGUF 导入、35B 高配模型下载/启动和 Brain V2 配置迁移。

## 重点更新

### 本地 9B,离线日常使用
- 设置 → 模型内新增“本地 Qwen3.5-9B”入口,授权后自动准备 llama.cpp、下载/校验 GGUF、启动本地 OpenAI `/v1` 端点并注册 provider。
- 默认模型为 Qwen3.5-9B Q4_K_M imatrix MTP,约 5.38GB,32K 上下文;Spark 口径:MMLU 100 sample 81.00%,GPQA Diamond 72.22% naive / 81.71% excluding parse-fail,工具调用 14/15。
- 输入框、状态条和设置页都会显示本地模型运行、加载、空闲槽位、token 统计和停止入口。

### 本地模型管理器
- 35B 推荐模型改为应用内下载:Qwen3.6-35B-A3B Q4_K_M imatrix,24GB 显存/统一内存+ 推荐;thinking-on 32K:MMLU 90.40% / GPQA Diamond 80.70%,R6000 参考 207 tok/s。
- 下载不再跳外部页面;支持多路 Range 下载、进度条、来源显示、sha256 校验、取消下载和下载后启动。
- 支持导入用户自己下载的 GGUF,Lynn 按当前硬件配置启动 llama.cpp 并同步本地端点状态。

### 暖机与长等待反馈
- 本地模型首次启动/首问增加醒目暖机提示:首次加载权重和预热上下文可能需要 30-60 秒,后续同会话明显更快。
- 推理中显示本地 9B 正在组织答案、工具调用耗时、思考状态和从左到右的等待动效,避免用户误以为卡死。

### Brain V2 与默认链路稳定性
- 老用户的 Brain v1/base_url 配置会自动迁移回 Brain V2 canonical endpoint,避免天气/工具类问题走旧链路失效。
- 修复 GLM Coding Plan 端点配置和空答兜底;原则上不干预模型输出,只在空转/不可见答案时做明确兜底。
- 本地 9B 与默认 Brain 模型都保留工具调用路径,天气、搜索、行情等只读工具不被客户端提前拦截。

## 回归结果

- Full test suite: `168 files / 1447 passed / 1 skipped`
- TypeScript: passed
- Renderer build / local install / signing: passed
- Local 9B GUI smoke:启动、暖机提示、状态条、停止入口、35B 下载取消流程验证通过

## 下载

- macOS Apple Silicon: `Lynn-0.79.0-macOS-Apple-Silicon.dmg`
- macOS Intel: `Lynn-0.79.0-macOS-Intel.dmg`
- Windows x64: `Lynn-0.79.0-Windows-Setup.exe`
- 镜像站:https://download.merkyorlynn.com/download
- GitHub:https://github.com/MerkyorLynn/Lynn/releases/tag/v0.79.0

## 升级建议

建议所有用户升级。Mac / Windows 普通用户可直接使用内置 9B 本地模型获得离线、不消耗云端额度的日常体验;高配用户可在“模型”页导入或下载 35B GGUF。
