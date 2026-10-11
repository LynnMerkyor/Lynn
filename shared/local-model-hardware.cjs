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
  const tier = memoryGib == null || memoryGib < q2.minimumMemoryGib
    ? null : (memoryGib >= q3.minimumMemoryGib ? q3 : q2);
  return {
    memory_kind: unified ? 'unified' : 'dedicated',
    accelerator_memory_gib: memoryGib,
    recommended_model_id: tier?.modelId || null,
    can_enable: !!tier,
    warnings: [
      ...(unified ? ['Apple 统一内存与系统共享。16GB 默认 Q2，24GB 及以上默认 Q3。其他程序占用内存时可能需要调整。'] : []),
      ...(!memoryGib ? ['未能确认显存/统一内存容量，暂不允许一键安装；请让 Lynn 协助检测，不会拿系统内存代替独立显存。'] : []),
      ...(memoryGib && memoryGib < q2.minimumMemoryGib ? [`检测到 ${memoryGib.toFixed(1)} GiB，低于 14GiB 安装下限，不能安装 Q2/Q3。Q2 文件约 13.28GB 不代表运行只需这些内存，还需要上下文 KV 缓存及运行缓冲。`] : []),
      ...(tier && memoryGib < 15.5 ? ['当前仅达到 14GiB 最低安装门槛，低于 16GB 推荐档；Q2 的上下文和运行余量较紧，请关闭其他占用内存的程序。'] : []),
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
