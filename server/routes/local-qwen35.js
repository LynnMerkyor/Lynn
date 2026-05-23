/**
 * @deprecated D1: This server-route Path B (Python bootstrap) is being phased out in favor of
 * the Electron-main Path A (LlamaCppManager in desktop/llamacpp-manager.cjs + desktop/model-downloader.cjs).
 *
 * Path A is canonical because:
 *  - No python3 dependency (clean Mac install works out of the box)
 *  - Same llama.cpp binary location across platforms (~/.lynn/llamacpp/bin/)
 *  - Single GGUF location (~/.lynn/models/) avoiding the Path-A vs Path-B model-dir confusion
 *  - LlamaCppManager owns port allocation and restart lifecycle
 *  - Onboarding step can call platform IPC instead of HTTP route
 *
 * This route remains for:
 *  - Backward compat (existing client builds still call /api/local-qwen35-9b/*)
 *  - python3 bootstrap path users who explicitly opted in via env LYNN_LOCAL_QWEN35_USE_BOOTSTRAP=1
 *
 * TODO sprint: migrate LocalModelDownloadStep.tsx to call platform.llamacppStartDownload()
 *              instead of this HTTP route, then mark file for removal.
 */
import { spawn, execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";
import { fromRoot } from "../../shared/hana-root.js";

const execFileAsync = promisify(execFile);
const PROVIDER_ID = "local-qwen35-9b-q4km-imatrix";
const MODEL_ID = "qwen35-9b-q4km-imatrix";

function defaultState() {
  const home = os.homedir();
  return {
    modelRoot: process.env.LYNN_LOCAL_QWEN35_MODEL_ROOT || path.join(home, "Models", "Lynn", "Qwen3.5-9B"),
    providerConfig: process.env.LYNN_LOCAL_QWEN35_PROVIDER_CONFIG || path.join(home, ".lynn-engine", "providers", "qwen35-9b-q4km-imatrix-gguf.json"),
    pidFile: process.env.LYNN_LOCAL_QWEN35_PID_FILE || path.join(home, ".lynn-engine", "run", "qwen35-9b-q4km-imatrix.pid"),
    logFile: process.env.LYNN_LOCAL_QWEN35_LOG_FILE || path.join(home, ".lynn-engine", "logs", "qwen35-9b-q4km-imatrix.client.log"),
    host: process.env.LYNN_LOCAL_QWEN35_HOST || "127.0.0.1",
    port: String(process.env.LYNN_LOCAL_QWEN35_PORT || "18099"),
  };
}

function expectedModelPath(state = defaultState(), variant = "imatrix") {
  const filename = variant === "imatrix"
    ? "Qwen3.5-9B-Q4_K_M-imatrix.gguf"
    : "Qwen3.5-9B-Q4_K_M.gguf";
  return path.join(state.modelRoot, "q4_k_m", filename);
}

function endpointRoot(state = defaultState()) {
  return `http://${state.host}:${state.port}`;
}

function bootstrapPath() {
  const explicit = process.env.LYNN_QWEN35_BOOTSTRAP;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const candidate = fromRoot("scripts", "local_qwen35_9b_client_bootstrap.py");
  return fs.existsSync(candidate) ? candidate : null;
}

function commonArgs(state, variant = "imatrix") {
  return [
    "--variant", variant,
    "--host", state.host,
    "--port", state.port,
    "--model-root", state.modelRoot,
    "--provider-config", state.providerConfig,
    "--pid-file", state.pidFile,
    "--log-file", state.logFile,
  ];
}

function readPidFile(file) {
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    const pid = Number(raw.split(/\s+/)[0]);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function listenerPids(port) {
  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      timeout: 2_000,
      maxBuffer: 32 * 1024,
    });
    return stdout
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((pid) => Number.isFinite(pid) && pid > 0);
  } catch (err) {
    const stdout = String(err?.stdout || "");
    return stdout
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((pid) => Number.isFinite(pid) && pid > 0);
  }
}

