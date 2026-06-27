import fs from "node:fs/promises";
import path from "node:path";

import { evaluateAssertions } from "./assertions.mjs";
import { errorMessage } from "./errors.mjs";
import { prepareFixture } from "./fixtures.mjs";
import { arrayFrom, levelRank, normalizeLevel } from "./levels.mjs";
import { interpolateDeep } from "./path.mjs";

export async function loadCaseBank(filePath) {
  const absolute = path.resolve(filePath);
  const raw = await fs.readFile(absolute, "utf8");
  const bank = JSON.parse(raw);
  if (!bank || typeof bank !== "object") {
    throw new Error(`Invalid case bank: ${absolute}`);
  }
  if (!Array.isArray(bank.cases)) {
    throw new Error(`Case bank must contain a cases array: ${absolute}`);
  }
  return {
    ...bank,
    filePath: absolute,
    rootDir: path.dirname(absolute),
  };
}

export function selectCases(caseBank, opts = {}) {
  const level = normalizeLevel(opts.level || "release");
  const ids = new Set(arrayFrom(opts.ids));
  const tags = new Set(arrayFrom(opts.tags));
  return caseBank.cases.filter((testCase) => {
    if (ids.size > 0 && !ids.has(testCase.id)) return false;
    if (tags.size > 0) {
      const caseTags = new Set(arrayFrom(testCase.tags));
      for (const tag of tags) {
        if (!caseTags.has(tag)) return false;
      }
    }
    return levelRank(testCase.level || "release") <= levelRank(level);
  });
}

export async function runCaseBank({ caseBank, adapter, level = "release", ids = [], tags = [], failFast = false } = {}) {
  if (!caseBank) throw new Error("runCaseBank requires caseBank");
  if (!adapter || typeof adapter.run !== "function") throw new Error("runCaseBank requires an adapter with run(operation, input, context)");

  const startedAt = new Date();
  const selected = selectCases(caseBank, { level, ids, tags });
  const results = [];

  await adapter.setup?.({ caseBank, level: normalizeLevel(level) });
  try {
    for (const testCase of selected) {
      const result = await runSingleCase(testCase, adapter, caseBank);
      results.push(result);
      if (!result.ok && failFast) break;
    }
  } finally {
    await adapter.cleanup?.({ caseBank, level: normalizeLevel(level) });
  }

  const finishedAt = new Date();
  const failed = results.filter((item) => !item.ok);
  return {
    ok: failed.length === 0,
    caseBank: {
      name: caseBank.name || "",
      version: caseBank.version || "",
      filePath: caseBank.filePath || "",
    },
    adapter: {
      name: adapter.name || "",
      version: adapter.version || "",
    },
    level: normalizeLevel(level),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
  };
}

export async function runSingleCase(testCase, adapter, caseBank) {
  const startedAt = new Date();
  const cleanups = [];
  const vars = {
    caseId: testCase.id,
    caseBankRoot: caseBank.rootDir || process.cwd(),
  };
  const context = {
    case: testCase,
    caseBank,
    vars,
    addCleanup(fn) {
      if (typeof fn === "function") cleanups.push(fn);
    },
  };

  let output = null;
  let error = "";
  let assertionResults = [];
  try {
    if (testCase.fixture) {
      await prepareFixture(testCase.fixture, context);
    }
    const operation = testCase.operation || testCase.kind;
    if (!operation) throw new Error(`Case ${testCase.id || "(no id)"} is missing operation`);
    const input = interpolateDeep(testCase.input || {}, vars);
    output = await adapter.run(operation, input, context);
    assertionResults = evaluateAssertions(testCase.assertions || [], output);
  } catch (err) {
    error = errorMessage(err);
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch {
        // Best-effort temp cleanup should not mask the test failure.
      }
    }
  }

  const finishedAt = new Date();
  const assertionFailures = assertionResults.filter((item) => !item.ok);
  return {
    id: testCase.id || "",
    title: testCase.title || "",
    level: testCase.level || "release",
    tags: arrayFrom(testCase.tags),
    operation: testCase.operation || testCase.kind || "",
    ok: !error && assertionFailures.length === 0,
    error,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    output,
    assertions: assertionResults,
  };
}
