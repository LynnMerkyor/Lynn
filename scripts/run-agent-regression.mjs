#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createLynnAdapter } from "../agent-regression-kit/adapters/lynn.mjs";
import { loadCaseBank, runCaseBank, selectCases } from "../agent-regression-kit/src/core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const level = args.level || "release";
  const caseBankPath = path.resolve(repoRoot, args.caseBank || "agent-regression-kit/cases/lynn-backend-v1.json");
  const caseBank = await loadCaseBank(caseBankPath);
  const ids = values(args.case);
  const tags = values(args.tag);

  if (args.list) {
    for (const testCase of selectCases(caseBank, { level, ids, tags })) {
      console.log(`${testCase.id}\t${testCase.level || "release"}\t${(testCase.tags || []).join(",")}\t${testCase.title || ""}`);
    }
    return;
  }

  const adapter = createLynnAdapter();
  const report = await runCaseBank({
    caseBank,
    adapter,
    level,
    ids,
    tags,
    failFast: Boolean(args.failFast),
  });

  printReport(report);
  const reportPath = await writeReport(report, args);
  console.log(`\nReport: ${reportPath}`);

  if (!report.ok) {
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--list") args.list = true;
    else if (arg === "--fail-fast") args.failFast = true;
    else if (arg.startsWith("--level=")) args.level = arg.slice("--level=".length);
    else if (arg === "--level") args.level = argv[++i];
    else if (arg.startsWith("--case=")) pushArg(args, "case", arg.slice("--case=".length));
    else if (arg === "--case") pushArg(args, "case", argv[++i]);
    else if (arg.startsWith("--tag=")) pushArg(args, "tag", arg.slice("--tag=".length));
    else if (arg === "--tag") pushArg(args, "tag", argv[++i]);
    else if (arg.startsWith("--case-bank=")) args.caseBank = arg.slice("--case-bank=".length);
    else if (arg === "--case-bank") args.caseBank = argv[++i];
    else if (arg.startsWith("--report-dir=")) args.reportDir = arg.slice("--report-dir=".length);
    else if (arg === "--report-dir") args.reportDir = argv[++i];
    else if (arg === "--no-report") args.noReport = true;
    else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function pushArg(args, key, value) {
  if (!value) return;
  if (!args[key]) args[key] = [];
  args[key].push(value);
}

function values(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function printReport(report) {
  const status = report.ok ? "PASS" : "FAIL";
  console.log(`Agent Regression Kit · ${status}`);
  console.log(`Case bank: ${report.caseBank.name} · level=${report.level} · adapter=${report.adapter.name}`);
  console.log(`Cases: ${report.passed}/${report.total} passed · ${report.durationMs}ms`);

  for (const result of report.results) {
    const mark = result.ok ? "✓" : "✗";
    console.log(`${mark} ${result.id} (${result.durationMs}ms)`);
    if (result.ok) continue;
    if (result.error) {
      console.log(`  error: ${result.error}`);
    }
    for (const assertion of result.assertions || []) {
      if (assertion.ok) continue;
      console.log(`  assertion: ${assertion.message || `${assertion.path} ${assertion.operator}`}`);
      console.log(`    expected: ${JSON.stringify(assertion.expected)}`);
      console.log(`    actual: ${JSON.stringify(assertion.actual)}`);
    }
  }
}

async function writeReport(report, args) {
  if (args.noReport) return "(disabled)";
  const reportDir = path.resolve(args.reportDir || path.join(os.tmpdir(), "lynn-agent-regression"));
  await fs.mkdir(reportDir, { recursive: true });
  const stamp = report.startedAt.replace(/[:.]/g, "-");
  const reportPath = path.join(reportDir, `${report.caseBank.name}-${report.level}-${stamp}.json`);
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const latestPath = path.join(reportDir, `${report.caseBank.name}-${report.level}-latest.json`);
  await fs.writeFile(latestPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return reportPath;
}

function printHelp() {
  console.log(`Usage: node --import tsx scripts/run-agent-regression.mjs [options]

Options:
  --level smoke|release|nightly   Select case level, default release
  --case <id>                     Run one case, can be repeated
  --tag <tag>                     Require tag, can be repeated
  --case-bank <path>              Case bank JSON path
  --list                          List selected cases
  --fail-fast                     Stop after first failed case
  --report-dir <path>             Report output directory
  --no-report                     Print only, do not write JSON report
`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exitCode = 1;
});
