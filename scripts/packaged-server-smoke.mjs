#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import YAML from "js-yaml";

const root = process.cwd();
const READY_TIMEOUT_MS = Number(process.env.LYNN_PACKAGED_SERVER_TIMEOUT_MS || 60_000);

function stringArg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function exists(p) {
  try {
    return !!p && fs.existsSync(p);
  } catch {
    return false;
  }
}

function findPackagedApp() {
  const explicit = stringArg("--app");
  if (explicit) return path.resolve(explicit);
  const candidates = [
    path.join(root, "dist", "mac-arm64", "Lynn.app"),
    path.join(root, "dist", "mac", "Lynn.app"),
    "/Applications/Lynn.app",
  ];
  return candidates.find((candidate) => exists(candidate)) || null;
}

function resolveServerRuntime(appPath) {
  if (!appPath) {
    throw new Error("[packaged-server-smoke] missing packaged app. Run electron-builder first, or pass --app <Lynn.app>");
  }
  if (process.platform !== "darwin" && !appPath.endsWith(".app")) {
    throw new Error(`[packaged-server-smoke] unsupported packaged app path: ${appPath}`);
  }
  const resourcesDir = path.join(appPath, "Contents", "Resources");
  const serverDir = path.join(resourcesDir, "server");
  const nodeBin = path.join(serverDir, "node");
  const wrapper = path.join(serverDir, "lynn-server");
  const entry = path.join(serverDir, "bundle", "index.js");
  if (exists(nodeBin) && exists(entry)) {
    return { appPath, resourcesDir, serverDir, command: nodeBin, args: [entry], probeCommand: nodeBin };
  }
  if (exists(wrapper)) {
    return { appPath, resourcesDir, serverDir, command: wrapper, args: [], probeCommand: null };
  }
  throw new Error(`[packaged-server-smoke] missing packaged server runtime under ${serverDir}`);
}

function tail(text, lines = 40) {
  return String(text || "").split(/\n/).filter(Boolean).slice(-lines).join("\n");
}

