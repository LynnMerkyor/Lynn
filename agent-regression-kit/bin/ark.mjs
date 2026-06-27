#!/usr/bin/env node
import process from "node:process";

import {
  inspectProject,
  loadAdapter,
  loadCaseBank,
  printConsoleReport,
  runCaseBank,
  scaffoldProjectRegression,
  selectCases,
  writeJsonReport,
} from "../src/index.mjs";

async function main() {
  const { command, args } = parseArgs(process.argv.slice(2));
  if (command === "inspect") {
    const profile = await inspectProject(args.projectDir || process.cwd());
    if (args.json) console.log(JSON.stringify(profile, null, 2));
    else printProjectProfile(profile);
    return;
  }
  if (command === "init") {
    const result = await scaffoldProjectRegression({
      projectDir: args.projectDir || process.cwd(),
      outDir: args.outDir,
      force: Boolean(args.force),
      model: {
        provider: args.modelProvider,
        baseUrl: args.modelBaseUrl,
        model: args.model,
        apiKeyEnv: args.apiKeyEnv,
        capability: args.modelCapability,
        deterministic: Boolean(args.deterministicModel),
      },
    });
    console.log(`Initialized agent regression harness: ${result.outDir}`);
    for (const file of result.written) console.log(`  wrote ${file}`);
    console.log("\nRun:");
    console.log(`  ark run --adapter ${result.outDir}/adapter.mjs --case-bank ${result.outDir}/cases/project-smoke.json --level smoke`);
    return;
  }

  if (args.help || !args.caseBank) {
    printHelp(args.help ? 0 : 1);
    return;
  }

  const level = args.level || "release";
  const caseBank = await loadCaseBank(args.caseBank);
  const ids = values(args.case);
  const tags = values(args.tag);

  if (args.list) {
    for (const testCase of selectCases(caseBank, { level, ids, tags })) {
      console.log(`${testCase.id}\t${testCase.level || "release"}\t${(testCase.tags || []).join(",")}\t${testCase.title || ""}`);
    }
    return;
  }

  const adapter = await loadAdapter(args.adapter, { cwd: process.cwd() });
  const report = await runCaseBank({
    caseBank,
    adapter,
    level,
    ids,
    tags,
    failFast: Boolean(args.failFast),
  });

  printConsoleReport(report);
  const reportPath = await writeJsonReport(report, {
    reportDir: args.reportDir,
    noReport: args.noReport,
  });
  console.log(`\nReport: ${reportPath}`);

  if (!report.ok) process.exitCode = 1;
}

function parseArgs(argv) {
  const command = isCommand(argv[0]) ? argv.shift() : "run";
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--list") args.list = true;
    else if (arg === "--fail-fast") args.failFast = true;
    else if (arg.startsWith("--level=")) args.level = arg.slice("--level=".length);
    else if (arg === "--level") args.level = argv[++i];
    else if (arg.startsWith("--adapter=")) args.adapter = arg.slice("--adapter=".length);
    else if (arg === "--adapter") args.adapter = argv[++i];
    else if (arg.startsWith("--case-bank=")) args.caseBank = arg.slice("--case-bank=".length);
    else if (arg === "--case-bank") args.caseBank = argv[++i];
    else if (arg.startsWith("--project=")) args.projectDir = arg.slice("--project=".length);
    else if (arg === "--project") args.projectDir = argv[++i];
    else if (arg.startsWith("--out=")) args.outDir = arg.slice("--out=".length);
    else if (arg === "--out") args.outDir = argv[++i];
    else if (arg === "--force") args.force = true;
    else if (arg === "--json") args.json = true;
    else if (arg.startsWith("--model-base-url=")) args.modelBaseUrl = arg.slice("--model-base-url=".length);
    else if (arg === "--model-base-url") args.modelBaseUrl = argv[++i];
    else if (arg.startsWith("--model=")) args.model = arg.slice("--model=".length);
    else if (arg === "--model") args.model = argv[++i];
    else if (arg.startsWith("--model-provider=")) args.modelProvider = arg.slice("--model-provider=".length);
    else if (arg === "--model-provider") args.modelProvider = argv[++i];
    else if (arg.startsWith("--model-capability=")) args.modelCapability = arg.slice("--model-capability=".length);
    else if (arg === "--model-capability") args.modelCapability = argv[++i];
    else if (arg === "--deterministic-model") args.deterministicModel = true;
    else if (arg.startsWith("--api-key-env=")) args.apiKeyEnv = arg.slice("--api-key-env=".length);
    else if (arg === "--api-key-env") args.apiKeyEnv = argv[++i];
    else if (arg.startsWith("--case=")) pushArg(args, "case", arg.slice("--case=".length));
    else if (arg === "--case") pushArg(args, "case", argv[++i]);
    else if (arg.startsWith("--tag=")) pushArg(args, "tag", arg.slice("--tag=".length));
    else if (arg === "--tag") pushArg(args, "tag", argv[++i]);
    else if (arg.startsWith("--report-dir=")) args.reportDir = arg.slice("--report-dir=".length);
    else if (arg === "--report-dir") args.reportDir = argv[++i];
    else if (arg === "--no-report") args.noReport = true;
    else if (arg === "-h" || arg === "--help") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { command, args };
}

function isCommand(value) {
  return ["run", "inspect", "init"].includes(String(value || ""));
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

function printHelp(exitCode) {
  console.log(`Usage:
  ark inspect [--project <dir>] [--json]
  ark init [--project <dir>] [--out <dir>] [--model-base-url <url>] [--model <id>] [--api-key-env <name>]
  ark run --adapter <module[#export]> --case-bank <path> [options]

Options:
  --adapter <path[#export]>       Adapter module. Export can be default, createAdapter, createXAdapter, or adapter.
  --case-bank <path>              Case bank JSON path.
  --project <dir>                 Target project directory for inspect/init.
  --out <dir>                     Harness output directory for init, default agent-regression.
  --model-base-url <url>          Model API base URL placeholder or concrete URL.
  --model <id>                    Model id placeholder or concrete model id.
  --model-provider <name>         Provider style, default openai-compatible.
  --model-capability <level>      weak|normal|strong|unknown for live assertion policy.
  --deterministic-model           Allow exact text assertions for live/model cases.
  --api-key-env <name>            Env var read by generated adapter, default ARK_MODEL_API_KEY.
  --level smoke|release|nightly   Select case level, default release.
  --case <id>                     Run one case, can be repeated.
  --tag <tag>                     Require tag, can be repeated.
  --list                          List selected cases.
  --fail-fast                     Stop after first failed case.
  --report-dir <path>             Report output directory.
  --no-report                     Print only, do not write JSON report.
`);
  process.exitCode = exitCode;
}

function printProjectProfile(profile) {
  console.log(`Project: ${profile.package?.name || profile.root}`);
  console.log(`Root: ${profile.root}`);
  console.log(`Source: ${profile.source}`);
  console.log(`Package manager: ${profile.package?.packageManager || "unknown"}`);
  console.log(`Technology: ${Object.entries(profile.technology || {}).filter(([, yes]) => yes).map(([key]) => key).join(", ") || "unknown"}`);
  console.log(`Recommended targets: ${(profile.recommendedTargets || []).join(", ") || "project-profile"}`);
  console.log(`Agent signal score: ${profile.agentSignals?.score || 0}`);
  for (const hit of profile.agentSignals?.files?.slice(0, 10) || []) {
    console.log(`  ${hit.file}: ${hit.keywords.join(", ")}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exitCode = 1;
});