async function qwen35ProcessPids(state = defaultState()) {
  const modelPath = expectedModelPath(state, "imatrix");
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="], {
      timeout: 2_000,
      maxBuffer: 512 * 1024,
    });
    return stdout
      .split("\n")
      .map((line) => {
        const match = line.trim().match(/^(\d+)\s+(.+)$/);
        if (!match) return null;
        const pid = Number(match[1]);
        const command = match[2] || "";
        if (!Number.isFinite(pid) || pid <= 0) return null;
        if (!/llama-server(?:\s|$)/.test(command) && !/llama-server\b/.test(command)) return null;
        const mentionsPort = command.includes(`--port ${state.port}`) || command.includes(`:${state.port}`);
        const mentionsModel = command.includes(modelPath)
          || /Qwen3\.5-9B-Q4_K_M/i.test(command)
          || /qwen35-9b-q4km/i.test(command);
        return mentionsPort || mentionsModel ? pid : null;
      })
      .filter((pid) => Number.isFinite(pid) && pid > 0);
  } catch {
    return [];
  }
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 900);
  try {
    return await fetch(url, { signal: controller.signal, ...options });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJsonMaybe(url, timeoutMs = 900) {
  try {
    const res = await fetchWithTimeout(url, { timeoutMs });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchJsonStatus(url, timeoutMs = 900) {
  try {
    const res = await fetchWithTimeout(url, { timeoutMs });
    const text = await res.text().catch(() => "");
    let json = null;
    if (text) {
      try { json = JSON.parse(text); } catch {}
    }
    return { ok: res.ok, status: res.status, json };
  } catch {
    return { ok: false, status: 0, json: null };
  }
}

async function fetchTextMaybe(url, timeoutMs = 900) {
  try {
    const res = await fetchWithTimeout(url, { timeoutMs });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function summarizeSlots(slots) {
  if (!Array.isArray(slots)) return null;
  const summaries = slots.map((slot) => ({
    id: slot.id ?? slot.id_slot ?? null,
    state: slot.state ?? null,
    prompt_tokens: slot.n_prompt_tokens_processed ?? slot.n_prompt_tokens ?? slot.prompt_tokens ?? null,
    predicted_tokens: slot.n_decoded ?? slot.n_predict ?? slot.predicted_tokens ?? null,
    progress: typeof slot.progress === "number" ? slot.progress : null,
  }));
  return {
    total: summaries.length,
    busy: summaries.filter((slot) => slot.state && !String(slot.state).toLowerCase().includes("idle")).length,
    slots: summaries.slice(0, 8),
  };
}

function parseMetrics(text) {
  if (!text) return null;
  const pick = (patterns) => {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const value = Number(match[1]);
        if (Number.isFinite(value)) return value;
      }
    }
    return null;
  };
  return {
    prompt_tokens_total: pick([
      /(?:^|\n)llamacpp:prompt_tokens_total\s+([0-9.]+)/,
      /(?:^|\n).*prompt.*tokens.*total\s+([0-9.]+)/i,
    ]),
    predicted_tokens_total: pick([
      /(?:^|\n)llamacpp:tokens_predicted_total\s+([0-9.]+)/,
      /(?:^|\n).*predicted.*tokens.*total\s+([0-9.]+)/i,
      /(?:^|\n).*completion.*tokens.*total\s+([0-9.]+)/i,
    ]),
    requests_total: pick([
      /(?:^|\n)llamacpp:requests_total\s+([0-9.]+)/,
      /(?:^|\n).*requests.*total\s+([0-9.]+)/i,
    ]),
  };
}

async function runtimeDetails() {
  const state = defaultState();
  const root = endpointRoot(state);
  const pidFromFile = readPidFile(state.pidFile);
  const [listenPids, commandPids] = await Promise.all([
    listenerPids(state.port),
    qwen35ProcessPids(state),
  ]);
  const pids = [...new Set([...listenPids, ...commandPids])];
  const pid = pidFromFile && pids.includes(pidFromFile) ? pidFromFile : (pids[0] || pidFromFile || null);
  const [healthStatus, models, slots, metricsText] = await Promise.all([
    fetchJsonStatus(`${root}/health`),
    fetchJsonMaybe(`${root}/v1/models`),
    fetchJsonMaybe(`${root}/slots`),
    fetchTextMaybe(`${root}/metrics`),
  ]);
  const health = healthStatus.ok ? healthStatus.json : null;
  const endpointRunning = healthStatus.ok === true;
  const endpointLoading = !endpointRunning && pids.length > 0
    && (healthStatus.status === 503 || /loading/i.test(String(healthStatus.json?.error?.message || "")));
  const modelIds = Array.isArray(models?.data)
    ? models.data.map((item) => item?.id).filter(Boolean)
    : [];
  return {
    base_url: `${root}/v1`,
    gui_url: root,
    pid,
    pid_file: state.pidFile,
    process_alive: isPidAlive(pid),
    listen_pids: listenPids,
    command_pids: commandPids,
    pids,
    endpoint_running: endpointRunning,
    endpoint_loading: endpointLoading,
    health_status: healthStatus.status,
    health,
    model_ids: modelIds,
    slots: summarizeSlots(slots),
    metrics: parseMetrics(metricsText),
    metrics_available: !!metricsText,
    checked_at: new Date().toISOString(),
  };
}

function fastReadyPlan(runtime, variant = "imatrix") {
  const state = defaultState();
  const totalMemoryGib = os.totalmem() / (1024 ** 3);
  const isMac = process.platform === "darwin";
  const chip = isMac ? os.cpus()?.[0]?.model || "Apple Silicon" : os.cpus()?.[0]?.model || null;
  const comfortable = isMac && totalMemoryGib >= 24;
  const usable = totalMemoryGib >= 8;
  const ctxSize = comfortable ? 32768 : 8192;
  const parallel = comfortable ? 1 : 1;
  const modelPath = expectedModelPath(state, variant);
  return {
    ok: true,
    provider_id: PROVIDER_ID,
    model: MODEL_ID,
    plan: {
      decision: runtime.endpoint_running ? "ready" : runtime.endpoint_loading ? "loading" : "inspect",
      base_url: runtime.base_url,
      observed: {
        endpoint_running: runtime.endpoint_running === true,
        endpoint_loading: runtime.endpoint_loading === true,
        gguf: fs.existsSync(modelPath) ? modelPath : null,
        llama_server: (runtime.endpoint_running || runtime.endpoint_loading || runtime.process_alive) ? "llama-server" : null,
        homebrew_available: null,
      },
      hardware: {
        can_enable: usable,
        recommendation: usable ? "recommended" : "not_recommended",
        chip,
        total_memory_gib: totalMemoryGib,
        gpus: [],
        recommended_runtime: {
          name: comfortable ? "mac_unified_32k" : "local_qwen35_compact",
          label: comfortable ? "Mac 32K 舒适档" : "8K 入门档",
          ctx_size: ctxSize,
          parallel,
          gpu_layers: isMac ? 999 : 0,
        },
        warnings: usable ? [] : ["当前内存低于 8GB，不建议启用本地 9B。"],
        blockers: [],
        upgrade_options: [
          ...(totalMemoryGib >= 24 ? [{
            id: "qwen36-35b-a3b-q4km-imatrix",
            label: "Qwen3.6-35B-A3B Q4_K_M imatrix",
            profile: "24GB 显存+ 推荐 · 性能强",
            metrics: ["thinking-on 32K", "MMLU 90.40%", "GPQA Diamond 80.70%", "R6000 207 tok/s"],
            reason: "Lynn 可直接下载并校验；下载完成后可一键启动，也可导入已有 GGUF。",
            modelscope_url: "https://modelscope.cn/models/Merkyor/Qwen3.6-35B-A3B-GGUF-imatrix",
            download_label: "下载到本机",
            file_name: "Qwen3.6-35B-A3B-Q4_K_M-imatrix.gguf",
          }] : []),
        ],
      },
      actions: [],
    },
  };
}

function parseJson(text) {
  try { return JSON.parse(text); } catch {}
  const end = text.lastIndexOf("}");
  if (end <= 0) return null;
  for (let start = text.lastIndexOf("{", end); start >= 0; start = text.lastIndexOf("{", start - 1)) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {}
  }
  return null;
}

function readLogTail(file, maxBytes = 96 * 1024) {
  if (!file || !fs.existsSync(file)) return "";
  try {
    const stat = fs.statSync(file);
    const size = Math.min(stat.size, maxBytes);
    const fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, Math.max(0, stat.size - size));
    fs.closeSync(fd);
    return buffer.toString("utf8");
  } catch {
    return "";
  }
}

function parseDownloadProgress(text) {
  const chunks = text.split(/\r|\n/).map((line) => line.trim()).filter(Boolean);
  const downloadRegex = /Downloading\s+\[[^\]]+\]:\s*(\d{1,3})%\|[^|]*\|\s*([^/\s]+)\/([^\s]+)\s*\[([^<\]]+)<([^,\]]+),\s*([^\]]+)\]/;
  for (let i = chunks.length - 1; i >= 0; i -= 1) {
    const match = chunks[i].match(downloadRegex);
    if (!match) continue;
    return {
      phase: "下载模型（ModelScope）",
      source: "modelscope",
      percent: Math.max(0, Math.min(100, Number(match[1]))),
      downloaded: match[2],
      total: match[3],
      elapsed: match[4],
      eta: match[5],
      speed: match[6],
      message: chunks[i].replace(/\s+/g, " "),
    };
  }
  return null;
}

