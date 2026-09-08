import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scanKimiDatasource, parseKimiLoginOutput } from '../lib/mcp/kimi-datasource.js';
import { createKimiDatasourceRoute } from '../server/routes/kimi-datasource.js';

const roots: string[] = [];
async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lynn-kimi-test-')); roots.push(home);
  const root = path.join(home, 'plugins/managed/kimi-datasource');
  await fs.mkdir(path.join(root, 'bin'), { recursive: true });
  await fs.writeFile(path.join(home, 'plugins/installed.json'), JSON.stringify({ version: 1, plugins: [{ id: 'kimi-datasource', root, enabled: true }] }));
  await fs.writeFile(path.join(root, 'kimi.plugin.json'), JSON.stringify({ name: 'kimi-datasource', version: 'test', mcpServers: { data: { command: 'node', args: ['./bin/kimi-datasource.mjs'], cwd: './' } } }));
  await fs.writeFile(path.join(root, 'bin/kimi-datasource.mjs'), '// fixture, never executed');
  return { home, root };
}
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
describe('Kimi Datasource local integration', () => {
  it('discovers only registered datasource, resolves the bundled runtime and never copies credentials', async () => {
    const { home, root } = await fixture();
    await fs.mkdir(path.join(home, 'credentials')); await fs.writeFile(path.join(home, 'credentials/kimi-code.json'), 'personal-secret-must-never-be-read');
    const scan = await scanKimiDatasource(home);
    expect(scan.diagnostics).toEqual([]); expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0].config).toMatchObject({ command: process.execPath, args: [await fs.realpath(path.join(root, 'bin/kimi-datasource.mjs'))], env: { KIMI_CODE_HOME: home } });
    expect(JSON.stringify(scan)).not.toContain('personal-secret');
    await fs.writeFile(path.join(home, 'plugins/installed.json'), '{"plugins":[]}');
    expect((await scanKimiDatasource(home)).candidates).toEqual([]);
  });
  it('rejects symlink escape and stale import previews', async () => {
    const { home, root } = await fixture();
    const scan = await scanKimiDatasource(home);
    const saveServer = vi.fn(); const route = createKimiDatasourceRoute(() => ({ saveServer, reload: vi.fn() }));
    await fs.writeFile(path.join(root, 'bin/kimi-datasource.mjs'), '// replaced');
    const response = await route.request('/mcp/kimi/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ home, id: scan.candidates[0].id }) });
    expect(response.status).toBe(409); expect(saveServer).not.toHaveBeenCalled();
    await fs.writeFile(path.join(home, 'outside.mjs'), 'outside');
    await fs.unlink(path.join(root, 'bin/kimi-datasource.mjs'));
    await fs.symlink(path.join(home, 'outside.mjs'), path.join(root, 'bin/kimi-datasource.mjs'));
    expect((await scanKimiDatasource(home)).diagnostics.join(' ')).toContain('escapes');
  });
  it('accepts only official HTTPS login links', () => {
    expect(parseKimiLoginOutput('https://auth.kimi.com.evil.test/device https://evil.test/ enter code: ABCD-1234')).toEqual({ code: 'ABCD-1234' });
    expect(parseKimiLoginOutput('Opening browser: https://auth.kimi.com/device?user_code=ABCD\nenter code: ABCD')).toEqual({ url: 'https://auth.kimi.com/device?user_code=ABCD', code: 'ABCD' });
  });
});
