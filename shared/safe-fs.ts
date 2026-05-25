import fs from 'fs';
import path from 'path';
import { AppError } from './errors.js';
import { errorBus } from './error-bus.js';

export function safeReadFile<F = string>(filePath: fs.PathOrFileDescriptor, fallback: F = '' as F): string | F {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    // ENOENT 是 fallback 的合法场景（可选文件不存在），不上报 ErrorBus
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      const code = (err as NodeJS.ErrnoException).code === 'EACCES' ? 'FS_PERMISSION' : 'UNKNOWN';
      errorBus.report(new AppError(code, { cause: err, context: { filePath } }));
    }
    return fallback;
  }
}

export function safeReadJSON<T = unknown, F = null>(filePath: fs.PathOrFileDescriptor, fallback: F = null as F): T | F {
  const text = safeReadFile(filePath, null);
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    errorBus.report(new AppError('CONFIG_PARSE', { cause: err, context: { filePath } }));
    return fallback;
  }
}

type YamlModule = {
  default?: { load?: (text: string) => unknown };
  load: (text: string) => unknown;
};

export async function safeReadYAML<T = unknown, F = null>(filePath: fs.PathOrFileDescriptor, fallback: F = null as F): Promise<T | F> {
  const text = safeReadFile(filePath, null);
  if (text === null) return fallback;
  try {
    const yaml = await import('js-yaml') as YamlModule;
    return (yaml.default?.load?.(text) ?? yaml.load(text)) as T;
  } catch (err) {
    errorBus.report(new AppError('CONFIG_PARSE', { cause: err, context: { filePath } }));
    return fallback;
  }
}

type YamlLoader = {
  load: (text: string) => unknown;
};

export function safeReadYAMLSync<T = unknown, F = null>(filePath: fs.PathOrFileDescriptor, fallback: F = null as F, yaml?: unknown): T | F {
  const text = safeReadFile(filePath, null);
  if (text === null) return fallback;
  try {
    return (yaml as YamlLoader).load(text) as T;
  } catch (err) {
    errorBus.report(new AppError('CONFIG_PARSE', { cause: err, context: { filePath } }));
    return fallback;
  }
}

/**
 * Atomic directory copy with rollback.
 * 1. Copy src -> dst.tmp_{ts}
 * 2. If dst exists, rename dst -> dst.bak_{ts}
 * 3. Rename dst.tmp_{ts} -> dst
 * 4. Delete dst.bak_{ts}
 * Recovery: if step 3 fails, rename dst.bak_{ts} back to dst, clean up tmp.
 */
export function safeCopyDir(src: string, dst: string): void {
  const ts = Date.now();
  const tmpDst = `${dst}.tmp_${ts}`;
  const bakDst = `${dst}.bak_${ts}`;

  try {
    _copyDirRecursive(src, tmpDst);

    let hadExisting = false;
    if (fs.existsSync(dst)) {
      fs.renameSync(dst, bakDst);
      hadExisting = true;
    }

    try {
      fs.renameSync(tmpDst, dst);
    } catch (renameErr) {
      if (hadExisting) {
        try { fs.renameSync(bakDst, dst); } catch { /* best effort rollback */ }
      }
      _cleanupDir(tmpDst);
      throw renameErr;
    }

    if (hadExisting) _cleanupDir(bakDst);
  } catch (err) {
    _cleanupDir(tmpDst);
    throw new AppError('FS_COPY_FAILED', { cause: err, context: { src, dst } });
  }
}

function _copyDirRecursive(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      _copyDirRecursive(s, d);
    } else {
      if (fs.existsSync(d)) {
        try { fs.chmodSync(d, 0o644); } catch { /* Windows NTFS */ }
      }
      fs.copyFileSync(s, d);
    }
  }
}

function _cleanupDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}
