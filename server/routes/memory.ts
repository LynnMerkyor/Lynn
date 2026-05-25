/**
 * Lynn brain · v0.77 memory routes
 *
 * 部署位置: /opt/lobster-brain/routes/memory.js
 * 挂载: app.route("/v1/memory", memoryRoutes)
 *
 * 依赖:
 *   npm install hono better-sqlite3 sqlite-vec
 *
 * 接口对齐: openapi-v0.77.yaml
 *   POST /v1/memory/write
 *   POST /v1/memory/write_batch
 *   POST /v1/memory/recall
 *   GET  /v1/memory/list
 *   DELETE /v1/memory/:id
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

type SqlParam = string | number | bigint | Buffer | null;

type Statement<TRow = unknown> = {
  run(...params: SqlParam[]): { lastInsertRowid: number | bigint };
  all(...params: SqlParam[]): TRow[];
  get(...params: SqlParam[]): TRow | undefined;
};

type DatabaseInstance = {
  pragma(sql: string): unknown;
  exec(sql: string): unknown;
  prepare<TRow = unknown>(sql: string): Statement<TRow>;
  transaction<TResult>(fn: () => TResult): () => TResult;
};

type DatabaseFactory = new (dbPath: string) => DatabaseInstance;

type SqliteVecModule = {
  load(db: DatabaseInstance): void;
};

type MemoryMetadata = Record<string, unknown> & {
  document_id?: string | number | null;
};

type WriteBody = {
  text?: string;
  layer?: string;
  source?: string;
  metadata?: MemoryMetadata | null;
};

type WriteBatchItem = {
  text: string;
  layer: string;
  source: string;
  metadata?: MemoryMetadata | null;
};

type WriteBatchBody = {
  items?: WriteBatchItem[];
};

type RecallBody = {
  query?: string;
  top_k?: number;
  layers?: string[];
  rerank?: boolean;
  sources?: string[];
};

type MemoryRow = {
  id: number;
  text: string;
  layer: string;
  source: string;
  timestamp: number;
  metadata: string | null;
  distance?: number | null;
};

type CountRow = {
  n: number;
};

type MemoryItem = {
  id: number;
  text: string;
  layer: string;
  source: string;
  timestamp: number;
  score: number;
  metadata?: unknown;
  snippet?: string;
};

type RerankScore = {
  index: number;
  score: number;
};

type MemoryRouteContext = Context;

type BuildMemoryContextOptions = {
  enabled?: boolean;
  top_k?: number;
  layers?: string[];
  inject_strategy?: string;
};

type BuildMemoryContextResult = {
  systemMessage: { role: "system"; content: string } | null;
  memoryUsedEvent: {
    type: "memory_used";
    items: Array<{
      id: number;
      snippet: string;
      source: string;
      layer: string;
      timestamp: number;
      score: number;
    }>;
    recall_ms: number;
  } | null;
};

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as DatabaseFactory;
const sqliteVec = require("sqlite-vec") as SqliteVecModule;

// ============ DB 初始化 (启动时执行一次) ============
const DB_PATH = process.env.LYNN_MEMORY_DB
  || path.join(os.homedir(), ".lynn", "memory.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
sqliteVec.load(db);

// 跑迁移
const migrationDir = path.join(import.meta.dirname || ".", "..", "migrations");
if (fs.existsSync(migrationDir)) {
  for (const f of fs.readdirSync(migrationDir).sort()) {
    if (f.endsWith(".sql")) {
      db.exec(fs.readFileSync(path.join(migrationDir, f), "utf-8"));
    }
  }
}

// 预编译 statements (热路径)
const stmts = {
  insertMeta: db.prepare(`
    INSERT INTO memory_meta (text, layer, source, timestamp, metadata, document_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  insertVec: db.prepare(`
    INSERT INTO memory_vec (rowid, embedding) VALUES (?, ?)
  `),
  vecSearch: db.prepare<MemoryRow>(`
    SELECT m.id, m.text, m.layer, m.source, m.timestamp, m.metadata,
           vec.distance
    FROM memory_vec vec
    JOIN memory_meta m ON m.id = vec.rowid
    WHERE m.deleted = 0
      AND vec.embedding MATCH ?
      AND m.layer IN (SELECT value FROM json_each(?))
      ${/* sources optional */ ""}
    ORDER BY vec.distance
    LIMIT ?
  `),
  vecSearchWithSources: db.prepare<MemoryRow>(`
    SELECT m.id, m.text, m.layer, m.source, m.timestamp, m.metadata,
           vec.distance
    FROM memory_vec vec
    JOIN memory_meta m ON m.id = vec.rowid
    WHERE m.deleted = 0
      AND vec.embedding MATCH ?
      AND m.layer IN (SELECT value FROM json_each(?))
      AND m.source IN (SELECT value FROM json_each(?))
    ORDER BY vec.distance
    LIMIT ?
  `),
  list: db.prepare<MemoryRow>(`
    SELECT id, text, layer, source, timestamp, metadata
    FROM v_memory_active
    WHERE (? IS NULL OR layer = ?)
      AND (? IS NULL OR source = ?)
    ORDER BY CASE WHEN ? = 'recent' THEN -timestamp ELSE timestamp END
    LIMIT ? OFFSET ?
  `),
  count: db.prepare<CountRow>(`
    SELECT COUNT(*) as n FROM v_memory_active
    WHERE (? IS NULL OR layer = ?) AND (? IS NULL OR source = ?)
  `),
  softDelete: db.prepare(`UPDATE memory_meta SET deleted = 1 WHERE id = ?`),
};

// ============ Embed/Rerank Clients ============
const EMBED_URL = process.env.LYNN_EMBED_URL || "http://localhost:8002";
const RERANK_URL = process.env.LYNN_RERANK_URL || "http://localhost:8003";

async function embed(texts: string | string[]): Promise<number[][]> {
  const arr = Array.isArray(texts) ? texts : [texts];
  const r = await fetch(`${EMBED_URL}/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inputs: arr }),
  });
  if (!r.ok) throw new Error(`embed failed: ${r.status}`);
  return await r.json() as number[][]; // [[1024-d float], ...]
}

