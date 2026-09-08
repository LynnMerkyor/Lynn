# 六项功能接入与验证 · 2026-09-08

已完成当前工作树的开发与验证。基础版本仍为 0.86.7；没有改版本号、安装应用、提交发布或访问真实 Kimi 账号。树影候选保持独立且默认关闭。

## 功能入口

| 功能 | 使用方式 | 已实现的行为 |
| --- | --- | --- |
| Kimi Datasource | 设置 → MCP → Kimi Datasource → 扫码登录 | 内置官方脚本；官方设备授权完成后由服务端保存凭据并自动启用 MCP，关闭设置页不影响授权完成。无需安装 Kimi CLI。 |
| MCP OAuth | HTTP / SSE 服务编辑器 → OAuth → 保存 → 开始登录 | 授权元数据发现、PKCE S256、随机 state、本机回调、公开客户端注册或自有 Client ID、自动刷新与断开。 |
| 历史正文搜索 | 左侧会话搜索 | 标题/标签搜索保留；同时查询当前可枚举会话的用户和助手正文，显示命中片段并打开对应会话。 |
| 轻量自动化 | 自动任务编辑器 → 执行方式 | 保留 Agent 任务，新增直接提醒与指定插件动作；提醒不调用模型；手动执行也保留记录与桌面通知。 |
| 统一会话文件 | 聊天文件卡片下载；手机会话文件 | 会话与文件使用独立 ID；桌面上传在发送时绑定实际会话并保留持久副本；生成文件与桥接交付复用注册和解析边界。 |
| 手机续聊 PWA | 设置 → 界面 → 手机访问 | 默认关闭；启用后生成单次配对二维码。手机可查看已有会话、续聊、停止执行、上传和下载文件；桌面可撤销设备访问。 |

## Kimi 的账户与来源

