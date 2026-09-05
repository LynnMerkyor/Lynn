import { useStore } from './stores';
import { renderMarkdown } from './utils/markdown';
import type { ChatListItem, ChatMessage, ContentBlock } from './stores/chat-types';

type SmokeScenario = 'home' | 'short' | 'tools' | 'image-tool-empty' | 'long-code' | 'automation' | 'automation-empty' | 'automation-long-path' | 'history-100' | 'history-500' | 'history-2000';

declare global {
  interface Window {
    __lynnUiSmokeReady?: boolean;
    __lynnUiSmokeScenario?: SmokeScenario;
    __lynnSetUiSmokeScenario?: (scenario: SmokeScenario) => boolean;
    __lynnPrepareUiSmokeCapture?: (preserveFocus?: boolean) => boolean;
    __lynnAutomationSmokeRequest?: (url: string, options?: RequestInit) => Promise<Response>;
    __lynnAutomationFailNextRun?: boolean;
    __lynnAutomationRequests?: Array<Record<string, unknown>>;
    __lynnAutomationSmokeData?: {
      jobs: Array<Record<string, unknown>>;
      models: Array<{ id: string; name?: string; provider?: string }>;
    };
  }
}

export function isUiSmokeMode(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('uiSmoke') === '1';
  } catch {
    return false;
  }
}

function textBlock(markdown: string): ContentBlock {
  return { type: 'text', html: renderMarkdown(markdown), plainText: markdown };
}

const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p94AAAAASUVORK5CYII=';

function userMessage(id: string, text: string, options?: {
  image?: boolean;
  visibleIndex?: number;
}): ChatListItem {
  return {
    type: 'message',
    data: {
      id,
      visibleIndex: options?.visibleIndex,
      role: 'user',
      text,
      textHtml: renderMarkdown(text),
      requestText: text,
      requestImages: options?.image ? [{ type: 'image', data: TINY_PNG, mimeType: 'image/png' }] : undefined,
      attachments: options?.image ? [{
        path: '/tmp/ui-smoke-image.png',
        name: 'ui-smoke-image.png',
        isDir: false,
        base64Data: TINY_PNG,
        mimeType: 'image/png',
      }] : undefined,
      timestamp: Date.now(),
    },
  };
}

function assistantMessage(id: string, blocks: ContentBlock[]): ChatListItem {
  const data: ChatMessage = {
    id,
    role: 'assistant',
    blocks,
    model: 'ui-smoke-model',
    timestamp: Date.now(),
  };
  return { type: 'message', data };
}

