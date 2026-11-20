import { existsSync, readFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { ConfigError } from './errors.js';

export const PROJECT_ROOT = resolve(new URL('..', import.meta.url).pathname);

export const DEFAULT_CONFIG = Object.freeze({
  runtime: {
    stateDir: '.ora-state',
    defaultTimeoutMs: 60000,
    maxConcurrentAgents: 3,
    checkpointEvery: 3,
    maxSteps: 30,
    logLevel: 'info'
  },
  security: {
    approvalMode: 'manual',
    allowNetwork: false,
    requireApproval: ['shell', 'write', 'network', 'external'],
    deniedPaths: [
      '.env',
      '.env.*',
      '*.pem',
      '*.key',
      '*credentials*',
      '*secret*',
      '.ssh/**',
      '.aws/**',
      '.freellmapi/.env',
      '.ora-state/**'
    ]
  },
  repo: {
    ignore: [],
    maxFiles: 20000,
    maxBytesPerFile: 512000,
    contextLimit: 24000
  },
  agents: {
    useModel: false,
    maxActionsPerAgent: 12
  },
  providers: [],
  adapters: []
});

function mergeDeep(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return base;
  const result = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      result[key] = mergeDeep(base[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function readJsonFile(path) {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('config root must be an object');
    return parsed;
  } catch (error) {
    throw new ConfigError(`Unable to parse config file ${path}: ${error.message}`);
  }
}

function numberFromEnv(value, name, { min = 1, max = 1000000, fallback }) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new ConfigError(`${name} must be numeric`);
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function validate(config) {
  if (!['auto', 'manual', 'deny'].includes(config.security.approvalMode)) {
    throw new ConfigError('security.approvalMode must be auto, manual or deny');
  }
  if (!Array.isArray(config.security.requireApproval)) throw new ConfigError('security.requireApproval must be an array');
  if (!Array.isArray(config.security.deniedPaths)) throw new ConfigError('security.deniedPaths must be an array');
  if (!Array.isArray(config.providers)) throw new ConfigError('providers must be an array');
  if (!Array.isArray(config.adapters)) throw new ConfigError('adapters must be an array');
  if (!Number.isFinite(config.runtime.maxConcurrentAgents) || config.runtime.maxConcurrentAgents < 1) {
    throw new ConfigError('runtime.maxConcurrentAgents must be >= 1');
  }
  return config;
}

export function loadConfig({ cwd = PROJECT_ROOT, env = process.env, overrides = {} } = {}) {
  const configPath = env.ORA_CONFIG
    ? resolve(env.ORA_CONFIG)
    : resolve(cwd, '.ora', 'config.json');
  const fromFile = readJsonFile(configPath);
  let merged = mergeDeep(DEFAULT_CONFIG, fromFile);
  merged = mergeDeep(merged, overrides);

  if (env.ORA_STATE_DIR) merged.runtime.stateDir = env.ORA_STATE_DIR;
  if (env.ORA_LOG_LEVEL) merged.runtime.logLevel = env.ORA_LOG_LEVEL;
  if (env.ORA_MAX_CONCURRENT_AGENTS) {
    merged.runtime.maxConcurrentAgents = numberFromEnv(env.ORA_MAX_CONCURRENT_AGENTS, 'ORA_MAX_CONCURRENT_AGENTS', {
      fallback: merged.runtime.maxConcurrentAgents,
      min: 1,
      max: 16
    });
  }
  if (env.ORA_DEFAULT_TIMEOUT_MS) {
    merged.runtime.defaultTimeoutMs = numberFromEnv(env.ORA_DEFAULT_TIMEOUT_MS, 'ORA_DEFAULT_TIMEOUT_MS', {
      fallback: merged.runtime.defaultTimeoutMs,
      min: 100,
      max: 600000
    });
  }
  if (env.ORA_APPROVAL_MODE) merged.security.approvalMode = env.ORA_APPROVAL_MODE;
  if (env.ORA_ALLOW_NETWORK !== undefined) merged.security.allowNetwork = ['1', 'true', 'yes'].includes(String(env.ORA_ALLOW_NETWORK).toLowerCase());
  if (env.ORA_USE_MODEL !== undefined) merged.agents.useModel = ['1', 'true', 'yes'].includes(String(env.ORA_USE_MODEL).toLowerCase());
  if (env.ORA_PROVIDERS_JSON) {
    try {
      const parsed = JSON.parse(env.ORA_PROVIDERS_JSON);
      if (Array.isArray(parsed)) merged.providers = parsed;
    } catch (error) {
      throw new ConfigError(`ORA_PROVIDERS_JSON is invalid: ${error.message}`);
    }
  }

  const stateDir = isAbsolute(merged.runtime.stateDir)
    ? resolve(merged.runtime.stateDir)
    : resolve(cwd, merged.runtime.stateDir);
  merged.runtime.stateDir = stateDir;
  merged.runtime.configPath = configPath;
  merged.runtime.cwd = resolve(cwd);
  return validate(merged);
}

export function publicConfig(config) {
  return JSON.parse(JSON.stringify({
    runtime: { ...config.runtime },
    security: { ...config.security },
    repo: { ...config.repo },
    agents: { ...config.agents },
    providers: (config.providers || []).map((provider) => ({
      id: provider.id,
      name: provider.name,
      baseURL: provider.baseURL,
      models: provider.models
    })),
    adapters: (config.adapters || []).map((adapter) => ({ id: adapter.id, kind: adapter.kind, command: adapter.command }))
  }));
}
