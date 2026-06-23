/**
 * memory-search.js — search_memory 工具（v2 标签检索 + Phase 4 混合检索）
 *
 * 替代 v1 的 embedding KNN + 混合排序 + 链接展开。
 * v2 用标签匹配 + 日期过滤 + FTS5 全文搜索兜底。
 * Phase 4: 可选使用 HybridRetriever 进行统一检索。
 *
 * 标签由 LLM 在元事实拆分时生成，也由 LLM 在搜索时生成查询标签，
 * 两边的"语言习惯"天然接近，一致性有保障。
 */

import { Type } from "@sinclair/typebox";
import { t } from "../../shared/i18n-runtime.js";

interface MemoryFact {
  id: string | number;
  fact: string;
  tags: string[];
  category?: string;
  confidence?: number;
  evidence?: string;
  time?: string;
  source?: string;
  score?: number;
  vectorScore?: number;
  matchCount?: number;
  [key: string]: unknown;
}

interface RelatedFact {
  relation: string;
  fact: string;
  category?: string;
}

interface MemoryFactStore {
  size: number;
  searchByCategory?: (category: string, limit: number) => MemoryFact[];
  searchByTags: (tags: string[], dateRange?: { from?: string; to?: string }, limit?: number) => MemoryFact[];
  searchFullText: (query: string, limit?: number) => MemoryFact[];
  getRelatedFacts?: (ids: Array<string | number>) => Map<string | number, RelatedFact[]>;
}

interface MemoryRetriever {
  search: (keywords: string[], limit: number) => Promise<MemoryFact[]>;
}

interface MemorySearchOptions {
  retriever?: MemoryRetriever | null;
}

interface MemorySearchParams {
  query?: string;
  tags?: string[];
  category?: string;
  date_from?: string;
  date_to?: string;
}

type MemorySearchResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 创建 search_memory 工具定义
 * @param {import('./fact-store.js').FactStore} factStore
 * @param {object} [opts]
 * @param {import('./retriever.js').HybridRetriever} [opts.retriever] - Phase 4 混合检索器
 * @returns {import('../../core/agent-runtime/types.js').ToolDefinition}
 */
export function createMemorySearchTool(factStore: MemoryFactStore, opts: MemorySearchOptions = {}) {
  const retriever = opts.retriever || null;

  return {
    name: "search_memory",
    label: t("error.memorySearchLabel"),
    description: t("error.memorySearchDesc"),
    parameters: Type.Object({
      query: Type.String({ description: t("error.memorySearchQueryDesc") }),
      tags: Type.Optional(
        Type.Array(Type.String(), {
          description: t("error.memorySearchTagsDesc"),
        }),
      ),
      category: Type.Optional(
        Type.String({ description: "Optional structured memory category filter" }),
      ),
      date_from: Type.Optional(
        Type.String({ description: t("error.memorySearchDateFromDesc") }),
      ),
      date_to: Type.Optional(
        Type.String({ description: t("error.memorySearchDateToDesc") }),
      ),
    }),
    execute: async (_toolCallId: string, params: MemorySearchParams): Promise<MemorySearchResult> => {
      try {
        const t0 = performance.now();

        if (factStore.size === 0) {
          return {
            content: [{ type: "text", text: t("error.memorySearchEmpty") }],
            details: {},
          };
        }

        const dateRange: { from?: string; to?: string } = {};
        if (params.date_from) dateRange.from = params.date_from;
        if (params.date_to) dateRange.to = params.date_to + "T23:59";

        let results: MemoryFact[] = [];
        const normalizedCategory = params.category ? String(params.category).trim().toLowerCase() : "";

        if (normalizedCategory && !((params.tags?.length || 0) > 0) && !params.query) {
          results = (factStore.searchByCategory?.(normalizedCategory, 15) || []).map((r) => ({
            ...r,
            source: "category",
          }));
        }
        // Phase 4: 优先使用 HybridRetriever
        else if (retriever && (((params.tags?.length || 0) > 0) || params.query)) {
          const keywords = [...(params.tags || [])];
          // 将 query 中的词也加入关键词
          if (params.query) {
            const queryWords = params.query.trim().split(/\s+/).filter((w) => w.length >= 2);
            for (const w of queryWords) {
              if (!keywords.includes(w)) keywords.push(w);
            }
          }
          const hybridResults = await retriever.search(keywords, 15);
          results = hybridResults.map((r) => ({
            ...r,
            source: (r.vectorScore || 0) > 0.2 ? "vector" : ((r.score || 0) > 1.5 ? "tag" : "fts"),
          }));
        } else {
          // 回退到原始逻辑
          const seenIds = new Set<string | number>();

          // 策略 1：标签匹配（优先）
          if (params.tags && params.tags.length > 0) {
            const tagResults = factStore.searchByTags(
              params.tags,
              Object.keys(dateRange).length > 0 ? dateRange : undefined,
              15,
            );
            for (const r of tagResults) {
              seenIds.add(r.id);
              results.push({ ...r, source: "tag" });
            }
          }

          // 策略 2：全文搜索补充（标签结果不足 3 条时）
          if (results.length < 3 && params.query) {
            const ftsResults = factStore.searchFullText(params.query, 10);
            for (const r of ftsResults) {
              if (seenIds.has(r.id)) continue;
              seenIds.add(r.id);
              results.push({ ...r, source: "fts" });
            }
          }
        }

        if (normalizedCategory) {
          results = results.filter((r) => (r.category || "other") === normalizedCategory);
        }

        // 日期过滤（对所有结果应用）
        if (dateRange.from || dateRange.to) {
          results = results.filter((r) => {
            if (!r.time) return true; // 无时间的不过滤
            if (dateRange.from && r.time < dateRange.from) return false;
            if (dateRange.to && r.time > dateRange.to) return false;
            return true;
          });
        }

        const elapsed = performance.now() - t0;
        console.log(
          `\x1b[90m[memory-search] ${elapsed.toFixed(0)}ms | ` +
          `hits: ${results.length} (tag: ${results.filter((r) => r.source === "tag").length}, ` +
          `fts: ${results.filter((r) => r.source === "fts").length}, vector: ${results.filter((r) => r.source === "vector").length})\x1b[0m`,
        );

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: t("error.memorySearchEmpty") }],
            details: {},
          };
        }

        const relatedFacts = typeof factStore.getRelatedFacts === "function"
          ? factStore.getRelatedFacts(results.map((r) => r.id))
          : new Map();

        // 格式化输出
        const lines = results.map((r, i) => {
          const tagsStr = r.tags.length > 0 ? ` (${r.tags.join(", ")})` : "";
          const categoryStr = r.category ? ` [${r.category}]` : "";
          const timeStr = r.time ? ` — ${r.time}` : "";
          const confidenceStr = typeof r.confidence === "number" ? ` · ${(r.confidence * 100).toFixed(0)}%` : "";
          const evidenceStr = r.evidence ? `\n   ↳ ${r.evidence}` : "";
          const links = relatedFacts.get(r.id) || [];
          const relationLines = links.slice(0, 3).map((link: RelatedFact) =>
            `\n   ↳ ${link.relation}: ${link.fact}${link.category ? ` [${link.category}]` : ""}`,
          ).join("");
          return `${i + 1}. ${r.fact}${categoryStr}${tagsStr}${timeStr}${confidenceStr}${evidenceStr}${relationLines}`;
        });

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { resultCount: results.length },
        };
      } catch (err) {
        return {
            content: [{ type: "text", text: t("error.memorySearchError", { msg: errorMessage(err) }) }],
          details: {},
        };
      }
    },
  };
}
