import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createSession, signedHeaders } = vi.hoisted(() => ({ createSession: vi.fn(), signedHeaders: vi.fn() }));
vi.mock('../core/agent-runtime/create-session.js', () => ({ createLynnAgentSession: createSession }));
vi.mock('../core/client-agent-identity.js', () => ({ readSignedClientAgentHeadersForProvider: signedHeaders }));
const { runAgentSession } = await import('../hub/agent-executor.js');

describe('agent executor request identity', () => {
  let directory;
  beforeEach(() => {
    vi.clearAllMocks();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lynn-executor-identity-'));
    let listener;
    createSession.mockResolvedValue({ session: {
      sessionManager: { getSessionFile: () => null },
      subscribe: callback => { listener = callback; return () => {}; },
      prompt: async () => listener({ type: 'message_end', message: { role: 'assistant', content: 'review completed' } }),
    } });
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  async function execute(model, override) {
    return runAgentSession('hanako', [{ text: 'Review this answer.', capture: true }], {
      modelOverride: override,
      engine: {
        homeCwd: directory,
        getAgent: () => ({ agentDir: directory, tools: [], config: {} }),
        createSessionContext: () => ({
          resourceLoader: { getSystemPrompt: () => '' },
          getSkillsForAgent: () => [],
          buildTools: () => ({ tools: [], customTools: [] }),
          authStorage: {},
          modelRegistry: {},
          resolveModel: () => model,
        }),
      },
    });
  }

  it('passes provider-scoped device signatures to the actual Brain session', async () => {
    const model = { id: 'step-5-preview', provider: 'brain', baseUrl: 'https://api.merkyorlynn.com/api/v2/v1' };
    const headers = { 'X-Lynn-Device-Signature': 'test-signature' };
    signedHeaders.mockReturnValue(headers);
    await expect(execute(model)).resolves.toBe('review completed');
    expect(signedHeaders).toHaveBeenCalledWith({ method: 'POST', pathname: '/chat/completions', provider: model.provider, baseUrl: model.baseUrl });
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ model, requestHeaders: headers }));
  });

  it('uses the override destination and does not attach Brain identity to other providers', async () => {
    const original = { id: 'step-5-preview', provider: 'brain' };
    const override = { id: 'test-model', provider: 'custom', baseUrl: 'https://custom.example/v1' };
    signedHeaders.mockReturnValue({});
    await expect(execute(original, override)).resolves.toBe('review completed');
    expect(signedHeaders).toHaveBeenCalledWith({ method: 'POST', pathname: '/chat/completions', provider: 'custom', baseUrl: override.baseUrl });
    expect(createSession.mock.calls[0][0]).not.toHaveProperty('requestHeaders');
  });
});
