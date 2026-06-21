# PLAN — 聊天 UI/UX 清理(Codex 施工 spec)

> 状态:待施工 · 来源:用户截图 UI/UX 复核(2026-06-19)· 执行:Codex
> ⚠️ 截图疑似旧构建(badge 已是 "GLM 5.0 Turbo" 正确大小写,截图为小写)→ **每条先在当前代码 + 新构建复现,已修的跳过**。
> 关键文件:`desktop/src/react/components/chat/{AssistantMessage.tsx,AssistantMessage.helpers.ts,ThinkingBlock.tsx,UserMessage.tsx}` · 输入区 `desktop/src/react/components/input/*` · i18n `desktop/src/react/utils/ui-i18n.ts`

---

## P0 — 空答兜底(功能,最高优先)
**问题**:助手"思考完成(1.3k 字)"下方**无答案正文**(截图),用户看到思考框 + 操作按钮 + 一片空白。
**根因**:思考产出但可见 text block 为 0(空答类,本会话服务端 `server/chat/hub-event-forwarder.ts` turn_end catch-all 已加兜底文,但 UI 仍可能渲染空态)。
**文件**:`AssistantMessage.tsx`(渲染分支)+ `AssistantMessage.helpers.ts`(`extractPlainTextFromBlocks` 已有)。
**改法**:
1. UI 守卫:当 `turn 已结束 && 思考存在 && 可见 text block 为 0 && 无运行中工具` → **不得只显示思考框**,渲染一行兜底(如灰字"本轮未生成可见回答,请点重做")或服务端 `realtimeToolFallbackText`。
2. 校验服务端兜底文是否真到达前端(`ws-message-handler.ts`);若到了就直接渲染它,别让 UI 吞掉。
**验收**:构造一次空答(或回放),UI **永不**出现"思考完成 + 空白",必有可见文字或明确重试提示。

## P1 — 模型路由徽章(你指的"右侧奇怪 UI")
**问题**:`↳ DeepSeek -> glm 5 turbo +2` 橙色徽章:① 泄露内部路由链;② `+2` 无人看懂(=隐藏的中间跳数);③ 橙色像报错;④ 与"默认工作模型"chip 信息重复。
**文件**:`AssistantMessage.helpers.ts:102-129`(`providerRouteLabel` 拼链 + `providerRouteTitle`)+ `AssistantMessage.tsx`(渲染 `↳`/`+N`/橙色样式)。
**改法**:
1. **默认收起**:正常不显示路由链;仅当用户 hover/点小 ⓘ 图标才展开 `providerRouteTitle`(完整链路+原因留作高级信息)。
2. 默认只显示**最终模型**一行人话:`由 GLM 5.0 Turbo 作答`(去掉 `↳`、`-> `、`+N`)。
3. **去掉 `+2`**(或在 title 里写清"已跳过 N 个备用");徽章主体不出现裸 `+N`。
4. **改色**:正常路由用中性灰/蓝,不用橙(橙保留给真错误)。
5. `providerRouteLabel` 的 `chain.length>2` 分支(`first -> last`)是 `+N` 的来源,配合上面改。
**验收**:默认状态助手旁**看不到内部链路**,只一个干净的"由 X 作答";hover 才见完整链路;无裸 `+N`;非错误不橙。

## P2 — 模型信息去重(3 处 → 1~2 处)
**问题**:`默认工作模型`(助手旁 chip)+ 路由徽章 + 底部 `默认工作模型 ▾` 下拉,三处讲同一件事。
**文件**:`AssistantMessage.tsx`(chip)+ 输入区底部下拉(`components/input/SubmitArea.tsx` 附近)。
**改法**:**底部下拉 = 选择模型**(保留);**消息旁 = 实际作答模型**(P1 改后的人话行,保留);**删掉**冗余的"默认工作模型"灰 chip(它没增量信息)。
**验收**:同一信息不再三地重复。

## P3 — 思考框 + 布局留白
**文件**:`ThinkingBlock.tsx`。
**改法**:
1. "思考完成 (1.3k 字)":**字数对用户无意义** → 改成耗时(如"思考 4s")或更弱化;保留可展开。
2. 折叠框**边框过重** → 减轻(去边框/浅背景),别抢答案视觉。
3. 答案为主:思考框默认折叠、视觉权重低于答案。
4. 修助手块顶部聚集 + 下方大留白(P0 修好答案后大半自解;再查 message 容器 min-height/对齐)。
**验收**:答案是视觉主体,思考/留白不喧宾夺主。

## P4 — 操作按钮顺序 + 用户消息侧
**文件**:`AssistantMessage.tsx`(操作行)、`UserMessage.tsx`(粘贴/编辑重发)。
**改法**:
1. 助手操作行(齿轮/复制/朗读/重做)挪到**答案下方**(当前在思考框后、答案前,顺序怪);确认**齿轮**每条消息的语义,不清晰就移除或换图标。
2. 用户消息的 **`粘贴` → `复制`**(自己发的消息"粘贴"无意义);旁边已有复制图标 → **去重**,只留一个。
**验收**:操作在答案之后;用户消息操作语义正确无重复。

## P5 — 输入区瘦身 + 细节
**文件**:`components/input/{SubmitArea.tsx,DeepResearchLauncher.tsx,SecurityModeSelector.tsx}` + composer;头像组件;`ui-i18n.ts`。
**改法**:
1. 底栏控件多(自动/深研/执行模式/铅笔/灯泡/模型/发送)→ **次要项收进"更多"或图标化**,降拥挤。
2. **占位符截断**`…桌面上的 Excel…` → 缩短文案或修容器溢出(`ui-i18n.ts` 占位文案 + composer 宽度)。
3. **发送键**禁用/可用态对比度做清晰。
4. 右上头像 **`00`** → 未设名时给体面默认(首字母/默认头像),别显 `00`。
**验收**:底栏不拥挤;占位符不截断;发送态清晰;无 `00` 占位名。

---

## 施工顺序与纪律
1. **P0 → P1 → P2** 先做(功能 + 你最在意的右侧徽章 + 去重),P3-P5 收尾。
2. 每条**先在当前代码核实是否已修**(截图是旧构建),已修标注跳过。
3. 改完 `npm run typecheck` + `npm run lint desktop/src/` + 相关 vitest;UI 改动**真机新构建**截图自检(对照本 plan 每条验收)。
4. i18n 文案统一走 `ui-i18n.ts`,别散落硬编码。
5. 纯前端改动,**不动** `core/agent-runtime`(刚替换完 Pi SDK,别混入)。
