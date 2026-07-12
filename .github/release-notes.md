# Lynn v0.86.1 Release Notes / 发布说明

> 发布日期: 2026-07-12 · GUI/CLI 交互、本地模型下载与发布门禁更新

## 国内镜像站下载（推荐）

国内用户请优先使用镜像站地址；GitHub Assets 仅作为备用下载。两个 GitHub 仓库与 Gitee Release 保留相同版本记录。

- **GitHub Releases**: https://github.com/MerkyorLynn/Lynn/releases/tag/v0.86.1
- **GitHub Releases（镜像仓）**: https://github.com/LynnMerkyor/Lynn/releases/tag/v0.86.1
- **Gitee Releases**: https://gitee.com/merkyor/Lynn/releases/tag/v0.86.1
- **下载页**: https://download.merkyorlynn.com/download.html

```bash
# Node.js 20 LTS or 22 LTS with npm.
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.86.1.tgz"
Lynn
```

- **macOS Apple Silicon / ARM64**: https://download.merkyorlynn.com/downloads/Lynn-0.86.1-macOS-arm64.dmg
- **macOS Intel / x64**: https://download.merkyorlynn.com/downloads/Lynn-0.86.1-macOS-x64.dmg
- **Windows x64**: https://download.merkyorlynn.com/downloads/Lynn-0.86.1-Windows-Setup.exe

## 中文重点

- **CLI 中断符合直觉**:忙碌时 Ctrl+C 取消当前回答而不退出，空闲时才退出；真实 Ink PTY 门禁覆盖取消、继续提问、粘贴和正常退出。
- **终端历史与输入更稳定**:已完成内容进入稳定历史，流式 Markdown 批量刷新，工具开始与结果更新同一行，输入光标支持左右移动、Home、End、Delete 和退格。
- **本地 27B 下载可控**:默认 Qwen3.6-27B Coding Q4 imatrix MTP 支持分片续传、暂停、继续、取消和删除，并展示总进度、速度与剩余时间。
- **GUI 找内容更直接**:会话搜索常驻，长对话提供回到底部按钮，低频输入工具收进“更多”，停止回答与错误原因使用用户可理解的状态文案。
- **异构复核只在必要时升级**:DS V4 Flash 先异步快审；医疗、法律、金融或时效事实回答只有在一审发现疑点时，才限时调用一次 MiMo 2.5 Pro Token Plan 仲裁。超时保留 DS V4 结论，不阻塞原回答、不自动重答、不进入普通模型降级链。
- **推荐不再打扰低配设备**:不满足条件的设备不会主动弹出端侧模型引导；合适设备可稍后七天或永久关闭推荐。
- **安全基线保持不变**:V0.86 的浏览器权限、IPC/SSRF、OS 沙箱、本地服务鉴权、per-session 准入、工具取消和跨轮隔离继续生效。
- **发布门禁扩大**:根仓、Brain、Agent regression、CLI100、GUI100、真实安装、完整 Ink PTY、语音、架构循环与生产 Brain 漂移均为硬门槛。

## English highlights

- Ctrl+C cancels an active Ink turn without killing the REPL; idle Ctrl+C exits normally.
- Settled terminal history is stable, stream updates are batched, tool rows update in place, and the input cursor is fully movable.
- The default Qwen3.6-27B Coding Q4 imatrix MTP download supports segmented resume, pause, cancel, delete, aggregate progress, speed, and ETA.
- Session search, long-chat navigation, composer organization, stop feedback, and human-readable errors improve desktop usability.
- DS V4 performs fast asynchronous review; only high-stakes or current-fact concerns escalate once to time-bounded MiMo 2.5 Pro arbitration. Arbitration never blocks or rewrites the original answer.
- The V0.86 browser, IPC/SSRF, sandbox, local-server, session-admission, cancellation, and cross-turn isolation baseline remains enabled.
