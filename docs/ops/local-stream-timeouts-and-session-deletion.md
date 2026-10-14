# V0.87.2 长推理超时与会话删除

## 模型请求超时

设置 → 模型服务 → 模型请求超时，单位为秒：

- 首段等待默认 **600 秒（10 分钟）**：从发起请求到收到首个非空流数据块，包含连接等待；仅收到 HTTP 响应头不会结束首段计时。
- 流式空闲默认 **600 秒（10 分钟）**：首段之后，每个非空数据块都会重置空闲计时，包括推理、正文、工具参数、SSE 心跳以及尚未拼成完整 SSE 帧的片段。持续输出可以超过 10 分钟，只有连续 10 分钟没有数据才触发空闲超时。
- 总时限默认 **0（不限制）**：持续产生数据的本地模型不再因运行超过 45 秒而中断。设置正数可重新启用总时限。
- GUI 服务器外层原有的默认 120 秒 turn 硬截止也已默认关闭，防止内层流继续、外层先中断；显式 `LYNN_TURN_HARD_ABORT_MS` 运维覆盖仍保留。
- 配置保存到 `$LYNN_HOME/user/preferences.json` 的 `model_call_timeouts`；未设置 `LYNN_HOME` 时使用 `~/.lynn`。保存后从下一次模型请求生效，不改变进行中请求的计时。
- GUI 原生 OpenAI 兼容会话、内置 Qwen 专用桥接（含预取合成与重试）和 CLI Brain/BYOK 流传输共用此策略。CLI 自定义数据目录不改变这个用户级偏好路径。
- 模型流请求关闭底层 HTTP 客户端默认的固定响应头/响应体等待限制，避免五分钟静默时先于上述十分钟策略断开；请求仍继承原连接池/代理，并受应用层计时和用户取消控制。连接失败、远端代理限制、语音文件转写自身的时限不属于模型流总时限。

环境变量单位为毫秒，优先于界面配置：

| 变量 | 含义 |
| --- | --- |
| `LYNN_MODEL_FIRST_CHUNK_TIMEOUT_MS` | 首段等待，必须大于 0 |
| `LYNN_MODEL_IDLE_TIMEOUT_MS` | 流式空闲，必须大于 0 |
| `LYNN_MODEL_TOTAL_TIMEOUT_MS` | 总时限；0 表示关闭 |
| `LYNN_MODEL_CALL_TIMEOUT_MS` | 旧总时限变量，仍兼容；新 TOTAL 变量优先 |
| `LYNN_BRAIN_MODEL_CALL_TIMEOUT_MS` | Brain 总时限，优先于上述总时限变量 |

只接受合法整数，最大 2147483647 毫秒，防止 Node 定时器溢出后被当成 1 毫秒。界面显示普通请求和 Brain 的实际生效值。超时报错区分首段、空闲、总时限并提示对应设置/变量。已输出的完整片段会保留，但不会隐藏其超时提示。

边界：这是客户端流传输策略，不会取消服务商、反向代理或工具自身的超时。CLI 现有 Brain 快速连接/回退用 `LYNN_CLI_BRAIN_TIMEOUT_MS`，仅覆盖连接/响应头阶段；GUI 内部失败后的收尾请求仍有独立 `LYNN_FALLBACK_MODEL_CALL_TIMEOUT_MS` 预算。语音与工具自身预算不受这三个模型超时设置控制。内置 Qwen 桥接的 150/60/45 秒隐式总预算已移除；超时显示原始诊断，不再吞掉错误或自动转云端。

## 删除与归档

- 普通会话右键或“⋯”菜单 → 删除 → 二次确认。
- 侧边栏“已归档对话”支持单条删除与“清空归档”，没有活动会话时入口仍可见。
- 清空仅删除确认时列出的归档路径；随后新增的归档、活动会话不在本次删除范围。
- 后端先关闭会话写盘、停止正在运行的请求、清除排队提示与内存会话，再删除 `.jsonl`、对应元数据/索引和专属附件副本。
- 同时取消服务器独立 turn 流、兜底定时器和待确认编辑快照；删除后的迟到流事件/旧路径提示不会重启会话。删除失败则解除旧路径禁入，保留磁盘上的原会话供重试。
- 删除无法撤销；工作区原文件、作为外部文件引用的附件原件不删除。不声称这是文件系统级安全擦除，也不删除独立备份或已生成的记忆。
- 删除接口拒绝越界路径、非会话路径、符号链接跳转；清理接口保留旧的按归档年龄清理方式，并返回逐项失败，而非把失败计为成功。

接口：`GET /api/preferences/model-timeouts`、`PUT /api/preferences/model-timeouts`、`POST /api/sessions/delete`、`GET /api/sessions/archived`、`POST /api/sessions/cleanup`（可传确认后的 `paths` 数组）。

