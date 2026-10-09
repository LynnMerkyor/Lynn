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
  const q3 = catalog.tiers.find(item => item.quantization === 'Q3') || catalog.tiers[0];
  const q2 = catalog.tiers.find(item => item.quantization === 'Q2') || q3;
  // Marketed 16GB machines can report slightly under 16 GiB. At or above that line, Q3 is the default.
  const tier = memoryGib == null ? null : (memoryGib >= 15.5 ? q3 : q2);
  return {
    memory_kind: unified ? 'unified' : 'dedicated',
    accelerator_memory_gib: memoryGib,
    recommended_model_id: tier?.modelId || null,
    can_enable: !!tier,
    warnings: [
      ...(unified ? ['Apple 统一内存与系统共享。16GB 及以上默认 Q3，16GB 以下使用 Q2。其他程序占用内存时可能需要调整。'] : []),
      ...(!memoryGib ? ['未能确认独立显存，不会按系统内存推荐大模型；可手动选择档位或让 Lynn 协助检测。'] : []),
      ...(tier && memoryGib < 15.5 ? ['16GB 以下默认 Q2。主模型、KV 缓存和运行缓冲都占用内存，余量较紧。'] : []),
      ...(tier ? ['推荐依据为总容量，不代表当前空闲显存。主模型、KV 缓存和运行缓冲均占用内存；首次以单并发、短上下文启动。此次安装不含视觉组件。'] : []),
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
