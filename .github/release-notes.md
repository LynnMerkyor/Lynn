# Lynn v0.86.3 Release Notes / 发布说明

> 发布日期: 2026-08-27 · Agent Loop 稳定性、Codex harness 预检与飞书接口更新

## 国内镜像站下载（推荐）

国内用户请优先使用镜像站地址；GitHub Assets 仅作为备用下载。两个 GitHub 仓库与 Gitee Release 保留相同版本记录。

- **GitHub Releases**: https://github.com/MerkyorLynn/Lynn/releases/tag/v0.86.3
- **GitHub Releases（镜像仓）**: https://github.com/LynnMerkyor/Lynn/releases/tag/v0.86.3
- **Gitee Releases**: https://gitee.com/merkyor/Lynn/releases
- **下载页**: https://download.merkyorlynn.com/download.html

```bash
# Node.js 20 LTS or 22 LTS with npm.
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.86.3.tgz"
Lynn
```

- **macOS Apple Silicon / ARM64**: https://download.merkyorlynn.com/downloads/Lynn-0.86.3-macOS-arm64.dmg
- **macOS Intel / x64**: https://download.merkyorlynn.com/downloads/Lynn-0.86.3-macOS-x64.dmg
- **Windows x64**: https://download.merkyorlynn.com/downloads/Lynn-0.86.3-Windows-Setup.exe

## 中文重点

- **Codex harness 预检更可靠**：`auto` 在可选状态端点不可用时继续使用已认证 Responses 预检；显式 `codex` 同样校验当前 provider/model 路由，不兼容时在任务开始前明确失败。
- **本地模型失败不再污染后续对话**：单轮本地 GGUF 回退到 Brain 只对当前请求生效，不再永久改写会话模型；排队中的下一轮会恢复原本模型。
- **空回答处理更稳**：Brain 对“只有推理、没有可见答案”的 provider 设置短暂冷却并自动换路；Ink TUI 不再把空 assistant 或失配 user 写入历史。
- **多模态云端接班链更新**：StepFun 后依次尝试 GLM Coding Plan `GLM-5.3-Flash`、`deepseek-v4-flash-vision-exp` 和 MiMo 2.5 Pro；GLM 负责主复核，MiMo 负责第二次仲裁，DS Vision Exp 作为更强的多模态兜底。
- **GUI/CLI 状态一致**：完成事件统一携带 `streamSource`，CLI 在普通及 headless 模式显示实际 harness 与选择原因；兜底提示不再虚构不存在的复查流程。
- **飞书接口更新**：飞书 SDK 与桥接层迁移到当前 Channel API，并保留消息收发、重连与兼容回归测试。
- **发布门禁更可复现**：根 Vitest 只扫描 Lynn 正式测试目录，避免同一工作区中的无关项目测试污染发布结果。

## English highlights

- Codex `auto` selection now falls through to the authenticated Responses preflight when the optional status endpoint is unavailable. Explicit `codex` selection also verifies the current provider/model route before the run starts.
- A failed local GGUF request may use Brain for that turn only; it no longer changes the persisted session model, and queued prompts return to the original model.
- Brain temporarily cools down providers that return reasoning without a visible answer. Ink TUI no longer commits empty assistant messages or leaves an unmatched user turn in history.
- The cloud takeover chain now tries GLM Coding Plan `GLM-5.3-Flash`, `deepseek-v4-flash-vision-exp`, and MiMo 2.5 Pro after StepFun. GLM handles primary review, MiMo remains the second-opinion arbitrator, and DS Vision Exp provides a stronger multimodal fallback.
- Completion events consistently expose `streamSource`, and CLI output reports the selected harness and reason in interactive and headless modes.
- The Feishu bridge and SDK are migrated to the current Channel API with message, reconnect, and compatibility regression coverage.
- Root Vitest discovery is restricted to Lynn's maintained test roots so unrelated workspaces cannot contaminate release gates.
