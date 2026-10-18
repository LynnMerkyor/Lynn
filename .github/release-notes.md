# Lynn v0.87.3 · 搜索与交互稳定性更新

2026-10-18

## 下载 / Downloads

- [macOS Apple Silicon](https://download.merkyorlynn.com/downloads/Lynn-0.87.3-macOS-arm64.dmg)
- [macOS Intel](https://download.merkyorlynn.com/downloads/Lynn-0.87.3-macOS-x64.dmg)
- [Windows x64](https://download.merkyorlynn.com/downloads/Lynn-0.87.3-Windows-Setup.exe)
- [下载说明页](https://download.merkyorlynn.com/download.html)

```bash
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.87.3.tgz"
Lynn --version
```

## 中文

- 默认联网搜索优先使用 DeepSeek Search，保留备用搜索源；模型提供完整查询，保留地点、日期及搜索运算符。
- 搜索支持主动停止，取消后不再继续发起备用请求；单个搜索请求及正文读取有独立超时，客户端搜索链最多等待 30 秒。
- 修复搜索设置验证期间切换选项后被旧结果覆盖的问题，避免重复点击造成并发验证。
- 搜索证据去重，保留来源链接、日期和完整有效摘要，减少重复内容占用上下文。
- 修复 CLI 异常退出后会话索引锁残留导致后续对话卡住的问题。
- GUI 与 CLI 同步更新。保持 Step 5 Preview、StepAudio 2.5 Realtime 和 Coder390 llama.cpp Q2 / Q3；延续长推理超时设置与会话删除功能。

## English

- DeepSeek Search is now the preferred web search source, with fallback providers retained and model-supplied locations, dates and search operators preserved.
- Stopping a search cancels active requests without starting additional fallback requests. Request and response-body deadlines operate within a 30-second client search budget.
- Stale search verification results no longer overwrite a newer selection; repeated verification clicks are prevented.
- Search evidence is deduplicated while retaining source links, dates and useful summaries.
- CLI session indexing recovers abandoned locks after an interrupted process instead of blocking subsequent conversations.
- GUI and CLI update together. Step 5 Preview, realtime voice, Coder390 Q2/Q3, long-reasoning controls and conversation deletion remain available.

## 仓库 / Repositories

- [GitHub 主仓](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.87.3)
- [GitHub 备份仓](https://github.com/LynnMerkyor/Lynn/releases/tag/v0.87.3)
- [Gitee](https://gitee.com/merkyor/Lynn/releases/tag/v0.87.3)
