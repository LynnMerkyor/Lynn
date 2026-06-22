# PLAN — Lynn GUI/CLI UX 大改(v0.85.1,Claude 接手)

> 日期 2026-06-22 · 用户授权大刀阔斧 + "按你的思路" · 增量推进、每步可复核(不重蹈一次性大改成乱)

## 诊断(基于实读代码,非印象)
核心问题不是缺功能,是 **信息层级崩 + 重复 + 噪音**:
- 左(`SessionList.tsx`)与右(`desk/SessionMapView.tsx`)**读同一份 `state.sessions`**,右侧本应是"工作地图"却用 `<ul>` 渲染成**第二个扁平列表**;600 会话里 580 个无 digest → 全显"未命名会话"(`SessionMapView.tsx:21`)→ 左右看着一样、且被噪音淹没。
- Stello 式 **digest / insight / topology / health 数据层已建好**(在 Session 模型 + 详情面板 `SessionMapView.tsx:289-313` 已渲染)→ **缺的是渲染/降噪/分工,不是数据**。
- CLI 特效**早有且接进聊天**(`terminal-spinner.ts` braille spinner/流光/卡片;`code-agent-loop.ts:731`、`commands/chat.ts:342` 已 start)→ 被 `terminal-safety.ts:20` Apple Terminal 安全门控压住,非缺失。

## 方向
- **左 = "在聊什么"**:只留真在聊的对话(有内容/命名/置顶/IM),噪音折叠。
- **右 = "在做什么"**:真·工作地图——只放有 digest/分支/风险/洞察的工作节点;拓扑(节点大小=体积、色=health、连线=分支来源);digest 卡 + insight inbox。**不再是第二个列表。**
- **CLI**:解门控让现有特效默认显出来 + 打磨"思考中·token·耗时"。
- 每块加一行用途说明,消灭"这块干嘛"的迷茫。

## 增量(每步独立、typecheck+真机截图复核)
- **I1 ✅(本次)右侧降噪 + 分工**:`SessionMapView` 只显工作节点(reason 或 digest),580 空会话折叠;改 placeholder/cluster 文案讲清"这是工作节点不是对话列表"。
- **I2 左侧降噪**:`SessionList` 过滤空 auto-session(无消息/未命名)→ 折叠"归档"。
- **I3 digest 卡**:左侧/右侧 hover/展开显 目标·状态·下一步。
- **I4 insight inbox**:未读洞察独立收件箱 UI(跨 Agent 定向传递)。
- **I5 topology 星图**:右侧从 list 升级为节点图(分支连线 + 体积 + health 色)。
- **I6 CLI 解门控**:让 spinner/流光默认显;Apple Terminal 给安全的精简动画。
- **I7 块用途标签 + 整体留白/层级**。

## 纪律
纯前端;不碰 core/agent-runtime、不碰 server/brain;每个 increment 单独 typecheck + 真机看一眼;改动可回退;不一次性大爆改。
