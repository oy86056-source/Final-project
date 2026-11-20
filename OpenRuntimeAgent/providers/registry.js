import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createOpenAICompatibleProvider } from './openai-compatible.js';
import { createRouter } from './router.js';

const METADATA_HINTS = ['cost', 'speed', 'quality', 'capabilities', 'description', 'warning', 'latencyMs'];

function safeReason(value) {
  let text = value instanceof Error ? value.message : String(value ?? 'unknown error');
  text = text.replace(/(Bearer\s+)[^\s,;"'}\]]+/gi, '$1[REDACTED]');
  text = text.replace(/((?:api[_-]?key|apikey|authorization|access[_-]?token|refresh[_-]?token|token|secret|password)(?:["']?\s*[:=]\s*|["']?\s+))([^\s,;"'}&]+)/gi, '$1[REDACTED]');
  text = text.replace(/([?&](?:api[_-]?key|apikey|token|key|secret)=)[^&\s]+/gi, '$1[REDACTED]');
  return text.slice(0, 500);
}

function scrub(value, apiKey) {
  if (typeof value === 'string') {
    let text = value;
    if (apiKey) text = text.split(apiKey).join('[REDACTED]');
    text = text.replace(/(Bearer\s+)[^\s,;"'}\]]+/gi, '$1[REDACTED]');
    text = text.replace(/([?&](?:api[_-]?key|apikey|token|key|secret)=)[^&\s]+/gi, '$1[REDACTED]');
    text = text.replace(/((?:api[_-]?key|apikey|authorization|access[_-]?token|token|secret|password)(?:["']?\s*[:=]\s*|["']?\s+))([^\s,;"'}&]+)/gi, '$1[REDACTED]');
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => scrub(item, apiKey));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, nested] of Object.entries(value)) result[key] = scrub(nested, apiKey);
    return result;
  }
  return value;
}

function publicMetadata(spec, id, apiKey) {
  const source = spec && typeof spec === 'object' ? spec : {};
  const models = Array.isArray(source.models) ? source.models.map(String) : [];
  const base = {
    id,
    name: typeof source.name === 'string' ? source.name : id,
    kind: typeof source.kind === 'string' ? source.kind : 'openai-compatible',
    baseURL: typeof source.baseURL === 'string' ? source.baseURL : '',
    models: [...models],
    defaultModel: source.defaultModel ?? models[0] ?? '',
    contextWindow: Number(source.contextWindow) > 0 ? Number(source.contextWindow) : 8192,
    maxOutput: Number(source.maxOutput) > 0 ? Number(source.maxOutput) : 4096
  };
  for (const key of METADATA_HINTS) {
    if (source[key] !== undefined) base[key] = source[key];
  }
  return scrub(base, apiKey);
}

function mergeMetadata(provider, fallback, apiKey) {
  const candidate = typeof provider?.metadata === 'function' ? provider.metadata() : {};
  const source = candidate && typeof candidate === 'object' ? candidate : {};
  const base = publicMetadata(fallback, fallback.id, apiKey);
  const result = { ...base };

  if (typeof source.name === 'string') result.name = source.name;
  if (typeof source.kind === 'string') result.kind = source.kind;
  if (typeof source.baseURL === 'string') result.baseURL = source.baseURL;
  if (Array.isArray(source.models)) result.models = source.models.map(String);
  if (source.defaultModel !== undefined) result.defaultModel = source.defaultModel;
  if (Number(source.contextWindow) > 0) result.contextWindow = Number(source.contextWindow);
  if (Number(source.maxOutput) > 0) result.maxOutput = Number(source.maxOutput);

  for (const key of METADATA_HINTS) {
    if (source[key] !== undefined) result[key] = source[key];
    else if (fallback[key] !== undefined) result[key] = fallback[key];
  }

  result.id = fallback.id;
  return scrub(result, apiKey);
}

function parseEnvFile(content, key) {
  for (const rawLine of String(content).split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    if (line.slice(0, separator).trim() !== key) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    const comment = value.indexOf(' #');
    if (comment !== -1) value = value.slice(0, comment).trim();
    return value;
  }
  return '';
}

function readApiKey(apiKeyEnv, envFiles, env = process.env) {
  const fromProcess = env?.[apiKeyEnv];
  if (typeof fromProcess === 'string' && fromProcess.trim()) return fromProcess.trim();
  const files = (Array.isArray(envFiles) ? envFiles : [envFiles]).flat().filter(Boolean);
  for (const file of files) {
    try {
      const value = parseEnvFile(readFileSync(file, 'utf8'), apiKeyEnv);
      if (value) return value;
    } catch {
      continue;
    }
  }
  return '';
}

export function createProviderRegistry({
  config = {},
  env = process.env,
  fetchImpl = globalThis.fetch,
  logger = () => {}
} = {}) {
  const records = new Map();
  const log = (event, fields) => {
    try {
      logger({ event, ...fields });
    } catch {
      return;
    }
  };

  function recordMetadata(record) {
    try {
      return mergeMetadata(record.provider, record.spec, record.apiKey);
    } catch (error) {
      log('registry.metadata_failed', { id: record.id, error: safeReason(error) });
      return publicMetadata(record.spec, record.id, record.apiKey);
    }
  }

  function register(spec) {
    if (!spec || typeof spec !== 'object') throw new Error('Invalid provider spec');
    if (typeof spec.id !== 'string' || spec.id.trim().length === 0) throw new Error('Invalid provider id');
    if (typeof spec.baseURL !== 'string' || !/^https?:\/\//i.test(spec.baseURL)) throw new Error('Invalid provider baseURL');

    const id = spec.id.trim();
    const resolved = { ...spec, id };
    const envKey = typeof spec.apiKeyEnv === 'string' && env && env[spec.apiKeyEnv];
    if (!resolved.apiKey && envKey) resolved.apiKey = String(envKey);

    let provider;
    if (typeof spec.factory === 'function') {
      provider = spec.factory(resolved, { env, fetchImpl, logger });
      if (provider && typeof provider.then === 'function') throw new Error('Provider factory must be synchronous');
    } else {
      provider = createOpenAICompatibleProvider(resolved, { fetchImpl, logger });
    }
    if (!provider || typeof provider.complete !== 'function') throw new Error('Invalid provider instance');

    const providerId = typeof provider.id === 'string' && provider.id.length > 0 ? provider.id : id;
    const providerSpec = { ...resolved, id: providerId };
    const fallbackMetadata = publicMetadata(providerSpec, providerId, resolved.apiKey);
    const normalized = {
      id: providerId,
      metadata() {
        return mergeMetadata(provider, providerSpec, resolved.apiKey);
      },
      health: typeof provider.health === 'function'
        ? provider.health.bind(provider)
        : async ({ signal } = {}) => ({
            id: providerId,
            ok: true,
            latencyMs: 0,
            models: fallbackMetadata.models,
            error: null,
            ...(signal?.aborted ? { ok: false, error: safeReason(signal.reason ?? 'aborted') } : {})
          }),
      complete: provider.complete.bind(provider)
    };

    records.set(providerId, {
      id: providerId,
      provider: normalized,
      spec: providerSpec,
      apiKey: resolved.apiKey
    });
    log('registry.register', { id: providerId });
    return recordMetadata(records.get(providerId));
  }

  function list() {
    return [...records.values()].map(recordMetadata);
  }

  function get(id) {
    return records.get(String(id))?.provider;
  }

  async function check(id) {
    const safeId = safeReason(id);
    const record = records.get(String(id));
    if (!record) {
      return { id: safeId, ok: false, latencyMs: 0, models: [], error: `Unknown provider: ${safeId}` };
    }
    try {
      const result = await record.provider.health();
      return {
        id: safeId,
        ok: result?.ok === true,
        latencyMs: Number(result?.latencyMs) || 0,
        models: Array.isArray(result?.models) ? result.models : [],
        error: result?.error ? safeReason(result.error) : null
      };
    } catch (error) {
      const reason = safeReason(error);
      log('registry.check_failed', { id: safeId, error: reason });
      return { id: safeId, ok: false, latencyMs: 0, models: [], error: reason };
    }
  }

  async function checkAll() {
    return Promise.all([...records.keys()].map(check));
  }

  async function complete(id, args) {
    const provider = get(id);
    if (!provider) throw new Error(`Unknown provider: ${safeReason(id)}`);
    return provider.complete(args);
  }

  const api = { register, list, get, check, checkAll, complete, route: (args) => createRouter({ registry: api, logger }).route(args) };

  if (Array.isArray(config?.providers)) {
    for (const spec of config.providers) register(spec);
  }

  return api;
}

export function registerFreeLLMAPI(
  registry,
  {
    baseURL = 'http://127.0.0.1:3001/v1',
    envFile = '/workspaces/Final-project/.freellmapi/.env',
    apiKeyEnv = 'FREELLMAPI_API_KEY',
    model = 'auto',
    env = process.env,
    stateEnvFile,
    stateDir
  } = {}
) {
  const runtimeEnvFile = stateEnvFile || (stateDir ? join(stateDir, 'freellmapi.env') : '');
  const apiKey = readApiKey(apiKeyEnv, [envFile, runtimeEnvFile], env);
  const spec = {
    id: 'freellmapi',
    name: 'FreeLLMAPI',
    kind: 'openai-compatible',
    baseURL,
    apiKey,
    models: ['auto'],
    defaultModel: model,
    contextWindow: 1048576,
    maxOutput: 65536,
    cost: 0,
    speed: 'fast',
    capabilities: ['chat', 'code', 'json', 'long-context'],
    ...(apiKey ? {} : { warning: 'no API key found' })
  };
  return registry.register(spec);
}

export function registerOpenCodeProvider(registry, { baseURL = 'http://127.0.0.1:4096/v1' } = {}) {
  return registry.register({
    id: 'opencode',
    name: 'OpenCode',
    kind: 'openai-compatible',
    baseURL,
    apiKey: '',
    models: ['opencode/big-pickle'],
    defaultModel: 'opencode/big-pickle',
    contextWindow: 262144,
    maxOutput: 65536,
    cost: 0,
    speed: 'fast',
    capabilities: ['chat', 'code', 'tools', 'json']
  });
}