function parseJobProgress(job) {
  if (!job?.log_file) return null;
  const text = readLogTail(job.log_file);
  if (!text) return null;
  const chunks = text.split(/\r|\n/).map((line) => line.trim()).filter(Boolean);
  const tail = chunks
    .filter((line) => !line.startsWith("Downloading [") || /100%\|/.test(line))
    .slice(-8);
  const download = parseDownloadProgress(text);
  if (download) return { ...download, tail };

  let phase = "准备本地模型";
  let percent = null;
  let source = null;
  if (/installing llama\.cpp|Installing llama\.cpp|Pouring llama\.cpp/i.test(text)) {
    phase = "安装 llama.cpp";
    percent = 10;
  }
  if (/downloading via Lynn CDN/i.test(text)) {
    phase = "下载模型（Lynn CDN）";
    source = "lynn-cdn";
    percent = 25;
  }
  if (/downloading via ModelScope/i.test(text)) {
    phase = "连接 ModelScope 下载";
    source = "modelscope";
    percent = 25;
  }
  if (/Running llama\.cpp smoke|smoke/i.test(text)) {
    phase = "验证本地模型";
    percent = 88;
  }
  if (/starting llama\.cpp|server started|llama-server/i.test(text) && /smoke/i.test(text)) {
    phase = "启动本地端点";
    percent = 94;
  }
  if (job.status === "succeeded") {
    phase = "本地模型已就绪";
    percent = 100;
  }
  if (job.status === "failed") {
    phase = "准备失败";
  }
  return {
    phase,
    source,
    percent,
    tail,
    message: tail[tail.length - 1] || phase,
  };
}

