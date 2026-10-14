# Lynn v0.87.2 · 长推理与会话管理修复 / Long reasoning and session management

2026-10-14

## 下载 / Downloads

- [macOS Apple Silicon](https://download.merkyorlynn.com/downloads/Lynn-0.87.2-macOS-arm64.dmg)
- [macOS Intel](https://download.merkyorlynn.com/downloads/Lynn-0.87.2-macOS-x64.dmg)
- [Windows x64](https://download.merkyorlynn.com/downloads/Lynn-0.87.2-Windows-Setup.exe)
- [下载说明页](https://download.merkyorlynn.com/download.html)

```bash
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.87.2.tgz"
Lynn --version
```

## 中文

- 长推理使用首段 300 秒、空闲 120 秒的独立计时；每个流数据块刷新空闲计时，默认不设总时限。普通 OpenAI 兼容端点、内置 Qwen 桥接和 CLI 流传输使用同一策略。
- 设置 → 模型服务可调整超时；统一诊断显示模型、Brain、Qwen、CLI 响应头与回合时限的生效值和来源。保留环境变量覆盖，CLI 可运行 `Lynn doctor --offline`。远端服务或代理限制需另行检查。
- 去除英文短答案的标点/长度续写猜测；仅明确截断或推理后空答案才尝试一次恢复。超时不再冒充成功结束，也不无提示切到云端。
- 对话菜单增加二次确认删除，归档列表支持单条删除与批量清空；关闭在途请求和迟到写盘，删除后重启不会复现。外部工作区原文件不删除。
- 偏好设置写盘成功后才更新缓存，保存失败不再造成内存与磁盘不一致。
- 保持 Step 5 Preview、StepAudio 2.5 Realtime 与 Coder390 llama.cpp Q2 / Q3 默认配置；模型决定工具参数，工具只执行。本次不更换模型权重或本地安装框架。

## English

- Separate first-chunk (300s) and resettable idle (120s) deadlines, with no default total deadline, across compatible endpoints, the built-in Qwen bridge and CLI streams.
- Editable settings and unified timeout diagnostics expose effective values and their sources. Existing environment overrides remain supported; run `Lynn doctor --offline` for the CLI process. Remote proxy/provider limits remain separate.
- Complete short answers no longer trigger punctuation-based continuation. Only explicit truncation or reasoning-only empty output receives one recovery attempt; timeouts remain visible failures.
- Confirmed session deletion and archived-session clearing cancel in-flight work, remove session files and prevent late writes from recreating deleted conversations. External workspace originals are preserved.
- Preference caches update only after successful atomic persistence.
- Step 5, realtime voice and Coder390 Q2/Q3 defaults are unchanged.

## 仓库 / Repositories

- [GitHub 主仓](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.87.2)
- [GitHub 备份仓](https://github.com/LynnMerkyor/Lynn/releases/tag/v0.87.2)
- [Gitee](https://gitee.com/merkyor/Lynn/releases/tag/v0.87.2)
