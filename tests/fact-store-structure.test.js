import { beforeEach, describe, expect, it, vi } from "vitest";

let rows;
let nextId;

class MockDatabase {
  constructor() {
    this.open = true;
  }

  pragma(name, opts) {
    if (name === "user_version" && opts?.simple) return 4;
    if (name.startsWith("table_info(")) {
      return [
        { name: "id" },
        { name: "fact" },
        { name: "tags" },
        { name: "time" },
        { name: "session_id" },
        { name: "created_at" },
        { name: "source" },
        { name: "project_path" },
        { name: "importance_score" },
        { name: "hit_count" },
        { name: "last_accessed_at" },
        { name: "category" },
        { name: "confidence" },
        { name: "evidence" },
        { name: "harmful_count" },
        { name: "last_used_outcome" },
        { name: "last_used_at" },
      ];
    }
    return [];
  }

  exec() {}

  transaction(fn) {
    return (...args) => fn(...args);
  }

  prepare(sql) {
    if (sql.includes("INSERT INTO facts (")) {
      return {
        run(params) {
          const id = nextId++;
          rows.set(id, {
            id,
            fact: params.fact,
            tags: params.tags,
            time: params.time,
            session_id: params.sessionId,
            created_at: params.createdAt,
            source: params.source,
            project_path: params.projectPath,
            importance_score: params.importanceScore,
            hit_count: params.hitCount,
            last_accessed_at: params.lastAccessedAt,
            category: params.category,
            confidence: params.confidence,
            evidence: params.evidence,
            harmful_count: params.harmfulCount ?? 0,
            last_used_outcome: params.lastUsedOutcome || null,
            last_used_at: params.lastUsedAt || null,
          });
          return { lastInsertRowid: id };
        },
      };
    }

    if (sql.includes("last_used_outcome = @outcome") && sql.includes("harmful_count")) {
      return {
        run(params) {
          const row = rows.get(Number(params.id));
          if (!row) return { changes: 0 };
          row.harmful_count += 1;
          row.last_used_outcome = params.outcome;
          row.last_used_at = params.usedAt;
          return { changes: 1 };
        },
      };
    }

    if (sql.includes("last_used_outcome = @outcome") && sql.includes("hit_count")) {
      return {
        run(params) {
          const row = rows.get(Number(params.id));
          if (!row) return { changes: 0 };
          row.hit_count += 1;
          row.importance_score += params.importanceDelta;
          row.last_accessed_at = params.usedAt;
          row.last_used_outcome = params.outcome;
          row.last_used_at = params.usedAt;
          return { changes: 1 };
        },
      };
    }

    if (sql.includes("SELECT * FROM facts WHERE id = ?")) {
      return {
        get(id) {
          return rows.get(Number(id)) || undefined;
        },
      };
    }

    if (sql.includes("SELECT *\n        FROM facts\n        WHERE category = ?")) {
      return {
        all(category, limit) {
          return Array.from(rows.values())
            .filter((row) => row.category === category)
            .slice(0, limit);
        },
      };
    }

    if (sql.includes("SELECT * FROM facts ORDER BY time DESC")) {
      return {
        all() {
          return Array.from(rows.values());
        },
      };
    }

    if (sql.includes("SELECT * FROM facts WHERE session_id = ? ORDER BY time DESC")) {
      return { all() { return []; } };
    }

    if (sql.includes("SELECT * FROM facts") && sql.includes("importance_score")) {
      return { all() { return []; } };
    }

    if (sql.includes("SELECT COUNT(*) as cnt FROM facts")) {
      return {
        get() {
          return { cnt: rows.size };
        },
      };
    }

    if (sql.includes("DELETE FROM facts WHERE id = ?")) {
      return {
        run(id) {
          const existed = rows.delete(Number(id));
          return { changes: existed ? 1 : 0 };
        },
      };
    }

    if (sql.includes("DELETE FROM facts")) {
      return {
        run() {
          const count = rows.size;
          rows.clear();
          return { changes: count };
        },
      };
    }

    if (sql.includes("UPDATE facts") && sql.includes("hit_count")) {
      return {
        run(params) {
          const row = rows.get(Number(params.id));
          if (!row) return { changes: 0 };
          row.hit_count += params.increment;
          row.importance_score += params.importanceDelta;
          row.last_accessed_at = params.lastAccessedAt;
          return { changes: 1 };
        },
      };
    }

    if (sql.includes("JOIN facts f ON f.id = fts.rowid")) {
      return { all() { return []; } };
    }

    return {
      all() { return []; },
      get() { return undefined; },
      run() { return { changes: 0 }; },
    };
  }

