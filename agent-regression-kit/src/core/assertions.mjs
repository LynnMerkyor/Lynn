import { inspect } from "node:util";

import { getPath, stableStringify } from "./path.mjs";
import { errorMessage } from "./errors.mjs";

export const ASSERTION_KEYS = [
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
  "absent",
  "present",
];

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

export function evaluateAssertion(assertion, output) {
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
    case "absent":
      ok = actual === undefined;
      break;
    case "present":
      ok = actual !== undefined && actual !== null;
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

export function assertionOperator(assertion) {
  if (assertion?.operator) return assertion.operator;
  return ASSERTION_KEYS.find((key) => Object.prototype.hasOwnProperty.call(assertion || {}, key)) || "";
}

export function expectedValue(assertion) {
  const op = assertionOperator(assertion);
  if (op === "truthy" || op === "falsy" || op === "absent" || op === "present") return true;
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

function deepEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function formatValue(value) {
  return inspect(value, { depth: 4, breakLength: 120 });
}
