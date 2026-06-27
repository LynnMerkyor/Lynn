import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";

const LEVEL_RANK = Object.freeze({
  smoke: 0,
  release: 1,
  nightly: 2,
});

const ASSERTION_KEYS = [
  "equals",
  "notEquals",
  "contains",
  "notContains",
  "matches",
  "notMatches",
  "truthy",
  "falsy",
  "greaterThan",
  "greaterThanOrEqual",
  "lessThan",
  "lessThanOrEqual",
];

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

  for (const testCase of selected) {
    const result = await runSingleCase(testCase, adapter, caseBank);
    results.push(result);
    if (!result.ok && failFast) break;
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

export function evaluateAssertions(assertions, output) {
  const results = [];
  for (const assertion of assertions || []) {
    const startedAt = Date.now();
    try {
      const result = evaluateAssertion(assertion, output);
      results.push({
        ...result,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      results.push({
        ok: false,
        path: assertion?.path || "",
        operator: assertionOperator(assertion),
        message: assertion?.message || errorMessage(err),
        expected: expectedValue(assertion),
        actual: safeActual(output, assertion?.path),
        durationMs: Date.now() - startedAt,
      });
    }
  }
  return results;
}

async function runSingleCase(testCase, adapter, caseBank) {
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

async function prepareFixture(fixture, context) {
  const prefix = safeSlug(context.case?.id || "agent-regression");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  context.vars.fixtureRoot = root;
  context.addCleanup(() => fs.rm(root, { recursive: true, force: true }));

  for (const file of fixture.files || []) {
    const rel = String(file.path || "").replace(/^[/\\]+/, "");
    if (!rel || rel.includes("..")) {
      throw new Error(`Unsafe fixture file path in ${context.case?.id}: ${file.path}`);
    }
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, interpolateString(String(file.content || ""), context.vars), file.encoding || "utf8");
  }
}

function evaluateAssertion(assertion, output) {
  const pathKey = assertion?.path || "";
  const actual = getPath(output, pathKey);
  const operator = assertionOperator(assertion);
  const expected = expectedValue(assertion);
  let ok = false;

  switch (operator) {
    case "equals":
      ok = deepEqual(actual, expected);
      break;
    case "notEquals":
      ok = !deepEqual(actual, expected);
      break;
    case "contains":
      ok = containsValue(actual, expected);
      break;
    case "notContains":
      ok = !containsValue(actual, expected);
      break;
    case "matches":
      ok = new RegExp(String(expected), assertion.flags || "u").test(String(actual ?? ""));
      break;
    case "notMatches":
      ok = !new RegExp(String(expected), assertion.flags || "u").test(String(actual ?? ""));
      break;
    case "truthy":
      ok = Boolean(actual);
      break;
    case "falsy":
      ok = !actual;
      break;
    case "greaterThan":
      ok = Number(actual) > Number(expected);
      break;
    case "greaterThanOrEqual":
      ok = Number(actual) >= Number(expected);
      break;
    case "lessThan":
      ok = Number(actual) < Number(expected);
      break;
    case "lessThanOrEqual":
      ok = Number(actual) <= Number(expected);
      break;
    default:
      throw new Error(`Unsupported assertion operator: ${operator || "(none)"}`);
  }

  return {
    ok,
    path: pathKey,
    operator,
    message: assertion?.message || defaultAssertionMessage(pathKey, operator, expected, actual, ok),
    expected,
    actual,
  };
}

function assertionOperator(assertion) {
  if (assertion?.operator) return assertion.operator;
  return ASSERTION_KEYS.find((key) => Object.prototype.hasOwnProperty.call(assertion || {}, key)) || "";
}

function expectedValue(assertion) {
  const op = assertionOperator(assertion);
  if (op === "truthy" || op === "falsy") return true;
  return assertion?.[op];
}

function defaultAssertionMessage(pathKey, operator, expected, actual, ok) {
  if (ok) return "";
  return `${pathKey || "$"} ${operator} ${formatValue(expected)} failed; actual ${formatValue(actual)}`;
}

function safeActual(output, pathKey) {
  try {
    return getPath(output, pathKey || "");
  } catch {
    return undefined;
  }
}

function containsValue(actual, expected) {
  if (typeof actual === "string") return actual.includes(String(expected));
  if (Array.isArray(actual)) return actual.some((item) => deepEqual(item, expected) || String(item) === String(expected));
  if (actual && typeof actual === "object") return Object.values(actual).some((item) => deepEqual(item, expected) || String(item) === String(expected));
  return String(actual ?? "").includes(String(expected));
}

function getPath(value, pathKey) {
  if (!pathKey || pathKey === "$" || pathKey === ".") return value;
  const parts = String(pathKey)
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  let current = value;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

function interpolateDeep(value, vars) {
  if (typeof value === "string") return interpolateString(value, vars);
  if (Array.isArray(value)) return value.map((item) => interpolateDeep(item, vars));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolateDeep(item, vars)]));
  }
  return value;
}

function interpolateString(value, vars) {
  return value.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (match, key) => {
    const replacement = getPath(vars, key);
    return replacement == null ? match : String(replacement);
  });
}

function normalizeLevel(level) {
  const normalized = String(level || "release").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVEL_RANK, normalized) ? normalized : "release";
}

function levelRank(level) {
  return LEVEL_RANK[normalizeLevel(level)];
}

function arrayFrom(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function deepEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value) {
  return JSON.stringify(stableNormalize(value));
}

function stableNormalize(value) {
  if (Array.isArray(value)) return value.map(stableNormalize);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = stableNormalize(value[key]);
      return acc;
    }, {});
  }
  return value;
}

function safeSlug(value) {
  return String(value || "case").replace(/[^a-z0-9._-]+/gi, "-").slice(0, 80) || "case";
}

function errorMessage(err) {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err || "Unknown error");
}

function formatValue(value) {
  return inspect(value, { depth: 4, breakLength: 120 });
}
