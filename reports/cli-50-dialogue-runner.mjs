#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const prompts = [
  ['simple', '你好，只回复 OK'],
  ['simple', '用一句话解释 ReAct'],
  ['simple', '2+2 等于几？只给答案'],
  ['simple', '把 hello world 翻译成中文'],
  ['simple', '用三条 bullet 解释什么是上下文窗口'],
  ['simple', '给我 3 条 git commit message 规范'],
  ['simple', '解释一下 React 的 state 和 props 区别'],
  ['simple', '写一个 JavaScript debounce 函数'],
  ['simple', '用 Markdown 表格比较 BFS 和 DFS'],
  ['simple', '给出一个 SQL users 表建表语句'],
  ['realtime', '昨晚世界杯最新的比赛结果'],
  ['realtime', '今晚世界杯有几场比赛'],
  ['realtime', '今天世界杯赛程发我一下'],
  ['realtime', '世界杯半决赛在哪一天？'],
  ['realtime', '2026世界杯已经出的赛事比分'],
  ['realtime', 'NBA 总决赛打了几场，总比分如何？'],
  ['realtime', '今年 NBA 马刺夺冠了吗，还是尼克斯？'],
  ['realtime', '今日金价是多少？'],
  ['realtime', '英伟达股价最新是多少？'],
  ['realtime', '苹果公司 AAPL 最新股价是多少？'],
  ['realtime', '美元人民币汇率现在多少？'],
  ['realtime', '深圳明天下雨吗？'],
  ['realtime', '北京今天空气质量怎么样？'],
  ['realtime', '今天 A 股有什么异动？'],
  ['realtime', '中国主要私董会的人数和收费大概多少？'],
  ['search', '查一下 OpenAI 最近发布了什么新模型，给一句摘要'],
  ['search', '访问 example.com 并用一句话概括页面内容'],
  ['search', '查一下 2026 世界杯美国队上一场比分'],
  ['search', '查一下今晚英格兰与克罗地亚是否有比赛'],
  ['search', '查一下深圳今天有没有暴雨预警'],
  ['format', '把这个列表排序并去重：banana, apple, banana, pear'],
  ['format', '把“今天心情很好但是任务很多”改写得更正式一点'],
  ['format', '给我一个三列表格：任务、优先级、风险'],
  ['format', '写一个正则，匹配常见邮箱地址，并解释限制'],
  ['format', '用 LaTeX 写出二次方程求根公式'],
  ['code', '写一个 Python 函数读取 CSV 并按第一列分组计数'],
  ['code', '写一个 bash 命令统计当前目录下所有 .ts 文件行数'],
  ['code', '给一个 TypeScript discriminated union 的例子'],
  ['code', '解释 async/await 和 Promise.then 的区别'],
  ['code', '写一个 JSON schema，要求 name 字符串、age 正整数'],
  ['reasoning', '如果一个任务三次搜索都没结果，应该如何向用户解释？'],
  ['reasoning', '为什么模型工具成功但最后可能空答？给出两个原因'],
  ['reasoning', '给一个 UI 输入框在窄屏不溢出的设计检查清单'],
  ['reasoning', '如果复核模型和主模型结论冲突，产品上怎么展示比较好？'],
  ['reasoning', '设计一个 5 步门禁测试流程验证聊天工具链'],
  ['mixed', '查询今晚世界杯赛程，并最后用一个小表格输出'],
  ['mixed', '查询今日金价，如果没有确切数据请明确说不确定'],
  ['mixed', '查询英伟达股价，并说明数据时间'],
  ['mixed', '查深圳明天天气，并说明今天和明天的区别'],
  ['mixed', '查 NBA 总决赛结果，并给出一条可能的复核质疑点'],
];

