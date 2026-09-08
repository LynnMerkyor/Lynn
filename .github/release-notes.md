## 国内镜像站下载（推荐） / Downloads

国内用户请优先使用镜像站；GitHub Assets 作为备用下载。

```bash
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.86.8.tgz"
Lynn --version
```

- [macOS Apple Silicon / ARM64](https://download.merkyorlynn.com/downloads/Lynn-0.86.8-macOS-arm64.dmg)
- [macOS Intel / x64](https://download.merkyorlynn.com/downloads/Lynn-0.86.8-macOS-x64.dmg)
- [Windows x64](https://download.merkyorlynn.com/downloads/Lynn-0.86.8-Windows-Setup.exe)
- [国内下载页](https://download.merkyorlynn.com/download.html)

# Lynn v0.86.8 Release Notes / 发布说明

2026-09-08 · Kimi 数据源、历史搜索与手机续聊

## 中文重点

- **Kimi Datasource**：设置 → MCP 中扫码登录，授权成功后自动启用数据源。凭据保存在本机 Lynn 数据目录；用户使用自己的 Kimi 账号，也可在高级选项中导入已有官方插件。
- **MCP OAuth**：支持服务元数据发现、PKCE 登录、授权状态、刷新和取消，HTTP/SSE 连接共用授权；需要 Client ID 的服务可自行填写。
- **历史正文搜索**：侧栏搜索同时匹配会话标题及用户/助手消息正文，显示命中片段；大文件或部分读取会明确提示。
- **轻量自动化**：自动化任务可选择提醒或指定插件动作，并记录执行结果；任务失败会显示错误。
- **会话文件**：桌面、桥接和手机共用会话文件标识；发送附件时绑定到实际会话，历史文件可继续下载。
- **手机续聊**：设置 → 界面中按需开启，通过限时二维码配对后查看和继续已有会话，支持附件与停止生成；设备可单独撤销。工具审批仍在桌面端完成。
- **可选树影**：界面设置新增树影质感开关，默认关闭。
- 手机 PWA 安装需要 HTTPS（localhost 除外）；普通局域网 HTTP 可用于浏览器续聊。Windows 继续提供未签名 x64 NSIS 安装包。

Kimi 登录需要用户自行完成扫码，数据源可用范围由账号与服务决定。开发验证覆盖官方设备授权入口、MCP 协议及隔离环境中的手机页面；不将模拟流程作为真实账号授权或 iOS/Android 安装验证。

## English highlights

- Add Kimi Datasource under Settings → MCP. Scan to sign in with your own account; successful authorization enables the data source. Credentials stay in Lynn's local data directory. Advanced setup can import an existing official plugin.
- Support MCP OAuth discovery, PKCE, authorization status, refresh and cancellation across HTTP/SSE transports, with an optional service-specific Client ID.
- Search conversation titles and user/assistant message bodies in the sidebar, with snippets and explicit partial-result indicators.
- Run lightweight reminders or a selected plugin action from automations, with execution history and visible errors.
- Share session file identifiers across desktop, bridges and mobile; bind attachments to the actual conversation when sending and retain historical downloads.
- Opt in to mobile continuation under Settings → Interface. Pair using an expiring QR code, continue existing conversations, attach files and stop generation. Revoke devices individually; tool approvals remain on desktop.
- Offer an optional tree-shadow texture, disabled by default.
- Installing the mobile PWA requires HTTPS except on localhost; ordinary LAN HTTP supports browser continuation. Windows retains its unsigned x64 NSIS installer.

Users complete Kimi authorization themselves, and account/service access determines available data. Development checks cover the official device authorization endpoint, MCP protocol and isolated mobile flows; simulated checks do not establish real-account authorization or installation on physical iOS/Android devices.

## Repositories

- [GitHub · LynnMerkyor/Lynn](https://github.com/LynnMerkyor/Lynn/releases/tag/v0.86.8)
- [GitHub · MerkyorLynn/Lynn](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.86.8)
- [Gitee · merkyor/Lynn](https://gitee.com/merkyor/Lynn/releases/tag/v0.86.8)