## 回归与验收

2026-10-14 修复前基线验证：447 个测试文件通过、1 个文件跳过；3682 项测试通过、3 项跳过。跳过项为未开启的真实 Codex 外部集成（2 项）和长时语音外部测试（1 项），不记为通过。GUI、运行时、CLI 三套类型检查通过；GUI renderer、CLI bundle、server Vite 源码构建通过，`git diff --check` 通过。

V0.87.2 新增验收：普通端点与内置 Qwen 直连均通过真实 HTTP 310 秒持续推理测试，末句使用 `Slow stream completed.`，各自只请求一次。证据：`output/release-v0.87.2/slow-stream.log`。完整发布门禁单独保存，不以基线结果冒充新版本全部通过。

最后整组日志：`/tmp/lynn-complete-regression.log`；长流日志：`/tmp/lynn-slow-stream-final.log`；服务器构建日志：`/tmp/lynn-final-server-build.log`。日志位于本机临时目录，重跑命令如下。此次未启动 Electron 窗口、未替换已安装应用、未下载模型、未提交或发布；版本号仍为 0.87.1。

```sh
npx vitest run tests/agent-runtime-timeout-policy.test.js tests/agent-runtime-stream-deadlines.test.ts tests/agent-runtime-slow-stream.test.ts tests/model-timeout-preferences.test.js tests/session-deletion.test.js cli/tests/model-timeouts.test.ts desktop/src/react/components/ArchivedSessions.test.tsx desktop/src/react/components/SessionList.delete.test.tsx desktop/src/react/settings/tabs/ModelTimeoutSettings.test.tsx
LYNN_TEST_LONG_STREAM=1 npx vitest run tests/agent-runtime-slow-stream.test.ts
npm run typecheck
npm run typecheck:runtime
npx tsc -p cli/tsconfig.json --noEmit
```

长测试使用本地临时 HTTP 端点，连续输出推理 310 秒后给完整答案，并断言只有一次模型请求。它不下载模型、不访问云推理 API、不启动 GUI。短版网络测试覆盖响应头后无首段、正文中断、工具参数碎片/心跳、显式总时限和收到 `[DONE]` 后释放连接。删除测试使用临时目录并新建读取器模拟重启，验证文件/列表均消失、外部原件保留、迟到写盘不能重建会话。

`tests/chat-route-events.test.js` 另外以模拟时钟验证服务器路由持续思考 310 秒不触发外层强制结束，并验证显式运维截止、删除接口与独立流取消的组合。真实 HTTP 长测试与模拟时钟路由测试是两项不同证据，不等同于启动完整 Electron 客户端后的端到端测试。

V0.87.1 基线首次长测试曾因短英文答案触发额外续写；V0.87.2 改用服务端 finish_reason 判定，长测试恢复使用原短句 `Slow stream completed.`，两条路径均断言只发一个请求。只在明确 `length` 或有推理但无可见答案时恢复一次；`stop`、未提供原因的正常短答案及内容过滤不凭标点猜测续写。

## 2026-10-14 Issue 检查与后续 review

只读检查两个 GitHub 仓：主仓 `MerkyorLynn/Lynn` 返回 7 个 Issue，全部关闭，最新创建的是 #75（2026-07-02）；备用仓 `LynnMerkyor/Lynn` 返回 5 个 Issue，全部关闭，最新创建的是 #5（2026-07-27）。未发现 V0.87.1 发布后的新 Issue；未创建评论、修改状态或推送代码。

本次相关一致性修复：`core/preferences-manager.ts` 原先在写盘之前更新缓存。通过阻止临时文件写入复现到“接口报错、内存变成 600 秒、磁盘仍为 300 秒”；现改为成功原子重命名之后才更新缓存，并有 API 失败回归测试。

本轮 review 三项已实现，最终门禁证据保存在 `output/release-v0.87.2/`：

1. 内置 Qwen 桥接使用共享首段/空闲监控器，每个原始数据块刷新空闲期限。超时抛出明确错误，不把部分输出当作成功。
2. 续写由结束原因驱动；测试覆盖英文句号、无标点短答案、缺少 finish_reason、明确长度截断和推理后空答案。
3. 设置页的“统一超时诊断”与 CLI `Lynn doctor --offline` 显示模型/Brain/Qwen、CLI 响应头、收尾与回合期限及来源。CLI 快速连接预算仍独立（默认 5 秒，带备用服务时 1.2 秒，环境覆盖限制在 250–30000ms）；GUI 与 CLI 环境可能不同，诊断明确只代表本进程。长研究期限只在外层硬时限开启时适用。

此前 3682 项记录为修复前基线，不代替 V0.87.2 最终门禁。未加载或下载模型权重；HTTP 慢流由本地测试端点产生。远端 Brain、反向代理与服务商自身期限需要在对应服务检查。