const outPath = resolve('reports', `cli-50-results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
mkdirSync(dirname(outPath), { recursive: true });

function classify(result) {
  const text = result.assistantText.trim();
  const joinedErrors = result.errors.join('\n');
  const badNeedles = [
    '我已经拿到工具结果',
    '接管总结模型',
    'error.searchFollowupHint',
    '没有形成最终回复',
    '模型这次没有返回可见内容',
    '工具链已执行多轮',
    'providerQuery is not defined',
    'Tool not found',
    'aborted',
    'request timeout',
    '模型请求超时',
    'Error:',
  ];
  const bad = badNeedles.find((needle) => text.includes(needle) || joinedErrors.includes(needle));
  if (result.timedOut) return { status: 'timeout', reason: 'process timeout' };
  if (result.exitCode !== 0) return { status: 'process_fail', reason: `exit ${result.exitCode}` };
  if (!text) return { status: 'empty', reason: 'no assistant text' };
  if (bad) return { status: 'fallback_or_error_text', reason: bad };
  return { status: 'ok', reason: '' };
}

function runOne(index, category, prompt) {
  return new Promise((resolveOne) => {
    const startedAt = Date.now();
    const child = spawn('lynn', ['-p', prompt, '--json', '--no-ink'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    const result = {
      index,
      category,
      prompt,
      exitCode: null,
      durationMs: 0,
      providerTrail: [],
      toolNames: [],
      assistantText: '',
      reasoningChars: 0,
      usage: null,
      errors: [],
      rawTail: '',
      timedOut: false,
    };
    let raw = '';
    let stderr = '';
    const timer = setTimeout(() => {
      result.timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1500).unref();
    }, 120_000);
    child.stdout.on('data', (buf) => {
      raw += buf.toString('utf8');
      const lines = raw.split(/\r?\n/);
      raw = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        result.rawTail = `${result.rawTail}\n${line}`.slice(-4000);
        try {
          const event = JSON.parse(line);
          if (event.type === 'provider' && event.activeProvider) result.providerTrail.push(event.activeProvider);
          if (event.type === 'tool.start') result.toolNames.push(event.name || event.tool || 'tool');
          if (event.type === 'assistant.delta') result.assistantText += event.text || '';
          if (event.type === 'reasoning.delta') result.reasoningChars += String(event.text || '').length;
          if (event.type === 'usage') result.usage = event.usage || null;
          if (event.type === 'error') result.errors.push(event.message || JSON.stringify(event));
        } catch {
          result.errors.push(`non-json: ${line.slice(0, 240)}`);
        }
      }
    });
    child.stderr.on('data', (buf) => {
      stderr += buf.toString('utf8');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      result.exitCode = code;
      result.durationMs = Date.now() - startedAt;
      if (stderr.trim()) result.errors.push(stderr.trim().slice(-1000));
      Object.assign(result, classify(result));
      resolveOne(result);
    });
  });
}

const results = [];
for (let i = 0; i < prompts.length; i += 1) {
  const [category, prompt] = prompts[i];
  console.log(`[${i + 1}/${prompts.length}] ${category}: ${prompt}`);
  const result = await runOne(i + 1, category, prompt);
  results.push(result);
  console.log(`  -> ${result.status} ${result.durationMs}ms provider=${result.providerTrail.join('>') || '-'} tools=${result.toolNames.join(',') || '-'} text=${result.assistantText.trim().slice(0, 80).replace(/\s+/g, ' ')}`);
  writeFileSync(outPath, JSON.stringify({ outPath, generatedAt: new Date().toISOString(), results }, null, 2));
}

const counts = results.reduce((acc, item) => {
  acc[item.status] = (acc[item.status] || 0) + 1;
  return acc;
}, {});
const providerCounts = results.reduce((acc, item) => {
  const last = item.providerTrail.at(-1) || 'unknown';
  acc[last] = (acc[last] || 0) + 1;
  return acc;
}, {});
const toolRuns = results.filter((item) => item.toolNames.length).length;
const avgMs = Math.round(results.reduce((sum, item) => sum + item.durationMs, 0) / Math.max(1, results.length));

const summary = { outPath, total: results.length, counts, providerCounts, toolRuns, avgMs };
writeFileSync(outPath, JSON.stringify({ ...summary, generatedAt: new Date().toISOString(), results }, null, 2));
console.log('SUMMARY ' + JSON.stringify(summary));
