import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { errorMessage } from './types.js';

type DeviceRegisterEvent = {
  ok: boolean;
  status: string;
  statusCode: number;
  clientIp: string;
  keyFingerprint?: string;
  clientVersion?: string;
  clientPlatform?: string;
  error?: string;
};

const DEFAULT_REGISTER_ANALYTICS_DIR = '/opt/lobster-brain/data/device-register-events';
const REGISTER_ANALYTICS_DIR = process.env.BRAIN_V2_DEVICE_REGISTER_ANALYTICS_DIR || DEFAULT_REGISTER_ANALYTICS_DIR;

function currentUtcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function recordDeviceRegisterEvent(event: DeviceRegisterEvent): Promise<void> {
  try {
    await fsp.mkdir(REGISTER_ANALYTICS_DIR, { recursive: true });
    const file = path.join(REGISTER_ANALYTICS_DIR, `${currentUtcDay()}.jsonl`);
    const line = JSON.stringify({
      type: 'device_register',
      time: new Date().toISOString(),
      ...event,
    }) + '\n';
    await fsp.appendFile(file, line, { encoding: 'utf8' });
  } catch (err) {
    console.warn('[device-register-analytics] write failed:', errorMessage(err));
  }
}

