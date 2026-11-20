import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createOpenAICompatibleProvider,
  createProviderRegistry,
  registerFreeLLMAPI,
  createRouter,
  scoreProvider
} from '../../providers/index.js';

const KEY = 'sk-test-secret-123456789';
const FREE_KEY = 'test-value-123456789';

const envDir = mkdtempSync(join(tmpdir(), 'ora-freellm-'));
const envFile = join(envDir, '.env');
writeFileSync(envFile, `FREELLMAPI_API_KEY=${FREE_KEY}\n`);

after(() => {
  rmSync(envDir, { recursive: true, force: true });
});

function response(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof data === 'string' ? data : JSON.stringify(data))
  };
}

function makeProvider(fetchImpl) {
  return createOpenAICompatibleProvider({
    id: 'stub',
    name: 'Stub',
    baseURL: 'https://example.test/v1',
    apiKey: KEY,
    models: ['m1'],
    defaultModel: 'm1'
  }, { fetchImpl, logger: () => {} });
}

test('metadata omits the API key', () => {
  const provider = makeProvider(async () => response(200, {}));
  const meta = provider.metadata();

  assert.ok(!('apiKey' in meta), 'metadata must not expose an apiKey field');
  assert.ok(!JSON.stringify(meta).includes(KEY), 'metadata JSON must not contain the key');
  assert.equal(meta.id, 'stub');
  assert.deepEqual(meta.models, ['m1']);
});

test('complete sends Authorization and parses message content', async () => {
  const calls = [];
  const provider = makeProvider(async (url, init) => {
    calls.push({ url, init });
    return response(200, {
      choices: [{ message: { content: 'HELLO' } }],
      usage: { total_tokens: 7 }
    });
  });

  const result = await provider.complete({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 12 });

  assert.equal(result.text, 'HELLO');
  assert.equal(result.provider, 'stub');
  assert.equal(result.model, 'm1');
  assert.equal(result.usage.total_tokens, 7);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.test/v1/chat/completions');
  assert.equal(calls[0].init.method, 'POST');
  assert.ok(calls[0].init.headers.Authorization === `Bearer ${KEY}`,
    'Authorization header must carry the configured key');

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'm1');
  assert.equal(body.max_tokens, 12);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
});

test('health parses the model list', async () => {
  const calls = [];
  const provider = makeProvider(async (url, init) => {
    calls.push({ url, init });
    return response(200, { data: [{ id: 'm1' }, { id: 'm2' }] });
  });

  const health = await provider.health();

  assert.equal(health.ok, true);
  assert.deepEqual(health.models, ['m1', 'm2']);
  assert.equal(health.error, null);
  assert.equal(calls[0].url, 'https://example.test/v1/models');
  assert.equal(calls[0].init.method, 'GET');
});

