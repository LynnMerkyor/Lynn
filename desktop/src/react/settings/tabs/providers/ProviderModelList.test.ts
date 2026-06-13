import { beforeAll, describe, expect, it } from 'vitest';

let providerModelList: typeof import('./ProviderModelList');

beforeAll(async () => {
  (globalThis as any).window = (globalThis as any).window || { platform: {} };
  providerModelList = await import('./ProviderModelList');
});

describe('ProviderModelList model candidates', () => {
  it('keeps removed discovered models out of the add dropdown', () => {
    const removed = providerModelList.nextRemovedModelsAfterRemove([], 'deepseek-chat');
    const options = providerModelList.buildProviderModelOptions({
      currentModelEntries: ['deepseek-v4-pro'],
      discoveredModels: [
        { id: 'deepseek-v4-pro' },
        { id: 'deepseek-chat' },
        { id: 'deepseek-reasoner' },
      ],
      customModels: ['deepseek-v4-flash', 'deepseek-chat'],
      removedModels: removed,
    });

    expect(options.currentModels).toEqual(['deepseek-v4-pro']);
    expect(options.candidateModels).toEqual(['deepseek-reasoner', 'deepseek-v4-flash']);
  });

  it('allows an explicitly re-added model to leave removed_models', () => {
    expect(providerModelList.nextRemovedModelsAfterAdd(['deepseek-chat', 'deepseek-reasoner'], 'deepseek-chat'))
      .toEqual(['deepseek-reasoner']);
  });
});
