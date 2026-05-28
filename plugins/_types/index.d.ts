import type { TSchema } from '@sinclair/typebox';
import type { Hono } from 'hono';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonRecord = Record<string, JsonValue>;

export interface PluginLogger {
  debug?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  log?: (...args: unknown[]) => void;
}

export interface PluginConfigAccessor {
  get(): JsonRecord;
  get<T = unknown>(key: string): T | undefined;
  set?<T = unknown>(key: string, value: T): void | Promise<void>;
}

export interface PluginBus {
  emit?(event: string, payload?: unknown): void | Promise<void>;
  on?(event: string, handler: (...args: unknown[]) => void | Promise<void>): unknown;
}

export interface PluginToolContext {
  pluginId?: string;
  pluginDir: string;
  dataDir: string;
  bus?: PluginBus | null;
  engine?: unknown;
  config?: PluginConfigAccessor;
  log: PluginLogger;
}

export interface PluginToolResult {
  content?: Array<{
    type: 'text' | 'image' | 'audio' | 'file' | string;
    text?: string;
    path?: string;
    mimeType?: string;
    [key: string]: unknown;
  }>;
  details?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PluginToolModule<Params = Record<string, unknown>, Result = PluginToolResult> {
  name: string;
  description: string;
  parameters: TSchema;
  execute(params: Params, ctx: PluginToolContext): Result | Promise<Result>;
}

export interface PluginCommandModule<Params = unknown, Result = unknown> {
  name: string;
  description?: string;
  execute(params: Params, ctx: PluginToolContext): Result | Promise<Result>;
}

export interface PluginRouteModule {
  register(app: Hono, ctx: PluginToolContext): void | Promise<void>;
}

export interface PluginLifecycleModule {
  onload?(ctx: PluginToolContext): void | Promise<void>;
  onunload?(ctx: PluginToolContext): void | Promise<void>;
}

export interface PluginConfigurationProperty {
  type: 'string' | 'number' | 'boolean' | 'integer' | 'array' | 'object';
  title?: string;
  default?: JsonValue;
  enum?: JsonValue[];
  minimum?: number;
  maximum?: number;
  description?: string;
  [key: string]: JsonValue | undefined;
}

export interface PluginConfigurationContribution {
  properties?: Record<string, PluginConfigurationProperty>;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  contributes?: {
    configuration?: PluginConfigurationContribution;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}
