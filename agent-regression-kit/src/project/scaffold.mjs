import fs from "node:fs/promises";
import path from "node:path";

import { inferCapabilityPlan } from "../harness/capabilities.mjs";
import { normalizeModelProfile } from "../harness/model-profile.mjs";
import { inspectProject } from "./inspect.mjs";

export async function scaffoldProjectRegression({
  projectDir = process.cwd(),
  outDir,
  model = {},
  force = false,
} = {}) {
  const profile = await inspectProject(projectDir);
  const modelProfile = normalizeModelProfile(model);
  const capabilityPlan = inferCapabilityPlan(profile);
  const root = profile.root;
  const targetDir = path.resolve(root, outDir || "agent-regression");
  await fs.mkdir(targetDir, { recursive: true });
  await fs.mkdir(path.join(targetDir, "cases"), { recursive: true });

  const files = [
    {
      path: path.join(targetDir, "project-profile.json"),
      content: `${JSON.stringify(profile, null, 2)}\n`,
    },
    {
      path: path.join(targetDir, "agent-regression.config.json"),
      content: `${JSON.stringify(buildConfig(profile, modelProfile, capabilityPlan), null, 2)}\n`,
    },
    {
      path: path.join(targetDir, "capability-plan.json"),
      content: `${JSON.stringify({ schema: "agent-regression-kit.capability-plan.v1", capabilities: capabilityPlan }, null, 2)}\n`,
    },
    {
      path: path.join(targetDir, "adapter.mjs"),
      content: adapterTemplate(profile),
    },
    {
      path: path.join(targetDir, "cases", "project-smoke.json"),
      content: `${JSON.stringify(caseBankTemplate(profile, capabilityPlan), null, 2)}\n`,
    },
    {
      path: path.join(targetDir, "README.md"),
      content: readmeTemplate(profile),
    },
  ];

  const written = [];
  for (const file of files) {
    if (!force && await exists(file.path)) {
      throw new Error(`Refusing to overwrite ${file.path}; pass --force to replace generated files.`);
    }
    await fs.writeFile(file.path, file.content, "utf8");
    written.push(file.path);
  }
  return { root, outDir: targetDir, profile, written };
}

function buildConfig(profile, model, capabilityPlan) {
  return {
    schema: "agent-regression-kit.project.v1",
    projectDir: profile.root,
    source: profile.source,
    modelApi: model,
    harness: {
      mode: "contract-regression",
      capabilities: capabilityPlan.map((item) => item.id),
      livePolicy: model.liveAssertions,
    },
    recommendedTargets: profile.recommendedTargets,
  };
}

function caseBankTemplate(profile, capabilityPlan) {
  return {
    name: `${profile.package?.name || path.basename(profile.root)}-agent-contracts`,
    version: "0.1.0",
    description: "Generated starter case bank. Extend this with project-specific agent runtime contracts.",
    cases: [
      {
        id: "project.profile-detected",
        title: "Project profile was detected and can be loaded by the adapter",
        level: "smoke",
        tags: ["generated", "profile"],
        operation: "project_profile",
        input: {},
        assertions: [
          { path: "root", equals: profile.root },
          { path: "recommendedTargets", present: true },
          { path: "capabilities", present: true },
        ],
      },
      {
        id: "model.api-configured",
        title: "Model API injection is visible to the adapter",
        level: "smoke",
        tags: ["generated", "model-api"],
        operation: "model_api_config",
        input: {},
        assertions: [
          { path: "provider", equals: "openai-compatible" },
          { path: "apiKeyEnv", equals: "ARK_MODEL_API_KEY" },
        ],
      },
      {
        id: "harness.capability-plan",
        title: "Harness capability plan declares runtime boundaries before live ability checks",
        level: "smoke",
        tags: ["generated", "harness", "capability"],
        operation: "capability_plan",
        input: {},
        assertions: [
          { path: "capabilities", contains: capabilityPlan[0]?.id || "turn.lifecycle" },
          { path: "required", contains: "turn.lifecycle" },
          { path: "required", contains: "provider.contract" },
        ],
      },
    ],
  };
}

function adapterTemplate() {
  return `import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_PATH = path.join(HERE, "project-profile.json");
const CONFIG_PATH = path.join(HERE, "agent-regression.config.json");

export async function createAdapter() {
  const profile = JSON.parse(await fs.readFile(PROFILE_PATH, "utf8"));
  const config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
  return {
    name: profile.package?.name || path.basename(profile.root),
    version: "generated-v1",
    async run(operation, input) {
      switch (operation) {
        case "project_profile":
          return { ...profile, capabilities: config.harness.capabilities };
        case "model_api_config":
          return {
            provider: config.modelApi.provider,
            baseUrl: resolveTemplate(config.modelApi.baseUrl),
            model: resolveTemplate(config.modelApi.model),
            apiKeyEnv: config.modelApi.apiKeyEnv,
            hasApiKey: Boolean(process.env[config.modelApi.apiKeyEnv]),
            livePolicy: config.harness.livePolicy,
          };
        case "capability_plan":
          return {
            capabilities: config.harness.capabilities,
            required: config.harness.capabilities.filter((id) => {
              return ["turn.lifecycle", "provider.contract"].includes(id);
            }),
            livePolicy: config.harness.livePolicy,
          };
        case "command":
          return runCommand(input, profile.root);
        default:
          throw new Error("Unsupported generated adapter operation: " + operation);
      }
    },
  };
}

function resolveTemplate(value) {
  return String(value || "").replace(/^\\$\\{([A-Z0-9_]+)\\}$/u, (_match, name) => process.env[name] || "");
}

function runCommand(input, cwd) {
  const command = String(input.command || "");
  const args = Array.isArray(input.args) ? input.args.map(String) : [];
  if (!command) throw new Error("command operation requires input.command");
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...(input.env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, Number(input.timeoutMs || 30000));
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: stderr || error.message });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, signal: signal || "", stdout, stderr });
    });
  });
}
`;
}

function readmeTemplate(profile) {
  return `# Agent Regression

Generated by Agent Regression Kit.

Project: ${profile.package?.name || path.basename(profile.root)}
Source: ${profile.source}
Recommended targets: ${profile.recommendedTargets.join(", ")}

This harness separates runtime contracts from model ability. Runtime contracts
must pass with a deterministic fake provider. Live model tests should only add
capability evidence and should avoid exact prose assertions unless the injected
model/profile is marked deterministic.

## Run

\`\`\`bash
ark --adapter ./agent-regression/adapter.mjs --case-bank ./agent-regression/cases/project-smoke.json --level smoke
\`\`\`

## Model API Injection

The generated adapter reads:

- \`ARK_MODEL_BASE_URL\`
- \`ARK_MODEL_API_KEY\`
- \`ARK_MODEL_ID\`

Use these to point the project at a fake provider, a local model gateway, or a live model API depending on the lane.

## Next Cases To Add

- CLI prompt contract, if this project exposes a CLI.
- HTTP or WebSocket turn contract, if this project exposes a local server.
- GUI retry/edit/send contract, if this project has a browser or Electron surface.
- Tool-call trajectory contract, if tools are available.
- Empty-answer, timeout, and stale-context cases.
`;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
