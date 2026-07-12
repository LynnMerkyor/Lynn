import { describe, expect, it } from 'vitest';
import { humanizeUiError } from './humanize-ui-error';

describe('humanizeUiError', () => {
  it('turns internal transport codes into user-facing actions', () => {
    expect(humanizeUiError('ECONNREFUSED 127.0.0.1')).toContain('网络连接失败');
    expect(humanizeUiError('mimo_error_auth')).toContain('认证失败');
    expect(humanizeUiError('llamacpp-port-in-use')).toContain('端口已被占用');
  });

  it('does not show opaque codes or stack traces', () => {
    expect(humanizeUiError('provider_probe_threw')).not.toContain('provider_probe_threw');
    expect(humanizeUiError('Error\n    at internal.ts:1')).not.toContain('internal.ts');
  });

  it('keeps concise human explanations', () => {
    expect(humanizeUiError('无法保存文件，请检查目录权限。')).toBe('无法保存文件，请检查目录权限。');
  });
});
