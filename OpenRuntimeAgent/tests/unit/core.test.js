import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, DEFAULT_CONFIG, PROJECT_ROOT } from '../../core/config.js';
import { createEventBus } from '../../core/events.js';
import { createStateStore } from '../../core/state.js';
import { createTaskManager } from '../../core/task.js';
import { createContextManager } from '../../core/context.js';

function testDir(name) {
  mkdirSync(join(PROJECT_ROOT, '.ora-state-tests'), { recursive: true });
  const dir = mkdtempSync(join(PROJECT_ROOT, `.ora-state-tests/${name}-`));
  return dir;
}

test('loadConfig merges env overrides and validates modes', () => {
  const config = loadConfig({
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      ORA_APPROVAL_MODE: 'deny',
      ORA_MAX_CONCURRENT_AGENTS: '2',
      ORA_DEFAULT_TIMEOUT_MS: '5000',
      ORA_ALLOW_NETWORK: 'true',
      ORA_USE_MODEL: 'false'
    }
  });
  assert.equal(config.security.approvalMode, 'deny');
  assert.equal(config.runtime.maxConcurrentAgents, 2);
  assert.equal(config.runtime.defaultTimeoutMs, 5000);
  assert.equal(config.security.allowNetwork, true);
  assert.equal(config.agents.useModel, false);
  assert.equal(DEFAULT_CONFIG.runtime.checkpointEvery, 3);
  assert.throws(() => loadConfig({ cwd: PROJECT_ROOT, overrides: { security: { approvalMode: 'invalid' } } }), /approvalMode/);
});

test('event bus records redacted structured events and filters history', () => {
  const bus = createEventBus({
    redact: (value) => JSON.parse(JSON.stringify(value).replaceAll('secret-value-123', '[REDACTED]'))
  });
  bus.emit('tool:end', { name: 'model.complete', output: 'secret-value-123' });
  bus.emit('task:status', { status: 'running' });
  const events = bus.history({ type: 'tool:end' });
  assert.equal(events.length, 1);
  assert.equal(events[0].data.output, '[REDACTED]');
  assert.equal(bus.history({ limit: 1 }).length, 1);
  assert.equal(bus.size, 2);
});

test('state store writes atomically, checkpoints and validates restore ids', () => {
  const dir = testDir('state');
  const store = createStateStore({ dir });
  store.update((state) => { state.tasks.task1 = { id: 'task1', status: 'created' }; });
  assert.equal(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).tasks.task1.id, 'task1');
  const checkpoint = store.checkpoint('after-create');
  assert.ok(existsSync(join(dir, 'checkpoints', `${checkpoint.id}.json`)));
  assert.match(checkpoint.id, /^ckpt-/);
  assert.throws(() => store.restore('../state'), /Invalid checkpoint id/);
  store.update((state) => { delete state.tasks.task1; });
  store.restore(checkpoint.id);
  assert.ok(store.load().tasks.task1);
  for (let index = 0; index < 25; index += 1) store.checkpoint(`bulk-${index}`);
  assert.ok(store.listCheckpoints().length <= 20);
});

test('task manager tracks lifecycle, steps and artifacts', () => {
  const dir = testDir('tasks');
  const store = createStateStore({ dir });
  const bus = createEventBus();
  const tasks = createTaskManager({ state: store, events: bus });
  const task = tasks.create({ title: 'demo', goal: 'do work', root: dir });
  assert.equal(task.status, 'created');
  tasks.start(task.id);
  const step = tasks.addStep(task.id, { title: 'write', tool: 'fs.write' });
  tasks.startStep(task.id, step.id);
  tasks.completeStep(task.id, step.id, { ok: true });
  tasks.addArtifact(task.id, { type: 'scan', summary: '5 files' });
  tasks.addCheckpoint(task.id, { id: 'ckpt-test' });
  tasks.complete(task.id, { summary: 'done' });
  const snapshot = tasks.snapshot(task.id);
  assert.equal(snapshot.status, 'completed');
  assert.equal(snapshot.steps[0].status, 'completed');
  assert.equal(snapshot.artifacts[0].type, 'scan');
  assert.equal(tasks.list({ status: 'completed' }).length, 1);
  assert.ok(bus.history({ type: 'task:created' }).length === 1);
});

test('context manager builds bounded prompts', () => {
  const dir = testDir('context');
  const store = createStateStore({ dir });
  const contexts = createContextManager({ state: store });
  contexts.create('task-x', 'system instructions');
  contexts.add('task-x', 'user', 'first message');
  contexts.add('task-x', 'tool', 'x'.repeat(1000));
  const prompt = contexts.buildPrompt('task-x', { maxChars: 100 });
  assert.ok(prompt.includes('system instructions'));
  assert.ok(prompt.length < 400);
  assert.equal(contexts.messages('task-x', { limit: 1 }).length, 1);
});
