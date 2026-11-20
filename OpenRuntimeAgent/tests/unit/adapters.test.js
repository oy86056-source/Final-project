import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdapterRegistry, registerBuiltins, createAdapterLifecycle } from '../../adapters/index.js';

function makeRegistry() {
  const env = { PATH: process.env.PATH || '' };
  const registry = createAdapterRegistry({ env });
  registerBuiltins(registry, { env });
  const lifecycle = createAdapterLifecycle({ registry });
  return { registry, lifecycle };
}

test('registry lists adapters in sorted order and exposes metadata', () => {
  const { registry } = makeRegistry();
  const ids = registry.list().map((item) => item.id);

  assert.deepEqual(ids, ['git', 'node', 'npm', 'opencode', 'pi']);
  assert.deepEqual(ids, [...ids].sort((a, b) => a.localeCompare(b)));

  const node = registry.get('node');
  assert.equal(node.id, 'node');
  assert.equal(node.command, 'node');
  assert.ok(node.capabilities.includes('runtime'));
});

test('discover returns availability entries', async () => {
  const { registry } = makeRegistry();
  const entries = await registry.discover();

  assert.equal(entries.length, 5);
  for (const entry of entries) {
    assert.equal(typeof entry.id, 'string');
    assert.equal(typeof entry.command, 'string');
    assert.equal(typeof entry.available, 'boolean');
  }
  assert.equal(entries.find((entry) => entry.id === 'node').available, true);
});

test('validate node succeeds with a version string', async () => {
  const { registry, lifecycle } = makeRegistry();
  await lifecycle.configure('node', { timeoutMs: 2000 });

  const result = await registry.validate('node');
  assert.equal(result.id, 'node');
  assert.equal(result.ok, true, `validation failed: ${result.reason}`);
  assert.ok(typeof result.version === 'string' && /\d/.test(result.version));
});

test('execute node captures stdout and rejects NUL arguments', async () => {
  const { registry } = makeRegistry();
  const result = await registry.execute('node', {
    args: ['-e', 'process.stdout.write("OK")'],
    timeoutMs: 2000
  });

  assert.equal(result.ok, true, `execution failed: ${result.stderr}`);
  assert.equal(result.stdout, 'OK');
  await assert.rejects(() => registry.execute('node', { args: ['-e', 'bad\0arg'] }), /invalid args/);
});

test('disabled adapter refuses execution and reports failure', async () => {
  const { registry, lifecycle } = makeRegistry();
  await lifecycle.disable('node');

  const validation = await registry.validate('node');
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, 'adapter disabled');
  await assert.rejects(() => registry.execute('node', { args: ['-e', '1'] }), /adapter disabled/);
});

test('lifecycle configure rejects unknown fields and remove deletes adapters', async () => {
  const { registry, lifecycle } = makeRegistry();

  await assert.rejects(() => lifecycle.configure('node', { surprise: true }), /unknown field/);

  const configured = await lifecycle.configure('node', { timeoutMs: 1234, enabled: true });
  assert.equal(configured.timeoutMs, 1234);

  const removed = await lifecycle.remove('pi');
  assert.equal(removed.removed, true);
  assert.equal(registry.get('pi'), undefined);
  assert.ok(!registry.list().some((item) => item.id === 'pi'));
});

test('lifecycle report includes totals and adapter details', async () => {
  const { lifecycle } = makeRegistry();
  const report = await lifecycle.report();

  assert.equal(typeof report.total, 'number');
  assert.ok(Array.isArray(report.adapters));
  assert.equal(report.total, 5);
  assert.equal(report.total, report.adapters.length);
  assert.equal(report.enabled, 5);
  assert.ok(Object.hasOwn(report, 'byKind'));
});
