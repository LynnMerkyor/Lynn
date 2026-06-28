import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildLocalWorkspaceDirectReply,
  buildLocalWorkspaceContext,
  shouldAttachLocalWorkspaceContext,
  shouldUseLocalWorkspaceDirectReply,
} from "../server/chat/local-workspace-context.js";

describe("local workspace context", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-workspace-context-"));
    fs.writeFileSync(path.join(tmpDir, "jian.md"), "# 今日笺\n\n- [ ] 修复默认模型读取工作区\n", "utf8");
    fs.writeFileSync(path.join(tmpDir, "report.md"), "# 报告\n\n真实内容\n", "utf8");
    fs.writeFileSync(path.join(tmpDir, "第一章-钢铁长城.md"), "# 第一章\n\n暗号：桐门已亮。\n", "utf8");
    fs.mkdirSync(path.join(tmpDir, "docs"));
    fs.writeFileSync(path.join(tmpDir, "docs", "note.txt"), "nested note", "utf8");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("only attaches for local workspace utility requests", () => {
    expect(shouldAttachLocalWorkspaceContext("读一下桌面Lynn文件夹", "utility")).toBe(true);
    expect(shouldAttachLocalWorkspaceContext("读一下这个项目/Users/lynn/DEV/Lynn", "utility")).toBe(true);
    expect(shouldAttachLocalWorkspaceContext("请先看看当前工作空间和笺", "utility")).toBe(true);
    expect(shouldAttachLocalWorkspaceContext("请把下载文件夹的所有后缀 zip 文件都删除", "utility")).toBe(true);
    expect(shouldAttachLocalWorkspaceContext("你能找到本地第一章小说吗", "utility")).toBe(true);
    expect(shouldAttachLocalWorkspaceContext("今天深圳天气如何", "utility")).toBe(false);
    expect(shouldAttachLocalWorkspaceContext("随便聊两句", "chat")).toBe(false);
  });

  it("uses direct local workspace replies only for read-only local file requests", () => {
    expect(shouldUseLocalWorkspaceDirectReply("请阅读本地第一章小说", "utility")).toBe(true);
    expect(shouldUseLocalWorkspaceDirectReply("请查找这个本地目录里的文件", "utility")).toBe(true);
    expect(shouldUseLocalWorkspaceDirectReply("为什么我无法直接读取本地文件路径（file:// 协议被阻止）", "utility")).toBe(false);
    expect(shouldUseLocalWorkspaceDirectReply("请删除下载文件夹里的旧文件", "utility")).toBe(false);
    expect(shouldUseLocalWorkspaceDirectReply("帮我分析桌面上的 Excel", "utility")).toBe(false);
    expect(shouldUseLocalWorkspaceDirectReply("随便聊两句", "chat")).toBe(false);
  });

  it("does not attach workspace snapshots to internal automation prompts", () => {
    const prompt = [
      "[目录巡检] /Users/lynn/Desktop/Lynn",
      "注意：这是系统自动触发的目录巡检，不是用户发来的消息。",
      "## 笺",
      "# 今天的计划",
    ].join("\n");

    expect(shouldAttachLocalWorkspaceContext(prompt, "utility")).toBe(false);
  });

  it("does not treat browser file protocol explanations as local file read tasks", () => {
    const prompt = "为什么我无法直接读取本地文件路径（file:// 协议被阻止）";

    expect(shouldAttachLocalWorkspaceContext(prompt, "utility")).toBe(false);
    expect(shouldUseLocalWorkspaceDirectReply(prompt, "utility")).toBe(false);
  });

  it("builds a real local snapshot with directory and note previews", () => {
    const context = buildLocalWorkspaceContext({
      promptText: "请先看看当前工作空间和笺",
      cwd: tmpDir,
      now: new Date("2026-04-11T04:00:00Z"),
    });

    expect(context).toContain("Lynn 本地工作区快照");
    expect(context).toContain(`工作区路径：${tmpDir}`);
    expect(context).toContain("[file] jian.md");
    expect(context).toContain("[dir] docs");
    expect(context).toContain("# 今日笺");
    expect(context).toContain("读取状态：成功");
    expect(context).not.toContain("不要说“没有文件系统权限”");
  });

  it("builds a direct user-facing reply for local folder reads", () => {
    const result = buildLocalWorkspaceDirectReply({
      promptText: "读一下桌面Lynn文件夹",
      cwd: tmpDir,
      now: new Date("2026-04-11T04:00:00Z"),
    });

    expect(result.ok).toBe(true);
    expect(result.text).toContain("我已读取");
    expect(result.text).toContain("[文件] jian.md");
    expect(result.text).toContain("未完成事项");
    expect(result.text).toContain("修复默认模型读取工作区");
  });

  it("answers exact local secret reads directly from document previews", () => {
    const result = buildLocalWorkspaceDirectReply({
      promptText: "请阅读这个本地目录里的第一章小说文件，只回答里面的暗号四个字。",
      cwd: tmpDir,
      now: new Date("2026-04-11T04:00:00Z"),
    });

    expect(result.ok).toBe(true);
    expect(result.text).toBe("桐门已亮");
  });

  it("prefers an explicit absolute directory in the prompt over the session cwd", () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-workspace-other-"));
    try {
      const result = buildLocalWorkspaceDirectReply({
        promptText: `读一下这个项目${tmpDir}`,
        cwd: otherDir,
        now: new Date("2026-04-11T04:00:00Z"),
      });

      expect(result.ok).toBe(true);
      expect(result.root).toBe(tmpDir);
      expect(result.text).toContain("[文件] jian.md");
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it("reads an explicit absolute file path instead of falling back to the session cwd", () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-workspace-other-"));
    const paperDir = path.join(tmpDir, "paper", "alphaT3SOC_v2");
    const paperPath = path.join(paperDir, "main.tex");
    try {
      fs.mkdirSync(paperDir, { recursive: true });
      fs.writeFileSync(paperPath, "\\section{Alpha T3SOC}\n真实论文内容\n", "utf8");
      fs.writeFileSync(path.join(otherDir, "wrong.md"), "错误目录内容", "utf8");

      const result = buildLocalWorkspaceDirectReply({
        promptText: `阅读${paperPath}`,
        cwd: otherDir,
        now: new Date("2026-04-11T04:00:00Z"),
      });

      expect(result.ok).toBe(true);
      expect(result.root).toBe(paperDir);
      expect(result.text).toContain(`我已读取 \`${paperPath}\``);
      expect(result.text).toContain("\\section{Alpha T3SOC}");
      expect(result.text).toContain("真实论文内容");
      expect(result.text).not.toContain("错误目录内容");
      expect(result.text).not.toContain("当前看到 0 个目录项");
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it("limits explicit file previews for large files", () => {
    const paperDir = path.join(tmpDir, "paper");
    const paperPath = path.join(paperDir, "large.tex");
    fs.mkdirSync(paperDir, { recursive: true });
    fs.writeFileSync(paperPath, `${"A".repeat(700_000)}\n尾部不应出现在预览里`, "utf8");

    const result = buildLocalWorkspaceDirectReply({
      promptText: `阅读${paperPath}`,
      cwd: tmpDir,
      maxDocChars: 120,
      now: new Date("2026-04-11T04:00:00Z"),
    });

    expect(result.ok).toBe(true);
    expect(result.text).toContain("内容过长，仅读取前");
    expect(result.text).not.toContain("尾部不应出现在预览里");
  });
});