async function rerank(query: string, docs: string[], topK: number): Promise<RerankScore[]> {
  const r = await fetch(`${RERANK_URL}/rerank`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      texts: docs,
      raw_scores: false,
      truncate: true,
    }),
  });
  if (!r.ok) throw new Error(`rerank failed: ${r.status}`);
  const scored = await r.json() as RerankScore[];
  // 已按分数降序排
  return scored.slice(0, topK);
}

// ============ helpers ============
function vecAsBlob(arr: ArrayLike<number>): Buffer {
  // sqlite-vec 接受 Float32Array → Buffer
  return Buffer.from(new Float32Array(arr).buffer);
}

function metaJSON(obj: unknown): string | null {
  return obj ? JSON.stringify(obj) : null;
}

function parseMetadata(raw: string | null): unknown {
  if (!raw) return undefined;
  try { return JSON.parse(raw); } catch { return undefined; }
}

function rowToItem(row: MemoryRow, score: number | null = null): MemoryItem {
  return {
    id: row.id,
    text: row.text,
    layer: row.layer,
    source: row.source,
    timestamp: row.timestamp,
    score: score ?? (1 - (row.distance ?? 0)),  // distance → similarity
    metadata: parseMetadata(row.metadata),
  };
}

// ============ Routes ============
export const memoryRoutes = new Hono();

// ---- POST /v1/memory/write ----
memoryRoutes.post("/write", async (c: MemoryRouteContext) => {
  const body = await c.req.json() as WriteBody;
  const { text, layer, source, metadata } = body;

  if (!text || !layer || !source) {
    return c.json({ error: "missing required fields" }, 400);
  }

  const t0 = Date.now();
  const [vec] = await embed([text]);
  const embedMs = Date.now() - t0;

  const tx = db.transaction(() => {
    const r = stmts.insertMeta.run(
      text, layer, source, Date.now(), metaJSON(metadata), null
    );
    stmts.insertVec.run(r.lastInsertRowid, vecAsBlob(vec));
    return r.lastInsertRowid;
  });
  const id = tx();

  return c.json({ id, embedding_ms: embedMs });
});

// ---- POST /v1/memory/write_batch ----
memoryRoutes.post("/write_batch", async (c: MemoryRouteContext) => {
  const { items } = await c.req.json() as WriteBatchBody;
  if (!Array.isArray(items) || items.length === 0) {
    return c.json({ error: "items required" }, 400);
  }
  if (items.length > 256) {
    return c.json({ error: "max 256 items per batch" }, 400);
  }

  const t0 = Date.now();
  const texts = items.map(i => i.text);
  const vecs = await embed(texts);

  const tx = db.transaction(() => {
    const ids = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const r = stmts.insertMeta.run(
        it.text, it.layer, it.source, Date.now(),
        metaJSON(it.metadata), it.metadata?.document_id ?? null
      );
      stmts.insertVec.run(r.lastInsertRowid, vecAsBlob(vecs[i]));
      ids.push(r.lastInsertRowid);
    }
    return ids;
  });
  const ids = tx();

  return c.json({ ids, total_ms: Date.now() - t0 });
});