function decorateJob(job) {
  if (!job) return null;
  return {
    ...job,
    progress: parseJobProgress(job),
  };
}

// Cache python3 availability check across requests (resets on process restart)
let _python3CheckResult = null;
async function ensurePython3() {
  if (_python3CheckResult !== null) return _python3CheckResult;
  try {
    await execFileAsync("python3", ["--version"], { timeout: 5_000 });
    _python3CheckResult = { ok: true };
  } catch (err) {
    _python3CheckResult = {
      ok: false,
      error: "python3_not_found",
      detail: "python3 executable not in PATH. On macOS install via Homebrew (brew install python3) or python.org installer. Lynn local model setup needs python3 to run the bootstrap script.",
      raw: err.message,
    };
  }
  return _python3CheckResult;
}

async function plan(variant = "imatrix") {
  const bootstrap = bootstrapPath();
  const state = defaultState();
  if (!bootstrap) {
    return {
      ok: false,
      error: "bootstrap_not_found",
      searched: [fromRoot("scripts", "local_qwen35_9b_client_bootstrap.py")],
      provider_id: PROVIDER_ID,
      fallback_provider: "brain",
    };
  }
  const pyCheck = await ensurePython3();
  if (!pyCheck.ok) {
    return {
      ok: false,
      provider_id: PROVIDER_ID,
      fallback_provider: "brain",
      ...pyCheck,
    };
  }
  try {
    const { stdout } = await execFileAsync("python3", [bootstrap, "plan", ...commonArgs(state, variant)], {
      cwd: fromRoot(),
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return {
      ok: true,
      provider_id: PROVIDER_ID,
      model: MODEL_ID,
      bootstrap,
      plan: parseJson(stdout),
    };
  } catch (err) {
    return {
      ok: false,
      provider_id: PROVIDER_ID,
      bootstrap,
      error: err.message,
      stdout: err.stdout || "",
      stderr: err.stderr || "",
    };
  }
}

async function registerProvider(engine, options = {}) {
  const state = defaultState();
  engine.providerRegistry.saveProvider(PROVIDER_ID, {
    display_name: "本地 Qwen3.5-9B",
    base_url: `http://${state.host}:${state.port}/v1`,
    api: "openai-completions",
    auth_type: "none",
    models: [{
      id: MODEL_ID,
      name: "Qwen3.5-9B Q4_K_M imatrix",
      context: 32768,
      maxOutput: 32768,
    }],
  });
  await engine.syncModelsAndRefresh?.();
  await engine.refreshAvailableModels?.();
  if (options.activate) {
    await engine.setPendingModel?.(MODEL_ID, PROVIDER_ID);
  }
  return true;
}

function isReadyPlan(planData) {
  const observed = planData?.plan?.observed || planData?.observed || {};
  return observed.endpoint_running === true
    && !!observed.gguf
    && !!observed.llama_server;
}

function isProviderRegistered(engine) {
  const raw = engine.providerRegistry?.getAllProvidersRaw?.() || {};
  const entry = raw[PROVIDER_ID];
  return !!entry?.models?.some?.((m) => (typeof m === "object" ? m.id : m) === MODEL_ID);
}

export function createLocalQwen35Route(engine) {
  const route = new Hono();
  let job = null;

  route.get("/local-qwen35-9b/status", async (c) => {
    const runtime = await runtimeDetails();
    const status = (runtime.endpoint_running || runtime.endpoint_loading || runtime.process_alive)
      ? fastReadyPlan(runtime)
      : await plan();
    const registered = isProviderRegistered(engine);
    return c.json({ ...status, registered_provider: registered, runtime, job: decorateJob(job) });
  });

  route.post("/local-qwen35-9b/setup", async (c) => {
    const body = await safeJson(c);
    const authorized = body.authorized === true || body.yesUserAuthorized === true;
    if (!authorized) {
      return c.json({
        ok: false,
        error: "missing_user_authorization",
        message: "客户端必须在用户授权后传 authorized:true，才会安装、下载或启动本地模型。",
      }, 403);
    }
    if (job?.status === "running") return c.json({ ok: true, already_running: true, job: decorateJob(job) }, 202);

    const bootstrap = bootstrapPath();
    const state = defaultState();
    if (!bootstrap) return c.json({ ok: false, error: "bootstrap_not_found" }, 503);

    fs.mkdirSync(path.dirname(state.logFile), { recursive: true });
    const logFile = path.join(path.dirname(state.logFile), `qwen35-9b-setup-${Date.now()}.log`);
    const args = [
      bootstrap,
      "execute",
      ...commonArgs(state, body.variant || "imatrix"),
      "--yes-user-authorized",
    ];
    if (body.start !== false) args.push("--start");
    if (body.installRuntime === false) args.push("--no-install-runtime");

    job = {
      id: "local-qwen35-setup-" + Date.now(),
      status: "running",
      started_at: new Date().toISOString(),
      finished_at: null,
      log_file: logFile,
      provider_id: PROVIDER_ID,
      model: MODEL_ID,
      exit_code: null,
      result: null,
    };

    const child = spawn("python3", args, { cwd: fromRoot(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const append = (chunk) => {
      try { fs.appendFileSync(logFile, chunk); } catch {}
    };
    child.stdout.on("data", (buf) => { const s = buf.toString(); stdout += s; append(s); });
    child.stderr.on("data", (buf) => { const s = buf.toString(); stderr += s; append(s); });
    child.on("exit", async (code) => {
      const result = parseJson(stdout);
      let registered = false;
      let registerError = null;
      const finalStatus = code === 0 && !isReadyPlan(result?.status)
        ? await plan(body.variant || "imatrix").catch(() => null)
        : null;
      if (code === 0 && (isReadyPlan(result?.status) || isReadyPlan(finalStatus))) {
        try {
          await registerProvider(engine, { activate: true });
          registered = true;
        } catch (err) {
          registerError = err.message;
        }
      } else if (code === 0) {
        registerError = "endpoint_not_ready";
      }
      job = {
        ...job,
        status: code === 0 && !registerError ? "succeeded" : "failed",
        finished_at: new Date().toISOString(),
        exit_code: code,
        result,
        registered,
        register_error: registerError,
        stdout_tail: stdout.slice(-4000),
        stderr_tail: stderr.slice(-4000),
      };
    });
    return c.json({ ok: true, job: decorateJob(job) }, 202);
  });

  route.post("/local-qwen35-9b/register", async (c) => {
    const status = await plan();
    if (!isReadyPlan(status)) {
      return c.json({
        ok: false,
        error: "endpoint_not_ready",
        message: "本地 9B 端点还没有通过 /health 和 /v1/models 就绪检查，暂不注册。",
        status,
      }, 409);
    }
    await registerProvider(engine, { activate: true });
    return c.json({ ok: true, provider_id: PROVIDER_ID, model: MODEL_ID });
  });

  route.post("/local-qwen35-9b/stop", async (c) => {
    const state = defaultState();
    const before = await runtimeDetails();
    const targets = new Set([
      ...before.pids,
      readPidFile(state.pidFile),
    ].filter((pid) => Number.isFinite(pid) && pid > 0));

    for (const pid of targets) {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 800));

    let remaining = [...new Set([
      ...await listenerPids(state.port),
      ...await qwen35ProcessPids(state),
    ])];
    if (remaining.length > 0) {
      for (const pid of remaining) {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
      remaining = [...new Set([
        ...await listenerPids(state.port),
        ...await qwen35ProcessPids(state),
      ])];
    }
    try { fs.rmSync(state.pidFile, { force: true }); } catch {}

    return c.json({
      ok: remaining.length === 0,
      stopped_pids: [...targets],
      remaining_pids: remaining,
      before,
      runtime: await runtimeDetails(),
    });
  });

  return route;
}
