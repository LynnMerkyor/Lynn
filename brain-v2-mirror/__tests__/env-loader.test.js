import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadBrainEnvFiles } from '../env-loader.js';

const tmpDirs = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynn-brain-env-'));
  tmpDirs.push(dir);
  return dir;
}

describe('brain env loader', () => {
  it('loads explicit, user, and cwd env files without overriding existing env', () => {
    const dir = makeTmpDir();
    const home = path.join(dir, 'home');
    const cwd = path.join(dir, 'cwd');
    fs.mkdirSync(path.join(home, '.lynn'), { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    const explicit = path.join(dir, 'explicit.env');
    fs.writeFileSync(explicit, 'STEP37_KEY=from-explicit\nKEEP=explicit\n');
    fs.writeFileSync(path.join(home, '.lynn', 'brain.env'), 'MIMO_SEARCH_KEY="from-user"\nKEEP=user\n');
    fs.writeFileSync(path.join(cwd, '.env'), "DEEPSEEK_KEY='from-cwd'\n");

    const env = { BRAIN_V2_ENV_FILE: explicit, KEEP: 'shell' };
    const result = loadBrainEnvFiles({ cwd, env, homeDir: home });

    expect(result.files).toEqual([
      path.resolve(explicit),
      path.resolve(path.join(home, '.lynn', 'brain.env')),
      path.resolve(path.join(cwd, '.env')),
    ]);
    expect(env.STEP37_KEY).toBe('from-explicit');
    expect(env.MIMO_SEARCH_KEY).toBe('from-user');
    expect(env.DEEPSEEK_KEY).toBe('from-cwd');
    expect(env.KEEP).toBe('shell');
  });

  it('maps legacy provider env names when the canonical key is missing', () => {
    const env = {
      STEP_KEY: 'legacy-step',
      STEP_BASE: 'https://legacy-step.example/v1',
      STEP_TEXT_MODEL: 'step-legacy',
      MIMO_KEY: 'legacy-mimo',
      MIMO_API_KEY: 'ordinary-mimo',
      MIMO_API_BASE: 'https://api.xiaomimimo.com/v1',
      MIMO_API_MODEL: 'mimo-v2.5-pro-ultraspeed',
    };

    const result = loadBrainEnvFiles({ env, paths: [] });

    expect(env.STEP37_KEY).toBe('legacy-step');
    expect(env.STEP37_BASE).toBe('https://legacy-step.example/v1');
    expect(env.STEP37_MODEL).toBe('step-legacy');
    expect(env.MIMO_SEARCH_KEY).toBe('legacy-mimo');
    expect(env.MIMO_ULTRASPEED_KEY).toBe('ordinary-mimo');
    expect(env.MIMO_ULTRASPEED_BASE).toBe('https://api.xiaomimimo.com/v1');
    expect(env.MIMO_ULTRASPEED_MODEL).toBe('mimo-v2.5-pro-ultraspeed');
    expect(result.aliases).toEqual(expect.arrayContaining([
      'STEP_KEY->STEP37_KEY',
      'STEP_BASE->STEP37_BASE',
      'STEP_TEXT_MODEL->STEP37_MODEL',
      'MIMO_KEY->MIMO_SEARCH_KEY',
      'MIMO_API_KEY->MIMO_ULTRASPEED_KEY',
    ]));
  });

  it('bridges search MiMo to Token Plan only when the search base is token-plan', () => {
    const tokenPlanEnv = {
      MIMO_SEARCH_BASE: 'https://token-plan-cn.xiaomimimo.com/v1',
      MIMO_SEARCH_KEY: 'tp-key',
      MIMO_SEARCH_MODEL: 'mimo-v2.5-pro',
    };
    const tokenPlanResult = loadBrainEnvFiles({ env: tokenPlanEnv, paths: [] });

    expect(tokenPlanEnv.MIMO_TOKEN_PLAN_BASE).toBe('https://token-plan-cn.xiaomimimo.com/v1');
    expect(tokenPlanEnv.MIMO_TOKEN_PLAN_KEY).toBe('tp-key');
    expect(tokenPlanEnv.MIMO_TOKEN_PLAN_MODEL).toBe('mimo-v2.5-pro');
    expect(tokenPlanResult.aliases).toEqual(expect.arrayContaining([
      'MIMO_SEARCH_KEY->MIMO_TOKEN_PLAN_KEY',
    ]));

    const ordinaryEnv = {
      MIMO_SEARCH_BASE: 'https://api.xiaomimimo.com/v1',
      MIMO_SEARCH_KEY: 'sk-old',
      MIMO_SEARCH_MODEL: 'mimo-v2-flash',
    };
    loadBrainEnvFiles({ env: ordinaryEnv, paths: [] });

    expect(ordinaryEnv.MIMO_TOKEN_PLAN_BASE).toBeUndefined();
    expect(ordinaryEnv.MIMO_TOKEN_PLAN_KEY).toBeUndefined();
    expect(ordinaryEnv.MIMO_TOKEN_PLAN_MODEL).toBeUndefined();
  });
});
