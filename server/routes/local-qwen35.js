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

function parseJson(text) {
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  return null;
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

function registerProvider(engine) {
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
  return engine.syncModelsAndRefresh?.();
}

export function createLocalQwen35Route(engine) {
  const route = new Hono();
  let job = null;

  route.get("/local-qwen35-9b/status", async (c) => {
    const status = await plan();
    return c.json({ ...status, job });
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
    if (job?.status === "running") return c.json({ ok: true, already_running: true, job }, 202);

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
      if (code === 0) {
        try {
          await registerProvider(engine);
          registered = true;
        } catch (err) {
          registerError = err.message;
        }
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
    return c.json({ ok: true, job }, 202);
  });

  route.post("/local-qwen35-9b/register", async (c) => {
    await registerProvider(engine);
    return c.json({ ok: true, provider_id: PROVIDER_ID, model: MODEL_ID });
  });

  return route;
}