// ---- POST /v1/memory/recall ----
memoryRoutes.post("/recall", async (c: MemoryRouteContext) => {
  const body = await c.req.json() as RecallBody;
  const {
    query,
    top_k = 5,
    layers = ["L3", "L4", "L5", "L6"],
    rerank: doRerank = true,
    sources,
  } = body;

  if (!query) return c.json({ error: "query required" }, 400);

  const t0 = Date.now();
  const [qVec] = await embed([query]);
  const embedMs = Date.now() - t0;

  // 粗召回 30 候选 (rerank 之前)
  const candidateK = doRerank ? Math.min(30, top_k * 6) : top_k;

  const tRecall = Date.now();
  const candidates = sources && sources.length
    ? stmts.vecSearchWithSources.all(
        vecAsBlob(qVec), JSON.stringify(layers), JSON.stringify(sources), candidateK
      )
    : stmts.vecSearch.all(
        vecAsBlob(qVec), JSON.stringify(layers), candidateK
      );
  const recallMs = Date.now() - tRecall;

  if (candidates.length === 0) {
    return c.json({
      hits: [], total_ms: Date.now() - t0,
      embed_ms: embedMs, recall_ms: recallMs, rerank_ms: 0,
    });
  }

  let hits;
  let rerankMs = 0;
  if (doRerank && candidates.length > top_k) {
    const tR = Date.now();
    const docs = candidates.map(c => c.text);
    const scored = await rerank(query, docs, top_k);
    rerankMs = Date.now() - tR;
    hits = scored.map(({ index, score }) => rowToItem(candidates[index], score));
  } else {
    hits = candidates.slice(0, top_k).map(r => rowToItem(r));
  }

  // 加 snippet (截断到 200 字)
  hits.forEach(h => {
    if (h.text.length > 200) h.snippet = h.text.slice(0, 200) + "…";
  });

  return c.json({
    hits,
    total_ms: Date.now() - t0,
    embed_ms: embedMs,
    recall_ms: recallMs,
    rerank_ms: rerankMs,
  });
});

// ---- GET /v1/memory/list ----
memoryRoutes.get("/list", (c: MemoryRouteContext) => {
  const layer = c.req.query("layer") || null;
  const source = c.req.query("source") || null;
  const limit = Math.min(500, Number(c.req.query("limit") || 50));
  const offset = Number(c.req.query("offset") || 0);
  const order = c.req.query("order") === "oldest" ? "oldest" : "recent";

  const items = stmts.list.all(layer, layer, source, source, order, limit, offset);
  const { n: total } = stmts.count.get(layer, layer, source, source) as CountRow;

  return c.json({
    items: items.map(r => ({
      id: r.id,
      text: r.text,
      layer: r.layer,
      source: r.source,
      timestamp: r.timestamp,
      score: 1.0,
      metadata: parseMetadata(r.metadata),
    })),
    total,
  });
});

// ---- DELETE /v1/memory/:id ----
memoryRoutes.delete("/:id", (c: MemoryRouteContext) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
  stmts.softDelete.run(id);
  return c.body(null, 204);
});

// ============ Chat 集成 helper (供 /v1/chat/completions 调用) ============
/**
 * 给定用户最新 message,召回相关记忆,返回要插入的 system message
 * @param {string} userText
 * @param {object} opts
 * @returns {Promise<{systemMessage: object|null, memoryUsedEvent: object|null}>}
 */
export async function buildMemoryContext(
  userText: string,
  opts: BuildMemoryContextOptions = {},
): Promise<BuildMemoryContextResult> {
  const {
    enabled = false,
    top_k = 5,
    layers = ["L3", "L4", "L5", "L6"],
    inject_strategy = "system_prompt",
  } = opts;

  if (!enabled || !userText || inject_strategy === "off") {
    return { systemMessage: null, memoryUsedEvent: null };
  }

  // 调自己的 /recall (绕一圈虽然 hacky 但解耦清楚)
  // 直接复用上面 stmts 也行,这里写 inline 版本
  const t0 = Date.now();
  const [qVec] = await embed([userText]);

  const candidates = stmts.vecSearch.all(
    vecAsBlob(qVec), JSON.stringify(layers), Math.min(30, top_k * 6)
  );
  if (candidates.length === 0) {
    return { systemMessage: null, memoryUsedEvent: null };
  }

  const scored = await rerank(userText, candidates.map(c => c.text), top_k);
  const hits = scored.map(({ index, score }) => rowToItem(candidates[index], score));
  const recallMs = Date.now() - t0;

  // 拼 system prompt
  const memoryBlock = hits.map((h, i) => {
    const t = new Date(h.timestamp).toISOString().slice(0, 10);
    return `[#${i + 1} · ${t} · ${h.source}] ${h.text}`;
  }).join("\n");

  const systemMessage = {
    role: "system",
    content: `# 相关记忆 (按相关性排序,Top ${hits.length})\n${memoryBlock}`,
  } as const;

  // 给前端的事件
  const memoryUsedEvent = {
    type: "memory_used",
    items: hits.map(h => ({
      id: h.id,
      snippet: h.snippet ?? h.text,
      source: h.source,
      layer: h.layer,
      timestamp: h.timestamp,
      score: h.score,
    })),
    recall_ms: recallMs,
  } as const;

  return { systemMessage, memoryUsedEvent };
}

// 暴露 db 供高级用法
export { db };
