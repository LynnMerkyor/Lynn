/**
 * model-downloader.cjs · Lynn V0.79 onboarding 2026-05-21
 *
 * 跨平台大文件下载守护 — Qwen3.5-9B Q4_K_M-imatrix 5.3 GB GGUF。
 *
 * 设计要点：
 *   1. HTTP/HTTPS Range 续传(用 .part 临时文件 + 已下载 byte offset)。
 *   2. 多源 fallback：ModelScope(国内默认) → hf-mirror.com(国内 HF 镜像备选)。
 *      任一源 4xx/5xx/timeout 自动 rotate 到下一个,**保留已下载字节**继续 range。
 *      不放腾讯镜像作为模型源 — 模型权重统一从公开发布镜像拉,腾讯只做客户端 dmg/exe。
 *   3. SHA-256 校验：streamed 增量算 hash,文件落地后比对 expected;
 *      不匹配 → 删 .part + 整源 fallback;全 fail → emit "checksum-failed"。
 *   4. EventEmitter:'progress'(每 250ms / 256 KiB) | 'state'(needs-source/downloading/verifying/done/error)
 *      | 'log'(level, msg)。Main 桥到 renderer。
 *   5. 暂停/继续:pause() 关 socket + 保留 .part;resume() 续传(用 If-Range / Range)。
 *   6. 不引入第三方下载库(axios/got/aria2),用 native http/https 满足 build size。
 *
 * 默认目标(可被 opts.target 覆盖):
 *   ~/.lynn/models/qwen3.5-9b-q4km-imatrix.gguf
 *
 * 默认源(可被 opts.sources 覆盖,顺序 = 国内优先):
 *   - https://modelscope.cn/models/Merkyor/Qwen3.5-9B-GGUF-imatrix/resolve/master/Qwen3.5-9B-Q4_K_M-imatrix.gguf  (国内主源)
 *   - https://hf-mirror.com/nerkyor/Qwen3.5-9B-GGUF-imatrix/resolve/main/Qwen3.5-9B-Q4_K_M-imatrix.gguf          (国内 HF 镜像备)
 *
 * sha256: 9437f5bf0dd0c97800caaf902f41e6a6aa00223ab232f159eda41dcbbb492645
 * size:   5_300_000_000 bytes (期望,允许 ±0.5% 偏差,实际以 sha256 为准)
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { URL } = require("url");
const { EventEmitter } = require("events");

// ─────────────────────────────────────────────────────────────
// 默认配置
// ─────────────────────────────────────────────────────────────

const DEFAULT_FILE_NAME = "qwen3.5-9b-q4km-imatrix.gguf";
const DEFAULT_EXPECTED_SIZE = 5_300_000_000;
const DEFAULT_EXPECTED_SHA256 = "9437f5bf0dd0c97800caaf902f41e6a6aa00223ab232f159eda41dcbbb492645";

const DEFAULT_SOURCES = Object.freeze([
  {
    id: "modelscope",
    label: "ModelScope (国内主源)",
    url: "https://modelscope.cn/models/Merkyor/Qwen3.5-9B-GGUF-imatrix/resolve/master/Qwen3.5-9B-Q4_K_M-imatrix.gguf",
  },
  {
    id: "hf-mirror",
    label: "hf-mirror.com (国内 HF 镜像)",
    url: "https://hf-mirror.com/nerkyor/Qwen3.5-9B-GGUF-imatrix/resolve/main/Qwen3.5-9B-Q4_K_M-imatrix.gguf",
  },
]);

const PROGRESS_THROTTLE_MS = 250;
const PROGRESS_THROTTLE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

// ─────────────────────────────────────────────────────────────
// 路径工具
// ─────────────────────────────────────────────────────────────

function defaultLynnRoot(homeDir) {
  return path.join(homeDir, ".lynn");
}

function defaultModelPath(homeDir, fileName) {
  return path.join(defaultLynnRoot(homeDir), "models", fileName);
}

function ensureDirSync(dirPath) {
  try { fs.mkdirSync(dirPath, { recursive: true }); } catch (err) {
    if (err && err.code !== "EEXIST") throw err;
  }
}

function safeStatSize(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? st.size : 0;
  } catch { return 0; }
}

// ─────────────────────────────────────────────────────────────
// ModelDownloader
// ─────────────────────────────────────────────────────────────

class ModelDownloader extends EventEmitter {
  constructor(opts = {}) {
    super();
    const homeDir = opts.homeDir || os.homedir();
    const fileName = opts.fileName || DEFAULT_FILE_NAME;
    this.target = opts.target || defaultModelPath(homeDir, fileName);
    this.partPath = `${this.target}.part`;
    this.expectedSize = opts.expectedSize || DEFAULT_EXPECTED_SIZE;
    this.expectedSha256 = (opts.expectedSha256 || DEFAULT_EXPECTED_SHA256).toLowerCase();
    this.sources = Array.isArray(opts.sources) && opts.sources.length > 0
      ? opts.sources.map(s => ({ id: s.id, label: s.label || s.id, url: s.url }))
      : DEFAULT_SOURCES.map(s => ({ ...s }));

    // runtime state
    this.activeRequest = null;
    this.activeStream = null;
    this.activeHash = null;
    this.activeSourceIndex = -1;
    this.bytesTransferred = 0;
    this.totalBytes = 0;
    this.state = "idle"; // idle | downloading | verifying | done | error | paused
    this.paused = false;
    this.aborted = false;
    this.lastEmitTs = 0;
    this.lastEmitBytes = 0;
    this.startedAt = 0;
    this.lastError = null;
    this.activeSourceLabel = null;
    this.attemptedSources = new Set();
  }

  // ── public API ──

  /** Start (or resume) download. Resolves when verified file is at target. */
  start() {
    if (this.state === "downloading" || this.state === "verifying") {
      return Promise.resolve({ ok: false, reason: "already-running" });
    }
    this.aborted = false;
    this.paused = false;
    this.lastError = null;
    this.attemptedSources.clear();
    return new Promise((resolve) => {
      this._finishResolve = resolve;
      try {
        // If target already exists & matches sha256, short-circuit.
        if (fs.existsSync(this.target)) {
          this._setState("verifying", { sourceLabel: null, finalCheck: true });
          this._verifyExistingTarget()
            .then((ok) => {
              if (ok) {
                this._setState("done", { sourceLabel: null });
                this._finish({ ok: true });
              } else {
                // remove stale + restart
                try { fs.rmSync(this.target, { force: true }); } catch {}
                this._beginNextSource();
              }
            })
            .catch((err) => this._fail(`existing-verify-error: ${err?.message || err}`));
          return;
        }
        this._beginNextSource();
      } catch (err) {
        this._fail(`start-error: ${err?.message || err}`);
      }
    });
  }

  /** Cancel + leave .part on disk for later resume. */
  pause() {
    if (this.state !== "downloading") return;
    this.paused = true;
    this._setState("paused");
    this._teardownActive();
  }

  /** Cancel + delete .part. */
  cancel() {
    this.aborted = true;
    this.paused = false;
    this._teardownActive();
    try { fs.rmSync(this.partPath, { force: true }); } catch {}
    this._setState("idle");
    if (this._finishResolve) {
      this._finishResolve({ ok: false, reason: "cancelled" });
      this._finishResolve = null;
    }
  }

  /** Snapshot of current progress. Safe to call any time. */
  getState() {
    return {
      state: this.state,
      bytesTransferred: this.bytesTransferred,
      totalBytes: this.totalBytes,
      percent: this.totalBytes > 0
        ? Math.min(100, Math.floor((this.bytesTransferred / this.totalBytes) * 100))
        : 0,
      activeSource: this.activeSourceLabel,
      target: this.target,
      partPath: this.partPath,
      paused: this.paused,
      lastError: this.lastError,
    };
  }

  // ── source rotation ──

  _beginNextSource() {
    if (this.aborted) return;
    // Find next un-attempted source.
    const nextIdx = this.sources.findIndex((s, idx) => idx > this.activeSourceIndex && !this.attemptedSources.has(s.id));
    if (nextIdx === -1) {
      // try first un-attempted from start (rotation)
      const firstFresh = this.sources.findIndex((s) => !this.attemptedSources.has(s.id));
      if (firstFresh === -1) {
        this._fail("all-sources-failed");
        return;
      }
      this.activeSourceIndex = firstFresh;
    } else {
      this.activeSourceIndex = nextIdx;
    }
    const src = this.sources[this.activeSourceIndex];
    this.attemptedSources.add(src.id);
    this.activeSourceLabel = src.label;
    this._log("info", `[download] starting source=${src.label} url=${src.url}`);
    this._setState("downloading", { sourceLabel: src.label });
    this._downloadFromSource(src.url, 0).catch((err) => {
      this._log("warn", `[download] source ${src.label} failed: ${err?.message || err}`);
      this._teardownActive();
      this._beginNextSource();
    });
  }

  async _downloadFromSource(urlStr, redirectsLeft) {
    if (this.aborted || this.paused) return;
    ensureDirSync(path.dirname(this.target));
    const existingPartSize = safeStatSize(this.partPath);
    this.bytesTransferred = existingPartSize;
    // Hash must include the bytes already on disk if any.
    this.activeHash = crypto.createHash("sha256");
    if (existingPartSize > 0) {
      try {
        await this._rehashExisting();
      } catch (err) {
        // hash setup failed — restart .part
        this._log("warn", `[download] rehash failed, restarting: ${err?.message || err}`);
        try { fs.rmSync(this.partPath, { force: true }); } catch {}
        this.bytesTransferred = 0;
        this.activeHash = crypto.createHash("sha256");
      }
    }

    const url = new URL(urlStr);
    const lib = url.protocol === "http:" ? http : https;
    const headers = { "User-Agent": "Lynn-Desktop/0.79 (model-downloader)" };
    if (this.bytesTransferred > 0) {
      headers["Range"] = `bytes=${this.bytesTransferred}-`;
    }

    const req = lib.get({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === "http:" ? 80 : 443),
      path: url.pathname + url.search,
      headers,
      timeout: REQUEST_TIMEOUT_MS,
    });
    this.activeRequest = req;

    return new Promise((resolve, reject) => {
      req.on("response", (res) => {
        if (this.aborted) {
          try { res.destroy(); } catch {}
          return resolve();
        }
        // Redirect
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirectsLeft >= MAX_REDIRECTS) {
            try { res.destroy(); } catch {}
            return reject(new Error("too-many-redirects"));
          }
          try { res.destroy(); } catch {}
          const next = new URL(res.headers.location, url).toString();
          this._log("info", `[download] redirect → ${next}`);
          this._downloadFromSource(next, redirectsLeft + 1).then(resolve, reject);
          return;
        }
        // Range mismatch -> server doesn't support resume, restart .part
        if (this.bytesTransferred > 0 && res.statusCode === 200) {
          // server ignored range, restart from scratch
          this._log("warn", "[download] server returned 200 (no range support) — restarting .part");
          try { fs.rmSync(this.partPath, { force: true }); } catch {}
          this.bytesTransferred = 0;
          this.activeHash = crypto.createHash("sha256");
        } else if (res.statusCode !== 200 && res.statusCode !== 206) {
          try { res.destroy(); } catch {}
          return reject(new Error(`http ${res.statusCode}`));
        }

        const contentLength = parseInt(res.headers["content-length"] || "0", 10) || 0;
        if (res.statusCode === 206) {
          // partial: total = transferred + content-length
          this.totalBytes = this.bytesTransferred + contentLength;
        } else if (contentLength > 0) {
          this.totalBytes = contentLength;
        } else if (this.expectedSize > 0 && this.totalBytes === 0) {
          this.totalBytes = this.expectedSize;
        }
        this._emitProgress(true);

        const fileStream = fs.createWriteStream(this.partPath, {
          flags: this.bytesTransferred > 0 ? "a" : "w",
        });
        this.activeStream = fileStream;

        res.on("data", (chunk) => {
          if (this.aborted || this.paused) {
            try { res.destroy(); } catch {}
            return;
          }
          this.activeHash.update(chunk);
          this.bytesTransferred += chunk.length;
          this._emitProgress(false);
        });

        res.on("error", (err) => {
          try { fileStream.destroy(); } catch {}
          reject(err);
        });
        res.on("end", () => {
          try { fileStream.end(); } catch {}
        });
        res.pipe(fileStream);

        fileStream.on("finish", () => {
          if (this.aborted) return resolve();
          if (this.paused) return resolve();
          // All bytes received from this response. Check if more pending (Range continuation handled by server in single response).
          this._finalizeDownload().then((ok) => {
            if (ok === "verified") {
              this._setState("done", { sourceLabel: this.activeSourceLabel });
              this._finish({ ok: true });
              resolve();
            } else if (ok === "incomplete") {
              // size mismatch but no error — treat as failed source.
              reject(new Error("incomplete-response"));
            } else if (ok === "checksum-failed") {
              // sha mismatch -> source fail; nuke .part for next try.
              try { fs.rmSync(this.partPath, { force: true }); } catch {}
              this.bytesTransferred = 0;
              reject(new Error("checksum-failed"));
            } else {
              reject(new Error(String(ok)));
            }
          }, reject);
        });
        fileStream.on("error", reject);
      });
      req.on("error", reject);
      req.on("timeout", () => {
        try { req.destroy(); } catch {}
        reject(new Error("request-timeout"));
      });
    });
  }

  async _rehashExisting() {
    return new Promise((resolve, reject) => {
      const rs = fs.createReadStream(this.partPath);
      rs.on("data", (chunk) => this.activeHash.update(chunk));
      rs.on("error", reject);
      rs.on("end", resolve);
    });
  }

  async _finalizeDownload() {
    const size = safeStatSize(this.partPath);
    if (this.expectedSize > 0) {
      const tolerance = Math.max(1024 * 1024, Math.floor(this.expectedSize * 0.005));
      if (Math.abs(size - this.expectedSize) > tolerance) {
        if (size < this.expectedSize - tolerance) {
          // Likely connection dropped early — return incomplete so we can rotate sources / resume.
          this._log("warn", `[download] size short: got=${size} expected≈${this.expectedSize}`);
          return "incomplete";
        }
      }
    }
    this._setState("verifying", { sourceLabel: this.activeSourceLabel });
    const digest = this.activeHash.digest("hex");
    if (digest.toLowerCase() !== this.expectedSha256) {
      this._log("error", `[download] sha256 mismatch got=${digest} expected=${this.expectedSha256}`);
      return "checksum-failed";
    }
    // atomic rename .part → target
    try {
      fs.renameSync(this.partPath, this.target);
    } catch (err) {
      // cross-device fallback
      try {
        fs.copyFileSync(this.partPath, this.target);
        fs.rmSync(this.partPath, { force: true });
      } catch (err2) {
        this._log("error", `[download] rename failed: ${err?.message || err} / ${err2?.message || err2}`);
        return "rename-failed";
      }
    }
    this._log("info", `[download] verified + finalized → ${this.target}`);
    return "verified";
  }

  async _verifyExistingTarget() {
    const size = safeStatSize(this.target);
    if (this.expectedSize > 0) {
      const tolerance = Math.max(1024 * 1024, Math.floor(this.expectedSize * 0.005));
      if (Math.abs(size - this.expectedSize) > tolerance) return false;
    }
    const digest = await new Promise((resolve, reject) => {
      const h = crypto.createHash("sha256");
      const rs = fs.createReadStream(this.target);
      rs.on("data", (chunk) => h.update(chunk));
      rs.on("error", reject);
      rs.on("end", () => resolve(h.digest("hex")));
    });
    return digest.toLowerCase() === this.expectedSha256;
  }

  // ── internal helpers ──

  _setState(state, patch = {}) {
    this.state = state;
    if (state === "downloading" && !this.startedAt) this.startedAt = Date.now();
    const payload = { state, ...this.getState(), ...patch };
    try { this.emit("state", payload); } catch {}
  }

  _emitProgress(force) {
    const now = Date.now();
    if (!force) {
      if (now - this.lastEmitTs < PROGRESS_THROTTLE_MS
          && this.bytesTransferred - this.lastEmitBytes < PROGRESS_THROTTLE_BYTES) {
        return;
      }
    }
    this.lastEmitTs = now;
    this.lastEmitBytes = this.bytesTransferred;
    try { this.emit("progress", this.getState()); } catch {}
  }

  _log(level, msg) {
    try { this.emit("log", level, msg); } catch {}
  }

  _teardownActive() {
    if (this.activeRequest) {
      try { this.activeRequest.destroy(); } catch {}
      this.activeRequest = null;
    }
    if (this.activeStream) {
      try { this.activeStream.destroy(); } catch {}
      this.activeStream = null;
    }
  }

  _fail(reason) {
    this.lastError = String(reason || "unknown-error");
    this._setState("error", { reason: this.lastError });
    this._teardownActive();
    this._finish({ ok: false, reason: this.lastError });
  }

  _finish(result) {
    if (this._finishResolve) {
      this._finishResolve(result);
      this._finishResolve = null;
    }
  }
}

module.exports = {
  ModelDownloader,
  defaultModelPath,
  defaultLynnRoot,
  DEFAULT_FILE_NAME,
  DEFAULT_EXPECTED_SIZE,
  DEFAULT_EXPECTED_SHA256,
  DEFAULT_SOURCES,
};
