import { describe, expect, it } from 'vitest';
import { verifyToolResult, _internals } from '../verifier-middleware.js';

describe('verifier middleware BYOK-equality shim', () => {
  it('never grades or rejects tool output', async () => {
    const result = await verifyToolResult({
      userPrompt: 'today gold price',
      toolName: 'stock_market',
      toolResult: 'any output',
    });

    expect(_internals.disabled).toBe(true);
    expect(result).toEqual({
      skipped: true,
      pass: true,
      reason: 'disabled_by_byok_equality',
    });
  });
});
