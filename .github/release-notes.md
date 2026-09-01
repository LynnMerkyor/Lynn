# Lynn v0.86.4 Release Notes / 发布说明

> 发布日期: 2026-09-01 · 自动任务 UI、模块边界与渲染按需加载更新

## 国内镜像站下载（推荐）

国内用户请优先使用镜像站地址；GitHub Assets 仅作为备用下载。两个 GitHub 仓库与 Gitee Release 保留相同版本记录。

- **GitHub Releases**: https://github.com/MerkyorLynn/Lynn/releases/tag/v0.86.4
- **GitHub Releases（镜像仓）**: https://github.com/LynnMerkyor/Lynn/releases/tag/v0.86.4
- **Gitee Releases**: https://gitee.com/merkyor/Lynn/releases
- **下载页**: https://download.merkyorlynn.com/download.html

```bash
# Node.js 20 LTS or 22 LTS with npm.
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.86.4.tgz"
Lynn
```

- **macOS Apple Silicon / ARM64**: https://download.merkyorlynn.com/downloads/Lynn-0.86.4-macOS-arm64.dmg
- **macOS Intel / x64**: https://download.merkyorlynn.com/downloads/Lynn-0.86.4-macOS-x64.dmg
- **Windows x64**: https://download.merkyorlynn.com/downloads/Lynn-0.86.4-Windows-Setup.exe

## 中文重点

- **自动任务暗色模式恢复可读**：模板、任务卡、表单控件、状态标签和按钮改用主题语义变量，修复暗色背景上大面积浅底、白字与低对比度内容。
- **Automation 面板完成模块化拆分**：数据读写、草稿状态、模板库和任务编辑器分离，面板组件回到只负责布局与编排，降低后续迭代时的耦合和回归风险。
- **面板样式按职责拆分**：Automation 专属样式迁出通用 Floating Panels 样式表，避免跨面板选择器互相污染。
- **重型渲染器真正按需加载**：Mermaid、Wardley、KaTeX、Markdown 与 sanitize vendor 拆成独立异步块，并新增静态依赖门禁，防止动态导入被其他静态引用悄悄抵消。
- **截图回归门禁覆盖主题和分辨率**：自动任务页面加入亮色/暗色 × 1440×900、1024×768、720×900 六组基线，发布 UI 门禁会直接阻止明显视觉退化。
- **既有 Agent Loop 保持不变**：v0.86.3 的 Codex app-server 自动预检、原 Loop 回退、单轮本地模型接班、空答熔断和跨端终态契约全部保留。

## English highlights

- Automation cards, templates, forms, status pills, and actions now use theme-semantic colors and remain readable in both light and dark modes.
- The Automation surface is separated into data and draft hooks, a template library, and an editor component; panel-specific CSS is no longer mixed into the shared floating-panel stylesheet.
- Mermaid, Wardley, KaTeX, Markdown, and sanitization vendors are emitted as real on-demand chunks, with a dependency gate that catches accidental static reachability from the main bundle.
- Visual regression now covers light/dark themes at 1440×900, 1024×768, and 720×900.
- The v0.86.3 Codex harness preflight, original-loop fallback, one-turn local-model recovery, empty-response cooldown, and cross-client terminal-state contract remain intact.
