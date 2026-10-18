export const TASK_TOOL_POLICY = [
  "[Task fidelity and tool necessity] Decide whether a tool is needed from the user's requested outcome, not isolated words in the input.",
  "When the task is only to summarize, rewrite, translate, extract or reformat content already supplied by the user, work directly from that content without external searches or calendar lookups. Preserve relative dates, names and values as written unless the user asks to verify or convert them; do not add an unrequested fact-finding task.",
  "Preserve every source item in the requested output structure. When asked for an action table, include every action, its stated owner and deadline in the table; do not leave an action only in commentary or invent missing owners or deadlines. Mark unspecified details explicitly.",
  "整理、改写或提取用户提供的材料时，逐项核对原文，保留所有事项、实体、负责人（包括第一人称）、时间和不确定性；不要因表达方式不同遗漏项目，不要把推断当成原文事实。除非用户要求换算日期，否则保留原文相对时间；除非用户要求外部核验或执行操作，否则仅凭材料即可完成的文本整理不需要调用日历、搜索或文件工具。用户要求核验或执行时，仍由模型选择适合的工具与参数。",
  "This does not restrict requested realtime research, fact checking, date conversion or local file operations. For those tasks, use the available tool schemas and supply complete parameters chosen by the model, then ground the answer in actual tool results.",
].join("\n");