  close() {
    this.open = false;
  }
}

vi.mock("better-sqlite3", () => ({
  default: MockDatabase,
}));

describe("FactStore structured fields", () => {
  beforeEach(() => {
    rows = new Map();
    nextId = 1;
    delete process.env.LYNN_MEMORY_OUTCOME_FEEDBACK;
  });

  it("persists category, confidence, and evidence", async () => {
    const { FactStore } = await import("../lib/memory/fact-store.js");
    const store = new FactStore("/tmp/facts.db");

    const { id } = store.add({
      fact: "用户喜欢暖色调主题",
      tags: ["主题", "暖色"],
      category: "preference",
      confidence: 0.9,
      evidence: "用户明确要求保持米色暖阳主题",
    });

    const row = store.getById(id);
    expect(row?.category).toBe("preference");
    expect(row?.confidence).toBe(0.9);
    expect(row?.evidence).toBe("用户明确要求保持米色暖阳主题");

    store.close();
  });

  it("supports category-only lookup for structured memory views", async () => {
    const { FactStore } = await import("../lib/memory/fact-store.js");
    const store = new FactStore("/tmp/facts.db");

    store.add({ fact: "Lynn 使用 Electron 架构", tags: ["Electron"], category: "project" });
    store.add({ fact: "用户喜欢直接回答", tags: ["偏好"], category: "preference" });

    const rowsFound = store.searchByCategory("preference", 10);
    expect(rowsFound).toHaveLength(1);
    expect(rowsFound[0].fact).toContain("直接回答");

    store.close();
  });

  it("normalizes high-priority memory category aliases", async () => {
    const { FactStore } = await import("../lib/memory/fact-store.js");
    const store = new FactStore("/tmp/facts.db");

    store.add({ fact: "V8 timeout 的历史坑点", tags: ["V8"], category: "bug" });
    store.add({ fact: "Spark 35B A3B 吞吐基准", tags: ["Spark"], category: "benchmark" });

    expect(store.searchByCategory("pitfall", 10)[0].fact).toContain("timeout");
    expect(store.searchByCategory("model_benchmark", 10)[0].fact).toContain("吞吐");

    store.close();
  });

  it("infers pitfall before generic technical categories", async () => {
    const { FactStore } = await import("../lib/memory/fact-store.js");
    const store = new FactStore("/tmp/facts.db");

    const { id } = store.add({
      fact: "Qwen 工具调用在 V8 门禁里曾经因为 timeout 卡死，这是踩坑记录",
      tags: ["Qwen", "V8"],
    });

    expect(store.getById(id)?.category).toBe("pitfall");

    store.close();
  });

  it("marks harmful and helpful outcomes only when feedback is enabled", async () => {
    const { FactStore } = await import("../lib/memory/fact-store.js");
    const store = new FactStore("/tmp/facts.db");

    const { id } = store.add({ fact: "V8 timeout 的历史坑点", tags: ["V8"], category: "pitfall" });
    expect(store.markOutcome([id], "harmful")).toBe(0);
    expect(store.getById(id)?.harmful_count).toBe(0);

    process.env.LYNN_MEMORY_OUTCOME_FEEDBACK = "1";
    expect(store.markOutcome([id], "harmful")).toBe(1);
    expect(store.getById(id)?.harmful_count).toBe(1);
    expect(store.getById(id)?.last_used_outcome).toBe("harmful");

    const beforeHelpful = store.getById(id);
    expect(store.markOutcome([id], "helpful")).toBe(1);
    const afterHelpful = store.getById(id);
    expect(afterHelpful?.hit_count).toBe((beforeHelpful?.hit_count || 0) + 1);
    expect(afterHelpful?.importance_score).toBeGreaterThan(beforeHelpful?.importance_score || 0);
    expect(afterHelpful?.last_used_outcome).toBe("helpful");

    delete process.env.LYNN_MEMORY_OUTCOME_FEEDBACK;
    store.close();
  });
});
