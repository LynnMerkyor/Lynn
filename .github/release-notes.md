## 国内镜像站下载（推荐） / Downloads

国内用户请优先使用镜像站；GitHub Assets 作为备用下载。

```bash
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.87.0.tgz"
Lynn --version
```

- [macOS Apple Silicon / ARM64](https://download.merkyorlynn.com/downloads/Lynn-0.87.0-macOS-arm64.dmg)
- [macOS Intel / x64](https://download.merkyorlynn.com/downloads/Lynn-0.87.0-macOS-x64.dmg)
- [Windows x64](https://download.merkyorlynn.com/downloads/Lynn-0.87.0-Windows-Setup.exe)
- [可选专家圆桌插件](https://download.merkyorlynn.com/downloads/lynn-expert-roundtable-0.87.0.zip)
- [国内下载页](https://download.merkyorlynn.com/download.html)

# Lynn v0.87.0 Release Notes / 发布说明

2026-09-08 · 窗边树影与更简洁的工作界面

2026-09-11 GUI 更新：小叶影收拢至右上角，轻微摇曳，默认开启；悬停左上角“树影”可查看关闭路径。已安装 V0.87 的用户可使用原下载链接重新下载安装。

GUI refresh · September 11: smaller leaves sway gently in the upper-right corner, enabled by default, with the same hover guide to their settings. Existing V0.87 users can reinstall from the same download links.

## 中文重点

- **Lynn 窗边树影**：约 16 片小叶影集中在右上角四分之一区域，轻微摇曳，默认开启。悬停顶部“树影”查看关闭路径，点击直达设置；后台暂停，减少动态效果时静止，深色和高对比主题停用。
- **输入栏精简**：移除常驻任务模式，小说、长文、社媒、代码、商务、翻译、研究和笔记改为可编辑的斜杠模板。保留深度调研、写作布局与执行权限选择。
- **编辑会话隔离**：编辑历史消息后切换或新建对话，会清空旧消息的编辑目标，避免下一条消息被错误当成历史重发。
- **停止及时生效**：检索预处理和本地模型直连都支持取消，停止后的迟到结果不会继续生成回答；结束后清除停止提示。
- **文件与图片统一**：文件面板增加“全部 / 图片”筛选，保留文件夹入口、旧 gallery 文件与图片生成。
- **翻译收进菜单**：在回复的“更多消息操作”中选择目标语言，译文仍显示在原回复下方。
- **本地模型提示减负**：聊天不再主动弹出安装推荐；设置中的模型安装和已选择本地模型的运行状态继续保留。
- **专家按需安装**：六组专业顾问与圆桌入口移为独立的 `lynn-expert-roundtable-0.87.0.zip` 插件。已创建的角色、头像、频道和历史保留。安装方法见插件内 README。
- **直接表达与按需复查**：不再要求新回答输出固定 MOOD / PULSE / REFLECT / XING 区块，旧消息兼容显示；普通搜索和轻量编辑不再仅因调用工具触发复查，失败、报告交付、高风险与时效性结果继续复查，手动复查保留。
- Kimi MCP 扫码登录、历史搜索、会话文件、轻量自动化与手机续聊继续提供。
- Windows 继续提供未签名 x64 NSIS 安装包。

## English highlights

- About 16 small leaf shadows sway gently within the upper-right quarter, enabled by default. Hover over Shadows for the off switch location, or click it to open Settings → Interface; animation pauses in the background and stays still with reduced motion. Dark and high-contrast themes disable the effect.
- Replace persistent task modes with explicit, editable slash templates. Keep deep research, writing layout and security controls.
- Clear pending history-edit targets when switching or starting conversations so new messages cannot accidentally edit an old session.
- Cancel pending research and direct local-model requests promptly; ignore late research results and clear the stopping notice when the turn ends.
- Merge images into the file panel's All / Images filter; retain folders, existing gallery files and image generation.
- Move translation to each reply's More menu, retaining language selection and the translation below the reply.
- Remove proactive local-model installation prompts from chat; keep installation in model settings and status for selected local models.
- Offer six professional advisors and roundtables as an optional plugin ZIP. Existing agents, avatars, channels and history remain available.
- Use direct prose instead of newly generated mood/reflection protocol blocks, while retaining historical rendering. Narrow automatic review for routine searches and edits; retain failed-tool, report-delivery, high-stakes, time-sensitive and manual reviews.
- Preserve Kimi MCP authorization, conversation search, session files, lightweight automations and mobile continuation. Windows retains its unsigned x64 NSIS installer.

## Repositories

- [GitHub · LynnMerkyor/Lynn](https://github.com/LynnMerkyor/Lynn/releases/tag/v0.87.0)
- [GitHub · MerkyorLynn/Lynn](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.87.0)
- [Gitee · merkyor/Lynn](https://gitee.com/merkyor/Lynn/releases/tag/v0.87.0)
