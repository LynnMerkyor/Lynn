// Pinned upstream binaries. Invoked only by an explicitly authorized install.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const spec = require('../build/dflash-llamacpp-runtime.json');
const exec = promisify(execFile);

function selectRuntimeAsset(platform = process.platform, arch = process.arch) {
  const suffix = platform === 'darwin' ? `bin-macos-${arch}.tar.gz`
    : platform === 'win32' && arch === 'x64' ? 'bin-win-vulkan-x64.zip'
    : platform === 'linux' ? `bin-ubuntu-vulkan-${arch}.tar.gz` : null;
  return suffix ? spec.assets.find(asset => asset.name.endsWith(suffix)) || null : null;
}

async function probeDflashRuntime(binary, signal) {
  if (!binary) return false;
  try {
    const options = { timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024, signal };
    const { stdout, stderr } = await exec(binary, ['--help'], options);
    if (!/draft-dflash/.test(stdout + stderr)) return false;
    const devices = await exec(binary, ['--list-devices'], options);
    return /(?:CUDA|Metal|Vulkan|ROCm|SYCL)\d*:/i.test(devices.stdout + devices.stderr);
  } catch { return false; }
}

async function findServer(directory, depth = 0) {
  if (depth > 4) return null;
  let entries;
  try { entries = await fsp.readdir(directory, { withFileTypes: true }); } catch { return null; }
  if (entries.length > 512) throw new Error('runtime-archive-too-many-files');
  for (const entry of entries) {
    if (entry.isFile() && /^llama-server(?:\.exe)?$/.test(entry.name)) return path.join(directory, entry.name);
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const binary = await findServer(path.join(directory, entry.name), depth + 1);
      if (binary) return binary;
    }
  }
  return null;
}

function safeArchiveEntry(name) {
  return !/^[\\/]|^[A-Za-z]:/.test(name) && !name.replaceAll('\\', '/').split('/').includes('..');
}

async function ensureDflashRuntime({ lynnHome, existingBinary, signal, onProgress = () => {} }) {
  signal?.throwIfAborted();
  onProgress('检查 llama.cpp 的 DFlash2 与 GPU 支持');
  if (await probeDflashRuntime(existingBinary, signal)) return existingBinary;
  signal?.throwIfAborted();
  const asset = selectRuntimeAsset();
  if (!asset) throw new Error('runtime-platform-unsupported: 请让 Lynn 协助安装支持 DFlash2 的 llama.cpp');
  const root = path.join(lynnHome, 'llamacpp', 'runtimes');
  const destination = path.join(root, `${spec.tag}-${process.platform}-${process.arch}`);
  const installed = await findServer(destination);
  if (await probeDflashRuntime(installed, signal)) return installed;
  signal?.throwIfAborted();
  await fsp.mkdir(root, { recursive: true });
  const temp = await fsp.mkdtemp(path.join(root, '.install-'));
  try {
    const archive = path.join(temp, asset.name);
    const extracted = path.join(temp, 'extracted');
    await fsp.mkdir(extracted);
    onProgress(`下载 llama.cpp ${spec.tag}（${(asset.size / 1e6).toFixed(1)} MB）`);
    const downloadSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000);
    const response = await fetch(asset.url, { signal: downloadSignal, redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`runtime-download-http-${response.status}`);
    const hash = createHash('sha256');
    let bytes = 0;
    const verifier = new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > asset.size) return callback(new Error('runtime-size-mismatch'));
      hash.update(chunk); callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), verifier, fs.createWriteStream(archive, { flags: 'wx' }), { signal: downloadSignal });
    if (bytes !== asset.size || hash.digest('hex') !== asset.sha256) throw new Error('runtime-checksum-mismatch');
    signal?.throwIfAborted();
    onProgress('运行时校验通过，正在安装和检查 GPU 支持');
    const options = { timeout: 60000, windowsHide: true, signal, maxBuffer: 1024 * 1024 };
    if (asset.name.endsWith('.zip')) {
      // Official, hash-verified ZIP; still reject archive traversal before extraction.
      const quote = text => `'${text.replaceAll("'", "''")}'`;
      const script = `Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead(${quote(archive)}); try { foreach($e in $z.Entries) { if($e.FullName -match '(^[\\\\/]|^[A-Za-z]:|(^|[\\\\/])\\.\\.([\\\\/]|$))') { throw 'Unsafe archive entry' } } } finally { $z.Dispose() }; Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(extracted)}`;
      await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], options);
    } else {
      const listing = await exec('tar', ['-tzf', archive], options);
      if (!listing.stdout.split('\n').every(safeArchiveEntry)) throw new Error('runtime-unsafe-archive');
      await exec('tar', ['-xzf', archive, '-C', extracted], options);
    }
    const binary = await findServer(extracted);
    if (!await probeDflashRuntime(binary, signal)) throw new Error('runtime-gpu-or-dflash-unavailable: 请检查显卡驱动或让 Lynn 协助部署');
    signal?.throwIfAborted();
    // Never overwrite a user runtime. Keep an incompatible managed version as backup.
    if (fs.existsSync(destination)) await fsp.rename(destination, `${destination}.previous-${Date.now()}`);
    const relative = path.relative(extracted, binary);
    await fsp.rename(extracted, destination);
    return path.join(destination, relative);
  } finally {
    await fsp.rm(temp, { recursive: true, force: true });
  }
}

module.exports = { selectRuntimeAsset, safeArchiveEntry, probeDflashRuntime, ensureDflashRuntime };
