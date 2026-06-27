import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const AGENT_KEYWORDS = [
  "openai",
  "anthropic",
  "chat/completions",
  "messages.create",
  "tool_call",
  "tool_calls",
  "function_call",
  "websocket",
  "event-stream",
  "text/event-stream",
  "agent",
  "assistant",
  "prompt",
  "model",
  "provider",
];

export async function inspectProject(projectDir = process.cwd(), opts = {}) {
  const root = path.resolve(projectDir);
  const files = await listProjectFiles(root, opts);
  const packageJson = await readPackageJson(root);
  const remotes = await readGitRemotes(root);
  const packageManager = detectPackageManager(files);
  const scripts = packageJson?.scripts || {};
  const dependencies = {
    ...packageJson?.dependencies,
    ...packageJson?.devDependencies,
    ...packageJson?.optionalDependencies,
  };
  const signals = await scanAgentSignals(root, files);

  return {
    root,
    source: detectSource(remotes),
    vcs: {
      type: remotes.length ? "git" : "none",
      remotes,
    },
    package: packageJson
      ? {
          name: packageJson.name || "",
          version: packageJson.version || "",
          type: packageJson.type || "",
          packageManager,
          scripts,
          bin: packageJson.bin || null,
        }
      : null,
    technology: {
      node: Boolean(packageJson),
      electron: hasDependency(dependencies, "electron"),
      next: hasDependency(dependencies, "next"),
      vite: hasDependency(dependencies, "vite"),
      react: hasDependency(dependencies, "react"),
      python: files.some((file) => /(^|\/)(pyproject\.toml|requirements\.txt|setup\.py)$/.test(file)),
    },
    entrypoints: inferEntrypoints(packageJson, scripts, dependencies),
    agentSignals: signals,
    recommendedTargets: recommendTargets(packageJson, scripts, dependencies, signals),
  };
}

async function listProjectFiles(root, opts = {}) {
  const gitFiles = await capture("git", ["ls-files"], { cwd: root, timeoutMs: 5000 });
  if (gitFiles.code === 0 && gitFiles.stdout.trim()) {
    return gitFiles.stdout.split(/\r?\n/).filter(Boolean).slice(0, opts.maxFiles || 5000);
  }
  const out = [];
  await walk(root, root, out, opts.maxFiles || 5000);
  return out;
}

async function walk(root, dir, out, maxFiles) {
  if (out.length >= maxFiles) return;
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= maxFiles) return;
    if (entry.name.startsWith(".git") || entry.name === "node_modules" || entry.name === "dist" || entry.name === "build") continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).replace(/\\/g, "/");
    if (entry.isDirectory()) await walk(root, full, out, maxFiles);
    else out.push(rel);
  }
}

async function readPackageJson(root) {
  try {
    return JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

async function readGitRemotes(root) {
  const result = await capture("git", ["remote", "-v"], { cwd: root, timeoutMs: 5000 });
  if (result.code !== 0) return [];
  const remotes = [];
  const seen = new Set();
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!match || match[3] !== "fetch") continue;
    const key = `${match[1]}:${match[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    remotes.push({ name: match[1], url: match[2], host: remoteHost(match[2]) });
  }
  return remotes;
}

function remoteHost(url) {
  if (/gitee\.com[:/]/i.test(url)) return "gitee";
  if (/github\.com[:/]/i.test(url)) return "github";
  if (/gitlab\.com[:/]/i.test(url)) return "gitlab";
  return "";
}

function detectSource(remotes) {
  const hosts = new Set(remotes.map((remote) => remote.host).filter(Boolean));
  if (hosts.has("gitee")) return "gitee";
  if (hosts.has("github")) return "github";
  if (hosts.has("gitlab")) return "gitlab";
  return remotes.length ? "git" : "local";
}

function detectPackageManager(files) {
  if (files.includes("pnpm-lock.yaml")) return "pnpm";
  if (files.includes("yarn.lock")) return "yarn";
  if (files.includes("bun.lockb") || files.includes("bun.lock")) return "bun";
  if (files.includes("package-lock.json")) return "npm";
  return "";
}

function hasDependency(dependencies, name) {
  return Object.prototype.hasOwnProperty.call(dependencies || {}, name);
}

function inferEntrypoints(packageJson, scripts, dependencies) {
  const entries = [];
  if (packageJson?.bin) entries.push({ type: "cli", source: "package.bin", value: packageJson.bin });
  for (const [name, command] of Object.entries(scripts || {})) {
    if (/^(dev|start|server|serve)$/i.test(name)) entries.push({ type: "server", source: `script:${name}`, command });
    if (/electron|tauri/i.test(command) || (name.includes("gui") && hasDependency(dependencies, "electron"))) {
      entries.push({ type: "gui", source: `script:${name}`, command });
    }
    if (/test|smoke|gate|e2e/i.test(name)) entries.push({ type: "test", source: `script:${name}`, command });
  }
  return entries;
}

async function scanAgentSignals(root, files) {
  const candidates = files
    .filter((file) => /\.(mjs|cjs|js|ts|tsx|jsx|py|go|rs|java|kt|json|yaml|yml)$/i.test(file))
    .filter((file) => !/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(file))
    .slice(0, 400);
  const hits = [];
  for (const rel of candidates) {
    let text = "";
    try {
      text = await fs.readFile(path.join(root, rel), "utf8");
    } catch {
      continue;
    }
    const lower = text.slice(0, 200000).toLowerCase();
    const keywords = AGENT_KEYWORDS.filter((keyword) => lower.includes(keyword.toLowerCase()));
    if (keywords.length) hits.push({ file: rel, keywords: [...new Set(keywords)].slice(0, 8) });
  }
  return {
    score: hits.reduce((sum, hit) => sum + hit.keywords.length, 0),
    files: hits.slice(0, 40),
  };
}

function recommendTargets(packageJson, scripts, dependencies, signals) {
  const targets = [];
  if (packageJson?.bin) targets.push("cli");
  if (Object.values(scripts || {}).some((command) => /server|vite|next|hono|express|fastify|listen/i.test(command))) targets.push("http");
  if (hasDependency(dependencies, "electron") || Object.values(scripts || {}).some((command) => /electron/i.test(command))) targets.push("gui");
  if (signals.score > 0) targets.push("provider-contract");
  return [...new Set(targets.length ? targets : ["project-profile"])];
}

function capture(command, args, options = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, options.timeoutMs || 5000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: stderr || error.message });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, signal, stdout, stderr });
    });
  });
}
