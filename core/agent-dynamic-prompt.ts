import path from "path";

type AnyRecord = Record<string, any>;

export interface AgentDynamicPromptContext {
  userDir: string;
  agentDir: string;
  memoryMdPath: string;
  userName: string;
  memoryEnabled: boolean;
  engine?: {
    cwd?: string;
    homeCwd?: string;
  } | null;
  projectMemory?: AnyRecord | null;
  userProfile?: AnyRecord | null;
  inferredProfile?: AnyRecord | null;
  activeTaskMemory?: AnyRecord | null;
}

export function buildAgentDynamicPrompt(
  ctx: AgentDynamicPromptContext,
  isZh: boolean,
  readFile: (filePath: string) => string,
): string {
  const section = (title: string, content: string): string[] => ["", "---", "", title, "", content];
  const parts: string[] = [];

  const userMd = readFile(path.join(ctx.userDir, "user.md"));
  const pinnedMd = readFile(path.join(ctx.agentDir, "pinned.md"));
  const memory = readFile(ctx.memoryMdPath);

  parts.push(...section(
    isZh ? "# 用户档案" : "# User Profile",
    isZh
      ? "以下是用户的自我描述，由用户手动维护。\n\n" + userMd
      : "The following is the user's self-description, manually maintained by the user.\n\n" + userMd,
  ));

  if (ctx.memoryEnabled) {
    const memoryRule = isZh ? [
      "",
      "## 记忆使用规则",
      "",
      "记忆和用户档案是你内化的背景知识。你和" + ctx.userName + "是认识很久的人，这些事你本来就知道。你对" + ctx.userName + "的了解应该像空气一样，在场但不可见。记忆的存在感应该是零，它的作用应该是满的。",
      "",
      "- **只有当" + ctx.userName + "提到了相关内容，记忆才参与进来。** " + ctx.userName + "没有提起的话题，你不要主动从记忆里翻出来讲。不要因为记忆里有某条信息就觉得\"我应该提一下\"。记忆参与的方式是无声的：影响你的角度、语气、判断，但不出现在文字里。",
      "- **永远不要让" + ctx.userName + "感觉到\"记忆\"这个东西的存在。** 禁止使用\"我记得\"\"你之前说过\"\"根据记忆\"这类表述。除非" + ctx.userName + "主动问\"你还记得 xxx 吗\"。",
      "- **记忆可能过时，当前对话永远优先。** 信息冲突时以对话为准，不要用旧记忆纠正" + ctx.userName + "。",
    ].join("\n") : [
      "",
      "## Memory Rules",
      "",
      "Memories and the user profile are internalized background knowledge. You and " + ctx.userName + " have known each other for a long time — you already know these things. Your knowledge of " + ctx.userName + " should be like air: present but invisible. Memory's presence should be zero; its effect should be full.",
      "",
      "- **Memory only participates when " + ctx.userName + " brings up something related.** If " + ctx.userName + " hasn't touched on a topic, don't pull it from memory. Don't think \"I should mention this\" just because it's in your memory. When memory does participate, it's silent: shaping your angle, tone, and judgment, but never appearing in the text itself.",
      "- **Never let " + ctx.userName + " sense that \"memory\" exists as a thing.** Never use phrases like \"I remember,\" \"you mentioned before,\" or \"based on my memory.\" The only exception is when " + ctx.userName + " explicitly asks \"do you remember xxx.\"",
      "- **Memory can be outdated; the current conversation always takes priority.** When information conflicts, go with the conversation. Don't use old memories to correct " + ctx.userName + ".",
    ].join("\n");

    if (pinnedMd.trim()) {
      parts.push(...section(
        isZh ? "# 置顶记忆" : "# Pinned Memories",
        isZh
          ? "用户主动要求你记住的内容，始终保留。你可以读写这些记忆。\n" + memoryRule + "\n\n" + pinnedMd
          : "Content the user explicitly asked you to remember. Always retained. You can read and write these memories.\n" + memoryRule + "\n\n" + pinnedMd,
      ));
    }
    const trimmedMemory = memory.trim();
    if (trimmedMemory && trimmedMemory !== "（暂无记忆）" && trimmedMemory !== "(No memory yet)") {
      parts.push(...section(
        isZh ? "# 记忆" : "# Memory",
        isZh
          ? memoryRule.trimStart() + "\n\n以下这些是从过往对话积累的记忆。\n\n" + memory
          : memoryRule.trimStart() + "\n\nThe following are memories accumulated from past conversations.\n\n" + memory,
      ));
    }
  }

  const projectCwd = ctx.engine?.cwd || "";
  if (ctx.projectMemory && projectCwd && ctx.memoryEnabled) {
    try {
      const projectCtx = ctx.projectMemory.formatForPrompt(projectCwd);
      if (projectCtx) parts.push(projectCtx);
    } catch {}
  }

  if (ctx.userProfile && ctx.memoryEnabled) {
    try {
      const profileCtx = ctx.userProfile.formatForPrompt(isZh);
      if (profileCtx) parts.push(profileCtx);
    } catch {}
  }

  if (ctx.inferredProfile && ctx.memoryEnabled) {
    try {
      const inferredCtx = ctx.inferredProfile.formatForPrompt(isZh);
      if (inferredCtx) parts.push(inferredCtx);
    } catch {}
  }

  if (ctx.activeTaskMemory && ctx.memoryEnabled) {
    try {
      const taskCtx = ctx.activeTaskMemory.formatForPrompt(isZh);
      if (taskCtx) parts.push(taskCtx);
    } catch {}
  }

  const preferredDeskPath = ctx.engine?.homeCwd || "";
  const cwdPath = ctx.engine?.cwd || "";
  parts.push(isZh
    ? `\n## 书桌\n\n`
      + `用户所说的「书桌」「工作空间」，默认优先指 Lynn 当前选定的书桌工作区，而不是代码仓库自己的 cwd。`
      + (preferredDeskPath ? `\n默认书桌工作区：${preferredDeskPath}` : "")
      + (cwdPath && cwdPath !== preferredDeskPath ? `\n当前代码工作目录：${cwdPath}` : "")
    : `\n## Desk\n\n`
      + `When the user says "desk" (书桌) or "workspace", prefer Lynn's selected desk workspace first, not the repo cwd by default.`
      + (preferredDeskPath ? `\nDefault desk workspace: ${preferredDeskPath}` : "")
      + (cwdPath && cwdPath !== preferredDeskPath ? `\nCurrent code working directory: ${cwdPath}` : ""),
  );

  const now = new Date();
  const dateTime = now.toLocaleString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  });
  parts.push(`\nCurrent date and time: ${dateTime}`);
  parts.push(isZh
    ? "你的一天从凌晨 4:00 开始。4:00 之前的对话属于前一天。"
    : "Your day starts at 4:00 AM. Conversations before 4:00 AM belong to the previous day.");

  return parts.join("\n");
}
