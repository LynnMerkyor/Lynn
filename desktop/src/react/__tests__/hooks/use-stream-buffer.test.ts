import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';
import { streamBufferManager } from '../../hooks/use-stream-buffer';

let cachedRenderer: ((src: string) => string) | null = null;
let resolveMarkdownLoad: ((renderer: (src: string) => string) => void) | null = null;

vi.mock('../../utils/markdown-loader', () => ({
  getCachedRenderMarkdown: () => cachedRenderer,
  loadRenderMarkdown: vi.fn(() => new Promise<(src: string) => string>((resolve) => {
    resolveMarkdownLoad = resolve;
  })),
}));

function getOnlyTextBlockHtml(sessionPath: string): string {
  const session = useStore.getState().chatSessions[sessionPath];
  const message = session?.items?.find((item) => item.type === 'message' && item.data.role === 'assistant');
  const textBlock = message?.type === 'message'
    ? message.data.blocks?.find((block) => block.type === 'text')
    : null;
  return textBlock?.type === 'text' ? textBlock.html : '';
}

describe('streamBufferManager markdown warmup', () => {
  beforeEach(() => {
    streamBufferManager.clearAll();
    cachedRenderer = null;
    resolveMarkdownLoad = null;
    const sessionPath = '/tmp/lynn-stream-markdown-warmup.jsonl';
    useStore.setState({
      currentSessionPath: sessionPath,
      currentModel: { id: 'smoke-model', provider: 'smoke' },
      chatSessions: {
        [sessionPath]: {
          items: [],
          hasMore: false,
          loadingMore: false,
          oldestId: undefined,
        },
      },
    });
  });

  it('refreshes an in-flight text delta with markdown html as soon as the renderer is ready', async () => {
    const sessionPath = '/tmp/lynn-stream-markdown-warmup.jsonl';

    streamBufferManager.handle({
      type: 'text_delta',
      sessionPath,
      streamId: 'stream-md-warmup',
      delta: '**流式加粗**',
    });

    expect(getOnlyTextBlockHtml(sessionPath)).toContain('**流式加粗**');
    expect(getOnlyTextBlockHtml(sessionPath)).not.toContain('data-rendered="markdown"');

    const renderer = (src: string) => `<p data-rendered="markdown"><strong>${src.replace(/\*/g, '')}</strong></p>`;
    cachedRenderer = renderer;
    resolveMarkdownLoad?.(renderer);
    await Promise.resolve();
    await Promise.resolve();

    expect(getOnlyTextBlockHtml(sessionPath)).toBe('<p data-rendered="markdown"><strong>流式加粗</strong></p>');
  });
});