function itemsForScenario(scenario: SmokeScenario): ChatListItem[] {
  if (scenario.startsWith('history-')) {
    const count = Number(scenario.slice('history-'.length));
    return Array.from({ length: count }, (_, index) => index % 2 === 0
      ? userMessage(`history-${index}`, `HISTORY_${index}: 请整理第 ${index} 项工作。`)
      : assistantMessage(`history-${index}`, [textBlock(`HISTORY_${index}\n\n已完成工作整理。\n\n| 项目 | 状态 |\n| --- | --- |\n| ${index} | 完成 |\n\n\`\`\`js\nconst result = ${index};\n\`\`\``)]));
  }
  if (scenario === 'tools') {
    return [
      userMessage('ui-smoke-tools-user', 'UI_SMOKE_TOOLS：整理工作区并展示工具卡片。'),
      assistantMessage('ui-smoke-tools-assistant', [
        {
          type: 'tool_group',
          collapsed: false,
          tools: [
            {
              name: 'bash',
              args: { command: 'mkdir -p reports && mv draft.md reports/' },
              done: true,
              success: true,
              startedAt: Date.now() - 1200,
              summary: {
                command: 'mkdir -p reports && mv draft.md reports/',
                outputPreview: 'reports/draft.md',
              },
            },
            {
              name: 'write',
              args: { file_path: 'reports/summary.md' },
              done: true,
              success: true,
              startedAt: Date.now() - 800,
              summary: { filePath: 'reports/summary.md', bytesWritten: 842 },
            },
          ],
        },
        {
          type: 'file_diff',
          filePath: 'reports/summary.md',
          diff: [
            '--- a/reports/summary.md',
            '+++ b/reports/summary.md',
            '@@ -1,2 +1,3 @@',
            ' # Summary',
            '-old draft',
            '+整理完成',
            '+UI_SMOKE_TOOL_CARD',
          ].join('\n'),
          linesAdded: 2,
          linesRemoved: 1,
          rollbackId: 'ui-smoke-rollback',
        },
        textBlock('已完成整理，并生成 `reports/summary.md`。UI_SMOKE_TOOL_CARD'),
      ]),
    ];
  }

  if (scenario === 'image-tool-empty') {
    return [
      userMessage('ui-smoke-image-tool-user', 'UI_SMOKE_IMAGE_TOOL：请看这张图并总结要点。', {
        image: true,
        visibleIndex: 0,
      }),
      assistantMessage('ui-smoke-image-tool-assistant', [
        {
          type: 'tool_group',
          collapsed: false,
          tools: [
            {
              name: 'image_analyze',
              args: { prompt: 'UI_SMOKE_IMAGE_TOOL：请看这张图并总结要点。' },
              done: true,
              success: true,
              startedAt: Date.now() - 1400,
              summary: {
                outputPreview: '图像分析工具执行成功，但模型没有返回总结回复。',
              },
            },
          ],
        },
      ]),
    ];
  }

  if (scenario === 'long-code') {
    return [
      userMessage('ui-smoke-long-user', 'UI_SMOKE_LONG_CODE：生成一段长文和代码块。'),
      assistantMessage('ui-smoke-long-assistant', [
        { type: 'thinking', content: '确认输出包含长段落、列表、代码块和结论。', sealed: true },
        textBlock([
          'UI_SMOKE_LONG_CODE',
          '',
          '下面是一段用于检查长输出排版的内容。它包含多个段落、列表和代码块，目标是验证聊天区滚动、Markdown 渲染、复制按钮、朗读按钮和最后一条消息操作栏不会互相遮挡。',
          '',
          '- 第一项：确认段落宽度正常。',
          '- 第二项：确认列表缩进正常。',
          '- 第三项：确认代码块不会撑破容器。',
          '',
          '```ts',
          'export function calculateTotal(items: Array<{ price: number; count: number }>): number {',
          '  return items.reduce((sum, item) => sum + item.price * item.count, 0);',
          '}',
          '',
          'const total = calculateTotal([',
          '  { price: 12, count: 2 },',
          '  { price: 8, count: 3 },',
          ']);',
          'console.log(total);',
          '```',
          '',
          '最后一段用于确认底部 action rail 仍然可见，且不会覆盖正文。'.repeat(6),
        ].join('\n')),
      ]),
    ];
  }

  return [
    userMessage('ui-smoke-short-user', 'UI_SMOKE_SHORT：用一句话说明你已准备好。'),
    assistantMessage('ui-smoke-short-assistant', [
      textBlock('UI_SMOKE_SHORT_OK：我已准备好，可以继续帮你处理写作、文件、研究和工具任务。'),
    ]),
  ];
}

