import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';
import { loadDeskAutomationStatus } from '../../stores/desk-actions';

describe('desk-actions workspace map', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('window', {
      t: (key: string) => key,
    });
    vi.stubGlobal('fetch', fetchMock);
    useStore.setState({
      deskBasePath: '/Users/lynn/Desktop/Lynn',
      deskCurrentPath: '',
      jianOpen: false,
      toasts: [],
      serverPort: '8787',
      serverToken: 'test-token',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('按当前工作区过滤自动任务并更新书桌状态', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({
        jobs: [
          {
            id: 'job_1',
            label: '晨间扫描',
            enabled: true,
            workspace: '/Users/lynn/Desktop/Lynn',
            schedule: '0 9 * * 1,2,3,4,5',
            nextRunAt: '2026-04-06T09:00:00.000Z',
          },
          {
            id: 'job_2',
            label: '别的项目',
            enabled: true,
            workspace: '/Users/lynn/Desktop/Other',
            schedule: '0 10 * * *',
            nextRunAt: '2026-04-06T10:00:00.000Z',
          },
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await loadDeskAutomationStatus();

    expect(useStore.getState().automationCount).toBe(2);
    expect(useStore.getState().deskAutomationJobs).toHaveLength(1);
    expect(useStore.getState().deskAutomationJobs[0]?.label).toBe('晨间扫描');
    expect(useStore.getState().deskAutomationStatus?.count).toBe(1);
    expect(String(useStore.getState().deskAutomationStatus?.text || '')).toContain('自动任务');
  });
});
