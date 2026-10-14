## 国内镜像站下载（推荐） / Downloads

国内用户请优先使用镜像站；GitHub Assets 作为备用下载。

- [macOS Apple Silicon](https://download.merkyorlynn.com/downloads/Lynn-0.87.2-macOS-arm64.dmg)
- [macOS Intel](https://download.merkyorlynn.com/downloads/Lynn-0.87.2-macOS-x64.dmg)
- [Windows x64](https://download.merkyorlynn.com/downloads/Lynn-0.87.2-Windows-Setup.exe)
- [下载说明页](https://download.merkyorlynn.com/download.html)

```bash
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.87.2.tgz"
Lynn --version
```

# Lynn v0.87.2 · 长推理与会话管理修复 / Long reasoning and session management

2026-10-14

## 中文

- 长推理使用首段 600 秒、空闲 600 秒的独立计时；每个流数据块刷新空闲计时，默认不设总时限，持续输出超过十分钟也不会因此中断。普通 OpenAI 兼容端点、内置 Qwen 桥接和 CLI 流传输使用同一策略；已保存的设置和显式环境变量继续优先。
- 设置 → 模型服务可调整超时；统一诊断显示模型、Brain、Qwen、CLI 响应头与回合时限的生效值和来源。保留环境变量覆盖，CLI 可运行 `Lynn doctor --offline`。远端服务或代理限制需另行检查。
- 去除英文短答案的标点/长度续写猜测；仅明确截断或推理后空答案才尝试一次恢复。内置 Qwen 桥接超时不再冒充成功结束，也不无提示切到云端。
- 对话菜单增加二次确认删除，归档列表支持单条删除与批量清空；关闭在途请求和迟到写盘，删除后重启不会复现。外部工作区原文件不删除。
- 偏好设置写盘成功后才更新缓存，保存失败不再造成内存与磁盘不一致。
- GUI 重连回放按会话、流与序号去重，避免实时片段被重复显示；旧流的普通回放不再结束当前流。
- 保持 Step 5 Preview、StepAudio 2.5 Realtime 与 Coder390 llama.cpp Q2 / Q3 默认配置；模型决定工具参数，工具只执行。本次不更换模型权重或本地安装框架。

## English

- Separate first-chunk (600s) and resettable idle (600s) deadlines, with no default total deadline, across compatible endpoints, the built-in Qwen bridge and CLI streams. Continued output can run beyond ten minutes; saved settings and explicit environment overrides remain authoritative.
- Editable settings and unified timeout diagnostics expose effective values and their sources. Existing environment overrides remain supported; run `Lynn doctor --offline` for the CLI process. Remote proxy/provider limits remain separate.
- Complete short answers no longer trigger punctuation-based continuation. Only explicit truncation or reasoning-only empty output receives one recovery attempt; timeouts remain visible failures.
- Confirmed session deletion and archived-session clearing cancel in-flight work, remove session files and prevent late writes from recreating deleted conversations. External workspace originals are preserved.
- Preference caches update only after successful atomic persistence.
- GUI stream replay deduplicates chunks by session, stream and sequence; stale non-reset replays no longer close the current stream.
- Step 5, realtime voice and Coder390 Q2/Q3 defaults are unchanged.

## 仓库 / Repositories

- [GitHub 主仓](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.87.2)
- [GitHub 备份仓](https://github.com/LynnMerkyor/Lynn/releases/tag/v0.87.2)
- [Gitee](https://gitee.com/merkyor/Lynn/releases/tag/v0.87.2)