function applyScenario(scenario: SmokeScenario): void {
  const sessionPath = `/tmp/lynn-ui-smoke-${scenario}.jsonl`;
  const now = new Date().toISOString();
  const isHome = scenario === 'home';
  const isAutomation = scenario.startsWith('automation');

  window.__lynnAutomationSmokeData = isAutomation ? {
    jobs: [
      {
        id: 'visual-daily-summary',
        enabled: true,
        label: '定时工作小结',
        prompt: '按固定时间整理当前项目、工作地图和活动流。',
        schedule: '0 10 * * *',
        workspace: '/tmp/Lynn',
        nextRunAt: '2026-09-02T02:00:00.000Z',
        lastRunAt: '2026-09-01T05:10:00.000Z',
        latestRun: { status: 'success', finishedAt: '2026-09-01T05:10:00.000Z' },
        latestActivity: { summary: '定时工作小结 · Lynn', status: 'success' },
      },
      {
        id: 'visual-file-archive',
        enabled: true,
        label: '文件自动归纳',
        prompt: '查看工作区里新增或变化的文件，整理出重点。',
        schedule: '0 17 * * 1-5',
        workspace: '/tmp/Lynn',
        nextRunAt: '2026-09-01T09:00:00.000Z',
        lastRunAt: '2026-09-01T01:23:00.000Z',
        latestRun: { status: 'success', finishedAt: '2026-09-01T01:23:00.000Z' },
        latestActivity: { summary: '文件自动归纳 · Lynn', status: 'success' },
      },
    ],
    models: [
      { id: 'step-3.7-flash', name: 'StepFun 3.7 Flash', provider: 'brain' },
      { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', provider: 'brain' },
    ],
  } : undefined;
  if (scenario === 'automation-empty') window.__lynnAutomationSmokeData!.jobs = [];
  if (scenario === 'automation-long-path') {
    window.__lynnAutomationSmokeData!.jobs[0].workspace = '/workspace/团队项目/年度计划与跨部门交付/very-long-project-name-for-layout-regression/长期维护与自动任务验收';
  }
  window.__lynnAutomationRequests = [];
  window.__lynnAutomationFailNextRun = false;
  window.__lynnAutomationSmokeRequest = isAutomation ? async (_url, options) => {
    const data = window.__lynnAutomationSmokeData!;
    const payload = options?.body ? JSON.parse(String(options.body)) : {};
    window.__lynnAutomationRequests!.push(payload);
    if (payload.action === 'run' && window.__lynnAutomationFailNextRun) {
      window.__lynnAutomationFailNextRun = false;
      return Response.json({ error: '模拟执行失败' });
    }
    if (payload.action === 'add') data.jobs.push({ ...payload, id: `smoke-job-${data.jobs.length}`, enabled: true });
    if (payload.action === 'update') Object.assign(data.jobs.find(job => job.id === payload.id) || {}, payload);
    const job = payload.action === 'add' ? data.jobs[data.jobs.length - 1] : data.jobs.find(job => job.id === payload.id);
    return Response.json({ ok: true, job, jobs: data.jobs });
  } : undefined;

  useStore.setState({
    serverPort: '0',
    serverToken: 'ui-smoke',
    connected: true,
    wsState: 'connected',
    statusKey: 'status.connected',
    statusVars: {},
    currentTab: 'chat',
    activePanel: isAutomation ? 'automation' : null,
    locale: 'zh',
    agentName: 'Lynn',
    userName: 'Smoke Tester',
    agentYuan: 'hanako',
    currentModel: { id: 'ui-smoke-model', provider: 'smoke' },
    sidebarOpen: true,
    jianOpen: false,
    welcomeVisible: isHome,
    pendingNewSession: isHome,
    sessionCreationPending: false,
    currentSessionPath: isHome ? null : sessionPath,
    selectedFolder: '/tmp/Lynn',
    homeFolder: '/tmp',
    sessions: isHome ? [] : [{
      path: sessionPath,
      title: `UI Smoke · ${scenario}`,
      firstMessage: `UI_SMOKE_${scenario.toUpperCase()}`,
      modified: now,
      messageCount: 2,
      agentId: 'lynn',
      agentName: 'Lynn',
      cwd: '/tmp',
    }],
    chatSessions: isHome ? {} : {
      [sessionPath]: {
        items: itemsForScenario(scenario),
        hasMore: false,
        loadingMore: false,
        oldestId: `ui-smoke-${scenario}-user`,
      },
    },
    streamingSessions: [],
    currentActivity: null,
    serverReady: true,
    serverStartupStage: 'ready',
    serverStartupError: null,
  });

  document.body.dataset.uiSmokeScenario = scenario;
  window.__lynnUiSmokeScenario = scenario;
}

export async function installUiSmokeFixture(initialScenario: SmokeScenario = 'home'): Promise<void> {
  await window.i18n?.load('zh');
  if (window.t?.('cron.dailyAt', { hour: '9', min: '00' }) === 'cron.dailyAt') throw new Error('UI smoke locale was not initialized');
  window.__lynnSetUiSmokeScenario = (scenario: SmokeScenario) => {
    applyScenario(scenario);
    return true;
  };
  window.__lynnPrepareUiSmokeCapture = (preserveFocus = false) => {
    // Background connection attempts are intentionally unavailable in smoke mode.
    // Clear their transient notifications so visual baselines contain only the
    // scenario under test, never timing-dependent network noise.
    useStore.setState({ toasts: [] });
    if (!preserveFocus) (document.activeElement as HTMLElement | null)?.blur?.();
    const main = document.querySelector<HTMLElement>('[class*="automationMain"]');
    if (main) {
      const editing = Boolean(main.querySelector('[class*="automationComposer"]'));
      main.scrollTo({ top: editing ? main.scrollHeight : 0, behavior: 'instant' });
    }
    return true;
  };
  applyScenario(initialScenario);
  window.__lynnUiSmokeReady = true;
  window.dispatchEvent(new CustomEvent('lynn-ui-smoke-ready', { detail: { scenario: initialScenario } }));
  window.platform?.appReady?.();
}
