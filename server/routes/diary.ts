/**
 * diary.js — 日记 REST API
 *
 * POST /api/diary/write — 生成当日日记
 * GET  /api/diary/list  — 列出已有日记
 */

import fs from "fs";
import { Hono } from "hono";
import { resolveDiaryDir } from "../../lib/diary/diary-writer.js";

type DiaryWriteResult = {
  error?: string;
  filePath?: string;
  content?: string;
  logicalDate?: string;
};

interface DiaryRouteEngine {
  homeCwd?: string | null;
  writeDiary(): Promise<DiaryWriteResult> | DiaryWriteResult;
}

export function createDiaryRoute(engine: DiaryRouteEngine): Hono {
  const route = new Hono();

  /** POST /diary/write — 触发日记生成 */
  route.post("/diary/write", async (c) => {
    try {
      const result = await engine.writeDiary();
      if (result.error) {
        return c.json({ error: result.error }, 400);
      }
      return c.json({
        filePath: result.filePath,
        content: result.content,
        logicalDate: result.logicalDate,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[diary] write failed: ${message}`);
      return c.json({ error: message }, 500);
    }
  });

  /** GET /diary/list — 列出已有日记文件 */
  route.get("/diary/list", async (c) => {
    const cwd = engine.homeCwd || process.cwd();
    const diaryDir = resolveDiaryDir(cwd);
    try {
      const files = fs.readdirSync(diaryDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .reverse();
      return c.json({ files });
    } catch {
      return c.json({ files: [] });
    }
  });

  return route;
}