- 使用官方公开客户端的设备授权协议，用户自行在 Kimi 完成扫码。凭据保存在应用数据目录的 `user/kimi-datasource/credentials/kimi-code.json`，文件权限为 0600；不会上传到 Brain，也不会改动已有 Kimi Code 登录。
- 令牌过期前刷新，同一账号的并发刷新合并为一次。数据访问仍取决于用户账号、订阅和额度。
- 可展开可选的本机插件入口；仅扫描明确的 `installed.json` 与其登记的官方 Datasource 文件，显示配置后才能启用，沿用该 Kimi Code 安装的本地登录。内置与本机版本使用同一 MCP 名称，选择后覆盖该连接配置。
- 内置官方 Datasource 3.4.0，来源提交：`0527dae16057a2a8ff79d765dbfe979dd714bf96`。
- 官方脚本未经修改，SHA256：`b14dc08f78f2361f8589255339b1e083cda36c5689672b4855258282fa765d2f`。MIT 许可与来源说明随脚本保留。
- [官方插件源码](https://github.com/MoonshotAI/kimi-code/tree/0527dae16057a2a8ff79d765dbfe979dd714bf96/plugins/official/kimi-datasource)、[官方使用说明](https://github.com/MoonshotAI/kimi-code/blob/0527dae16057a2a8ff79d765dbfe979dd714bf96/docs/en/customization/plugins.md)。

## 实际使用边界

- 手机访问需要电脑上的 Lynn 保持运行。局域网 HTTP 可用浏览器访问；安装为 PWA 需要受信任的 HTTPS（localhost 开发环境除外）。需要工具授权时，当前由电脑端确认。手机入口继续已有会话，尚未提供创建新会话或完整桌面设置。
- 可用 `LYNN_MOBILE_CERT`、`LYNN_MOBILE_KEY` 指定证书与私钥提供 HTTPS，或自行配置 HTTPS 反向代理，并在设置中填写不含路径的访问源地址。代理需要保留设置中的 Host；长回复需要相应的代理超时。此任务没有配置公网、证书或代理。
- 手机服务使用独立监听端口和配对凭据，只暴露会话、消息与文件接口，不开放桌面管理 API。配对码单次使用、五分钟过期；设备凭据三十天过期、可随时撤销；服务工作线程只缓存静态页面，不缓存会话或文件响应。
- 正文搜索按需读取 JSONL，单文件上限 50 MB，默认最多返回 50 个命中会话；跳过和截断会提示。不是预建全文索引。图片、工具返回和思考内容不参与搜索。
- 会话下载支持不超过 50 MB 的普通文件；手机上传单文件不超过 10 MB，每条消息最多 9 个附件。目录与更大的桌面附件保留既有本地使用方式。未发送的暂存上传编号在服务重启后需要重新添加；已绑定的会话副本不依赖临时上传目录。
- 插件动作仅执行所选且已启用的插件工具。插件缺失或报错时明确失败，不转交模型代做。执行中的插件能否立即中断取决于插件自身实现。
- 通用 OAuth 面向公开客户端，要求 PKCE S256；不提供机密客户端的 Client Secret 流程。远程元数据与令牌请求校验地址并固定 DNS 解析结果，拒绝内网/保留地址与重定向；显式 localhost 服务可用于本地开发。

## 验证结果

- 16 个相关测试文件、120 项测试通过。覆盖旧任务兼容、提醒/插件执行、手动运行记录、Unicode 搜索及旧请求覆盖、会话文件隔离、持久副本、设备配对/撤销、损坏记录保留、Kimi 授权/刷新、OAuth PKCE/state/刷新与 HTTP/SSE 握手。
- 真实运行内置官方 stdio MCP，成功发现 `call_data_source_tool` 和 `get_data_source_desc`。没有调用真实数据查询。
- 2026-09-08 04:38 UTC 实测官方未登录设备授权入口返回 HTTP 200，包含设备码、用户码、`https://www.kimi.com` 授权源地址及 1,800 秒有效期。证据只保留字段是否存在与状态，不保留码值。没有完成账号授权或验证付费数据权限。
- 在隐藏浏览器的 390 × 844 视口完成测试设备配对，查看原会话、发送新消息并确认仍在同一会话，查看会话文件。普通视口截图与 DOM 尺寸确认没有横向溢出。整页截图存在工具缩放异常，不作为视觉通过证据。未在真实 iOS/Android 设备上验证安装。
- `npm run typecheck`、`npm run typecheck:runtime`、前端架构检查通过；架构检查覆盖 305 个模块，无运行时导入循环。
- 前端构建通过（5.55 秒），服务端 Vite 代码构建通过（2.47 秒）。手机静态页与 Kimi 脚本共 9 个资源文件复制后哈希一致，正式打包脚本已包含它们。
- 使用现有本地依赖完成代码构建；没有运行会下载运行时依赖的完整安装包流程。构建仍有既有大分块与 node:sqlite 外部化提示，未进行安装包签名、安装或发布验证。
- ESLint 新增代码错误已修正。修改文件的检查仍有 49 条原有错误：`server/chat/hub-event-artifacts.ts` 17 条，`server/index.ts` 32 条，与 HEAD 基线逐文件对照一致。全量 lint 因此不能宣称通过。
- `git diff --check` 通过。没有操作其他工作树、个人账号或模型服务器。临时手机测试服务已停止，测试视口已恢复。

## 证据

本地证据目录：`output/functional-integration-20260908/`（构建输出，不进入 Git）。

- `regression.log`、`final-boundaries.log`
- `renderer-typecheck.log`、`runtime-typecheck.log`、`architecture.log`
- `renderer-build.log`、`server-build.log`、`resources.json`
- `lint.json` 与 `lint-baseline-*.json`
- `kimi-public-device-endpoint.json`
- `mobile-390-viewport.png`、`mobile-ui-state.txt`

OpenHanako 参考版本：`1d3ef308299e9f630786384e77de45444ea59196`。具体实现沿用 Lynn 当前会话、自动化和 MCP 架构；没有替换运行内核。
