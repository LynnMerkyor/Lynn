const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const catalog = require('./qwen38-local-models.json');
const execFileAsync = promisify(execFile);

function recommendLocalModel({ platform, arch, totalMemoryGib, gpus = [] }) {
  const unified = platform === 'darwin' && arch === 'arm64';
  // Do not sum distinct cards or mistake host RAM for dedicated GPU memory.
  const memory = unified ? totalMemoryGib : Math.max(0, ...gpus.map(gpu => Number(gpu.memory_gib) || 0));
  const memoryGib = Number.isFinite(memory) && memory > 0 ? memory : null;
  const sharedMemoryTight = unified && memoryGib != null && memoryGib < 18;
  const tier = sharedMemoryTight ? null : catalog.tiers.find(item => memoryGib != null && memoryGib >= item.memoryGib - 0.25) || null;
  return {
    memory_kind: unified ? 'unified' : 'dedicated',
    accelerator_memory_gib: memoryGib,
    recommended_model_id: tier?.modelId || null,
    can_enable: !!tier,
    warnings: [
      ...(unified ? ['Apple 统一内存与系统共享；16GB 设备余量紧张，建议关闭其他应用，加载失败时可让 Lynn 协助调整。'] : []),
      ...(!memoryGib ? ['未能确认独立显存，不会按系统内存推荐大模型；可手动选择档位或让 Lynn 协助检测。'] : []),
      ...(sharedMemoryTight ? ['16GB 统一内存不能等同于 16GB 独立显存；系统预留不足，默认不自动推荐大模型，可让 Lynn 协助或手动确认后尝试。'] : []),
      ...(memoryGib && !tier && !sharedMemoryTight ? ['独立显存/统一内存不足 16GB，建议使用云端或较小模型。'] : []),
      ...(tier ? ['推荐依据为总容量，不代表当前空闲显存。主模型、DFlash2、KV 缓存和运行缓冲均占用内存；首次以单并发、短上下文启动。'] : []),
    ],
  };
}

let cache;
let inflight;
async function detectLocalModelHardware() {
  if (cache && Date.now() - cache.at < 60000) return cache.value;
  if (inflight) return inflight;
  inflight = (async () => {
    const platform = process.platform;
    const arch = process.arch;
    const totalMemoryGib = os.totalmem() / 1024 ** 3;
    let gpus = [];
    if (platform !== 'darwin') {
      try {
        const { stdout } = await execFileAsync('nvidia-smi', ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'], { timeout: 4000, windowsHide: true, maxBuffer: 65536 });
        gpus = stdout.trim().split(/\r?\n/).slice(0, 16).map(line => {
          const [name, total, free] = line.split(',').map(value => value.trim());
          return { name, memory_gib: Number(total) / 1024, free_memory_gib: Number(free) / 1024 };
        }).filter(gpu => Number.isFinite(gpu.memory_gib) && gpu.memory_gib > 0);
      } catch { /* Unknown is surfaced; never guess from RAM or 32-bit AdapterRAM. */ }
    }
    const value = { platform, arch, chip: os.cpus()?.[0]?.model || null, total_memory_gib: totalMemoryGib, gpus, ...recommendLocalModel({ platform, arch, totalMemoryGib, gpus }) };
    cache = { at: Date.now(), value };
    return value;
  })().finally(() => { inflight = null; });
  return inflight;
}

module.exports = { catalog, recommendLocalModel, detectLocalModelHardware };
