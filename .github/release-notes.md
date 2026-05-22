# Lynn v0.79.0 Release Notes

> 发布日期: 2026-05-22 · 代号: "Local 9B"

v0.79.0 是 Lynn 的本地模型大版本。它把 Qwen3.5-9B Q4_K_M imatrix 接入为一键安装、离线使用的默认本地模型路径,同时补齐本地模型状态、暖机提示、GGUF 导入、35B 高配模型下载/启动和 Brain V2 配置迁移。

## 重点更新

### 本地 9B,日常无限用
- 设置 → 模型内新增“本地 Qwen3.5-9B”入口,授权后自动准备 llama.cpp、下载/校验 GGUF、启动本地 OpenAI `/v1` 端点并注册 provider。
- 默认模型为 Qwen3.5-9B Q4_K_M imatrix,约 5.3GB,32K 上下文;thinking-on 32K 口径:MMLU 90+ / GPQA 80+。
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

建议所有用户升级。Mac / Windows 普通用户可直接使用内置 9B 本地模型获得离线、无限 token 的日常体验;高配用户可在“模型”页导入或下载 35B GGUF。
