import fs from "fs";
import path from "path";

export type PluginConfigData = Record<string, unknown>;
export type PluginDisposable = () => void;
export type PluginEventHandler = (...args: unknown[]) => unknown;

export interface PluginBus {
  subscribe?: (...args: unknown[]) => PluginDisposable;
  handle?: (...args: unknown[]) => PluginDisposable;
  [key: string]: unknown;
}

export interface PluginConfig {
  get(): PluginConfigData;
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

export interface PluginLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
}

export interface PluginContextOptions {
  pluginId: string;
  pluginDir: string;
  dataDir: string;
  bus: PluginBus | null;
  engine?: unknown;
  disposables?: PluginDisposable[] | null;
}

export interface PluginContext {
  pluginId: string;
  pluginDir: string;
  dataDir: string;
  bus: PluginBus | null;
  engine: unknown;
  config: PluginConfig;
  log: PluginLogger;
  subscribe: (...args: unknown[]) => PluginDisposable;
  handle: (...args: unknown[]) => PluginDisposable;
}

/** Create a PluginContext for a plugin. */
export function createPluginContext({ pluginId, pluginDir, dataDir, bus, engine = null, disposables = null }: PluginContextOptions): PluginContext {
  const configPath = path.join(dataDir, "config.json");

  function getConfig(): PluginConfigData;
  function getConfig(key: string): unknown;
  function getConfig(key?: string): PluginConfigData | unknown {
    try {
      const data = JSON.parse(fs.readFileSync(configPath, "utf-8")) as PluginConfigData;
      return key ? data[key] : data;
    } catch {
      return key ? undefined : {};
    }
  }

  const config: PluginConfig = {
    get: getConfig,
    set(key: string, value: unknown) {
      fs.mkdirSync(dataDir, { recursive: true });
      const data = config.get();
      data[key] = value;
      fs.writeFileSync(configPath, JSON.stringify(data, null, 2), "utf-8");
    },
  };

  const prefix = `[plugin:${pluginId}]`;
  const log: PluginLogger = {
    info: (...args) => console.log(prefix, ...args),
    warn: (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
    debug: (...args) => console.debug(prefix, ...args),
  };

  const trackDisposable = (disposable: unknown): PluginDisposable => {
    if (typeof disposable === "function" && Array.isArray(disposables)) {
      disposables.push(disposable as PluginDisposable);
    }
    return disposable as PluginDisposable;
  };

  const subscribe = (...args: unknown[]): PluginDisposable => {
    if (!bus || typeof bus.subscribe !== "function") return () => {};
    return trackDisposable(bus.subscribe(...args));
  };
  const handle = (...args: unknown[]): PluginDisposable => {
    if (!bus || typeof bus.handle !== "function") return () => {};
    return trackDisposable(bus.handle(...args));
  };

  return { pluginId, pluginDir, dataDir, bus, engine, config, log, subscribe, handle };
}