test('429 is retried and then succeeds', async () => {
  let calls = 0;
  const provider = makeProvider(async () => {
    calls += 1;
    return calls === 1
      ? response(429, { error: 'rate limited' })
      : response(200, { choices: [{ message: { content: 'RECOVERED' } }] });
  });

  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => originalSetTimeout(fn, ms === 250 ? 0 : ms, ...args);
  try {
    const result = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(result.text, 'RECOVERED');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  assert.equal(calls, 2, 'a 429 must be retried exactly once before success');
});

test('401 is not retried and the error is redacted', async () => {
  let calls = 0;
  const provider = makeProvider(async () => {
    calls += 1;
    return response(401, { error: `invalid key ${KEY}` });
  });

  let error = null;
  try {
    await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
  } catch (caught) {
    error = caught;
  }

  assert.ok(error instanceof Error, '401 must reject');
  assert.equal(error.status, 401);
  assert.equal(calls, 1, '401 must not be retried');
  assert.ok(!error.message.includes(KEY), 'error must not expose the key');
  assert.ok(error.message.includes('[REDACTED]'), 'error must be redacted');
});

test('provider registry metadata has no secrets', () => {
  const registry = createProviderRegistry({
    env: {},
    fetchImpl: async () => response(200, {}),
    config: {
      providers: [{ id: 'p1', baseURL: 'https://example.test/v1', apiKey: KEY, models: ['m1'] }]
    }
  });

  const items = registry.list();
  assert.equal(items.length, 1);
  assert.ok(!('apiKey' in items[0]), 'registry metadata must not have an apiKey field');
  assert.ok(!JSON.stringify(items).includes(KEY), 'registry list must not expose keys');
  assert.ok(!JSON.stringify(registry.get('p1').metadata()).includes(KEY), 'provider metadata must not expose keys');
});

test('router choose orders providers by score', async () => {
  const high = {
    id: 'high',
    metadata: () => ({ id: 'high', cost: 0, speed: 'fast', contextWindow: 8192 }),
    complete: async () => ({ text: 'high' })
  };
  const low = {
    id: 'low',
    metadata: () => ({ id: 'low', cost: 5, speed: 'slow', contextWindow: 1024 }),
    complete: async () => ({ text: 'low' })
  };

  assert.ok(scoreProvider(high.metadata(), { task: 'code' }) > scoreProvider(low.metadata(), { task: 'code' }),
    'a cheap fast provider must score higher');

  const registry = {
    list: () => [low.metadata(), high.metadata()],
    get: (id) => (id === 'high' ? high : id === 'low' ? low : undefined)
  };
  const router = createRouter({ registry });

  assert.equal((await router.choose({ task: 'code' })).id, 'high');
  assert.equal((await router.choose({ task: 'code', prefer: ['low'] })).id, 'low');
});

test('route falls back from a failing provider to a healthy one', async () => {
  const attempts = [];
  const failing = {
    id: 'primary',
    metadata: () => ({ id: 'primary', cost: 0, speed: 'fast', contextWindow: 8192, capabilities: ['code'] }),
    complete: async () => {
      attempts.push('primary');
      throw new Error('primary unavailable');
    }
  };
  const healthy = {
    id: 'fallback',
    metadata: () => ({ id: 'fallback', cost: 5, speed: 'slow', contextWindow: 1024 }),
    complete: async () => {
      attempts.push('fallback');
      return { text: 'OK from fallback' };
    }
  };
  const registry = {
    list: () => [failing.metadata(), healthy.metadata()],
    get: (id) => (id === 'primary' ? failing : id === 'fallback' ? healthy : undefined),
    check: async (id) => ({ id, ok: true, latencyMs: 1, models: [], error: null })
  };

  const result = await createRouter({ registry }).route({
    task: 'code',
    messages: [{ role: 'user', content: 'hi' }],
    requireHealthy: true
  });

  assert.equal(result.provider, 'fallback');
  assert.equal(result.text, 'OK from fallback');
  assert.deepEqual(attempts, ['primary', 'fallback']);
});

test('registerFreeLLMAPI keeps the env-file key out of metadata JSON', () => {
  const registry = createProviderRegistry({ env: {}, fetchImpl: async () => response(200, {}) });
  const saved = process.env.FREELLMAPI_API_KEY;
  delete process.env.FREELLMAPI_API_KEY;
  try {
    const metadata = registerFreeLLMAPI(registry, { envFile });
    const metadataJson = JSON.stringify(metadata);

    assert.equal(metadata.id, 'freellmapi');
    assert.ok(!('apiKey' in metadata), 'FreeLLMAPI metadata must not have an apiKey field');
    assert.ok(!metadataJson.includes(FREE_KEY), 'FreeLLMAPI metadata JSON must not contain the key');
    assert.ok(!JSON.stringify(registry.list()).includes(FREE_KEY), 'registry list must not contain the key');
  } finally {
    if (saved !== undefined) process.env.FREELLMAPI_API_KEY = saved;
  }
});

test('registerFreeLLMAPI key lookup prefers process env over env files', () => {
  const registry = createProviderRegistry({ env: {}, fetchImpl: async () => response(200, {}) });
  const saved = process.env.FREELLMAPI_API_KEY;
  const envKey = 'test-key-123';
  process.env.FREELLMAPI_API_KEY = envKey;
  try {
    const metadata = registerFreeLLMAPI(registry, { envFile, stateEnvFile: envFile });
    assert.ok(!('warning' in metadata));
    assert.ok(!JSON.stringify(metadata).includes(envKey));
  } finally {
    if (saved !== undefined) process.env.FREELLMAPI_API_KEY = saved;
    else delete process.env.FREELLMAPI_API_KEY;
  }
});

test('registerFreeLLMAPI key lookup uses explicit envFile before runtime-local env file', () => {
  const registry = createProviderRegistry({ env: {}, fetchImpl: async () => response(200, {}) });
  const saved = process.env.FREELLMAPI_API_KEY;
  delete process.env.FREELLMAPI_API_KEY;
  const tempDir = mkdtempSync(join(tmpdir(), 'ora-freellm-precedence-'));
  const explicitFile = join(tempDir, 'explicit.env');
  const stateFile = join(tempDir, 'freellmapi.env');
  writeFileSync(explicitFile, 'FREELLMAPI_API_KEY=test-key-123\n');
  writeFileSync(stateFile, 'FREELLMAPI_API_KEY=test-key-456\n');
  try {
    const metadata = registerFreeLLMAPI(registry, { envFile: explicitFile, stateEnvFile: stateFile, env: {} });
    assert.ok(!('warning' in metadata));
    assert.ok(!JSON.stringify(metadata).includes('test-key-123'));
    assert.ok(!JSON.stringify(metadata).includes('test-key-456'));
  } finally {
    if (saved !== undefined) process.env.FREELLMAPI_API_KEY = saved;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('registerFreeLLMAPI key lookup falls back to runtime-local env file from stateDir', () => {
  const registry = createProviderRegistry({ env: {}, fetchImpl: async () => response(200, {}) });
  const saved = process.env.FREELLMAPI_API_KEY;
  delete process.env.FREELLMAPI_API_KEY;
  const tempDir = mkdtempSync(join(tmpdir(), 'ora-freellm-statedir-'));
  const stateDir = join(tempDir, '.ora-state');
  mkdirSync(stateDir, { recursive: true });
  const stateFile = join(stateDir, 'freellmapi.env');
  writeFileSync(stateFile, 'FREELLMAPI_API_KEY=test-key-123\n');
  try {
    const metadata = registerFreeLLMAPI(registry, { envFile: join(tempDir, 'missing.env'), stateDir, env: {} });
    assert.ok(!('warning' in metadata));
    assert.ok(!JSON.stringify(metadata).includes('test-key-123'));
  } finally {
    if (saved !== undefined) process.env.FREELLMAPI_API_KEY = saved;
    rmSync(tempDir, { recursive: true, force: true });
  }
});
