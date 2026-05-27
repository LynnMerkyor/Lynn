/**
 * activity-store.js — 助手活动元数据存储
 *
 * 管理心跳、cron 等后台执行的记录。
 * 每次执行存一条元数据（摘要、时间、状态），
 * session .jsonl 文件单独存放在 activity/ 目录。
 *
 * 自动清理：超过 MAX_ENTRIES 条时删除最老的，连同 session 文件。
 */

import fs from "fs";
import path from "path";

const MAX_ENTRIES = 100;

export interface ActivityEntry extends Record<string, unknown> {
  id?: string;
  sessionFile?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseEntries(raw: string): ActivityEntry[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isRecord);
}

export class ActivityStore {
  private readonly _filePath: string;
  private readonly _activityDir: string;
  private _entries: ActivityEntry[];

  constructor(filePath: string, activityDir: string) {
    this._filePath = filePath;
    this._activityDir = activityDir;
    this._entries = [];
    this._load();
  }

  private _load(): void {
    try {
      const raw = fs.readFileSync(this._filePath, "utf-8");
      this._entries = parseEntries(raw);
    } catch {
      this._entries = [];
    }
  }

  private _save(): void {
    fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
    // atomic write: tmp + rename，防止写到一半崩溃损坏文件
    const tmpPath = this._filePath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(this._entries, null, 2), "utf-8");
    fs.renameSync(tmpPath, this._filePath);
  }

  add<T extends ActivityEntry>(entry: T): T {
    this._entries.unshift(entry);
    this._cleanup();
    this._save();
    return entry;
  }

  /** 列出所有活动（已按时间倒序） */
  list(): ActivityEntry[] {
    return this._entries;
  }

  /** 按 ID 查找 */
  get(id: string): ActivityEntry | null {
    return this._entries.find(e => e.id === id) || null;
  }

  /** 自动清理超出上限的老记录 */
  private _cleanup(): void {
    while (this._entries.length > MAX_ENTRIES) {
      const old = this._entries.pop();
      // 删除对应的 session 文件
      if (old?.sessionFile) {
        const sessionPath = path.join(this._activityDir, old.sessionFile);
        try { fs.unlinkSync(sessionPath); } catch {}
      }
    }
  }
}