async function waitForFile(filePath, child, logs) {
  const started = Date.now();
  while (Date.now() - started < READY_TIMEOUT_MS) {
    if (exists(filePath)) return;
    if (child.exitCode !== null) {
      throw new Error(`[packaged-server-smoke] server exited early code=${child.exitCode}\n${tail(logs.value)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`[packaged-server-smoke] timed out waiting for ${filePath}\n${tail(logs.value)}`);
}

async function terminate(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      resolve();
    }, 8_000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    try { child.kill("SIGTERM"); } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function runProbe(runtime) {
  if (!runtime.probeCommand) return;
  await new Promise((resolve, reject) => {
    const child = spawn(runtime.probeCommand, [
      "-e",
      "console.log(process.version, process.versions.modules, process.arch); require('better-sqlite3'); console.log('better-sqlite3 ok')",
    ], {
      cwd: runtime.serverDir,
      env: { ...process.env, HANA_ROOT: runtime.serverDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.on("close", (code) => {
      if (code === 0) {
        console.log(`[packaged-server-smoke] native probe ok: ${output.trim().replace(/\n/g, " | ")}`);
        resolve();
      } else {
        reject(new Error(`[packaged-server-smoke] native probe failed code=${code}\n${output}`));
      }
    });
  });
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

async function writeYaml(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, YAML.dump(value, {
    indent: 2,
    lineWidth: -1,
    sortKeys: false,
    noRefs: true,
  }), "utf-8");
}

async function readYamlObject(file) {
  try {
    return YAML.load(await fsp.readFile(file, "utf-8")) || {};
  } catch {
    return {};
  }
}

async function main() {
  const runtime = resolveServerRuntime(findPackagedApp());
  console.log(`[packaged-server-smoke] app=${runtime.appPath}`);
  await runProbe(runtime);

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "lynn-packaged-server-"));
  const fakeHome = path.join(tmp, "home");
  const hanakoHome = path.join(fakeHome, ".hanako");
  const lynnHome = path.join(fakeHome, ".lynn");
  const pollutedAgentDir = path.join(lynnHome, "agents", "lynn");
  await fsp.mkdir(path.join(hanakoHome, "agents", "hanako", "memory"), { recursive: true });
  await fsp.writeFile(path.join(hanakoHome, "SENTINEL.txt"), "openhanako-data-do-not-copy\n", "utf-8");
  await writeYaml(path.join(pollutedAgentDir, "config.yaml"), {
    agent: { name: "Lynn", yuan: "lynn" },
    api: { provider: "mimo" },
    models: {
      chat: { id: "mimo-v2.5-pro", provider: "mimo" },
      utility: "token-plan-cn",
    },
  });
  await writeYaml(path.join(lynnHome, "added-models.yaml"), {
    _migrated: true,
    providers: {
      mimo: {
        api_key: "sk-test",
        base_url: "https://token-plan-cn.xiaomimimo.com/v1",
        api: "openai-completions",
        models: ["mimo-v2.5-pro", "still-valid-model"],
      },
    },
  });
  await writeJson(path.join(lynnHome, "user", "preferences.json"), {
    utility_model: { id: "mimo-v2.5-pro", provider: "mimo" },
  });
  await writeJson(path.join(pollutedAgentDir, "sessions", "session-meta.json"), {
    "old.jsonl": {
      model: { id: "mimo-v2.5-pro", provider: "mimo" },
    },
  });

  const env = {
    ...process.env,
    HOME: fakeHome,
    HANA_HOME: hanakoHome,
    HANA_PORT: "0",
    HANA_ROOT: runtime.serverDir,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
  };
  delete env.LYNN_HOME;

  const logs = { value: "" };
  const child = spawn(runtime.command, runtime.args, {
    cwd: runtime.serverDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { logs.value += String(chunk); });
  child.stderr.on("data", (chunk) => { logs.value += String(chunk); });

  try {
    const serverInfoPath = path.join(lynnHome, "server-info.json");
    await waitForFile(serverInfoPath, child, logs);
    const info = JSON.parse(await fsp.readFile(serverInfoPath, "utf-8"));
    const res = await fetch(`http://127.0.0.1:${info.port}/api/health`, {
      headers: { Authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(5_000),
    });
    const health = res.ok ? await res.json().catch(() => null) : null;
    if (!res.ok || health?.status !== "ok") {
      throw new Error(`[packaged-server-smoke] health failed status=${res.status} body=${JSON.stringify(health)}`);
    }
    if (exists(path.join(lynnHome, "SENTINEL.txt"))) {
      throw new Error("[packaged-server-smoke] ~/.hanako sentinel was copied into ~/.lynn");
    }
    if (exists(path.join(hanakoHome, "server-info.json"))) {
      throw new Error("[packaged-server-smoke] server wrote runtime state into HANA_HOME");
    }
    const config = await readYamlObject(path.join(pollutedAgentDir, "config.yaml"));
    const added = await readYamlObject(path.join(lynnHome, "added-models.yaml"));
    const prefs = JSON.parse(await fsp.readFile(path.join(lynnHome, "user", "preferences.json"), "utf-8"));
    const meta = JSON.parse(await fsp.readFile(path.join(pollutedAgentDir, "sessions", "session-meta.json"), "utf-8"));
    if (config?.api?.provider !== "mimo" || config?.models?.chat?.provider !== "mimo" || config?.models?.chat?.id !== "mimo-v2.5-pro") {
      throw new Error(`[packaged-server-smoke] MiMo Token Plan chat model was incorrectly repaired: ${JSON.stringify(config?.models?.chat)}`);
    }
    if (config?.models?.utility?.provider !== "brain" || config?.models?.utility?.id !== "lynn-brain-router") {
      throw new Error(`[packaged-server-smoke] retired token-plan-cn utility was not repaired: ${JSON.stringify(config?.models?.utility)}`);
    }
    if (prefs?.utility_model?.provider !== "mimo" || prefs?.utility_model?.id !== "mimo-v2.5-pro") {
      throw new Error(`[packaged-server-smoke] valid MiMo preference was incorrectly repaired: ${JSON.stringify(prefs?.utility_model)}`);
    }
    const mimoModels = added?.providers?.mimo?.models || [];
    if (!added?.providers?.mimo?.api_key || !mimoModels.includes("mimo-v2.5-pro") || !mimoModels.includes("still-valid-model")) {
      throw new Error(`[packaged-server-smoke] valid MiMo provider models were not preserved: ${JSON.stringify(added?.providers?.mimo)}`);
    }
    if (meta?.["old.jsonl"]?.model?.provider !== "mimo" || meta?.["old.jsonl"]?.model?.id !== "mimo-v2.5-pro") {
      throw new Error(`[packaged-server-smoke] valid MiMo session meta was incorrectly repaired: ${JSON.stringify(meta?.["old.jsonl"])}`);
    }
    console.log("[packaged-server-smoke] packaged server booted, health ok, HANA_HOME ignored, .hanako not copied, retired token-plan-cn repaired, MiMo Token Plan preserved");
  } finally {
    await terminate(child);
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
