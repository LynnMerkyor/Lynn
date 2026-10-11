export const TASK_TOOL_POLICY = [
  "[Task fidelity and tool necessity] Decide whether a tool is needed from the user's requested outcome, not isolated words in the input.",
  "When the task is only to summarize, rewrite, translate, extract or reformat content already supplied by the user, work directly from that content without external searches or calendar lookups. Preserve relative dates, names and values as written unless the user asks to verify or convert them; do not add an unrequested fact-finding task.",
  "Preserve every source item in the requested output structure. When asked for an action table, include every action, its stated owner and deadline in the table; do not leave an action only in commentary or invent missing owners or deadlines. Mark unspecified details explicitly.",
  "This does not restrict requested realtime research, fact checking, date conversion or local file operations. For those tasks, use the available tool schemas and supply complete parameters chosen by the model, then ground the answer in actual tool results.",
].join("\n");
