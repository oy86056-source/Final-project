import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PROJECT_ROOT, createRuntime } from '../../index.js';
import { createDashboardHandler } from '../../ui/server.js';
import { parseArgs } from '../../bin/ora.js';

function fixture(name = 'runtime') {
  mkdirSync(join(PROJECT_ROOT, '.ora-state-tests'), { recursive: true });
  const dir = mkdtempSync(join(PROJECT_ROOT, `.ora-state-tests/${name}-`));
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'runtime-fixture', type: 'module', scripts: { test: 'node --test' } })}\n`);
  writeFileSync(join(dir, 'README.md'), '# Runtime fixture\n');
  writeFileSync(join(dir, 'src.js'), 'export const seed = 1;\n');
  return dir;
}

function makeRuntime(dir) {
  return createRuntime({
    cwd: PROJECT_ROOT,
    root: dir,
    config: {
      runtime: { stateDir: join(dir, '.ora-state'), checkpointEvery: 1, defaultTimeoutMs: 10000 },
      security: { approvalMode: 'auto' }
    }
  });
}

test('runtime status exposes coherent wired modules without secrets', async () => {
  const dir = fixture('status');
  const runtime = makeRuntime(dir);
  const status = await runtime.status();
  assert.equal(status.product, 'OpenRuntimeAgent');
  assert.ok(status.tools.length >= 15);
  assert.equal(status.agents.length, 6);
  assert.ok(status.providers.some((provider) => provider.id === 'freellmapi'));
  assert.ok(status.adapters.total >= 5);
  assert.doesNotMatch(JSON.stringify(status.providers), /sk-/);
});

test('runtime runs a full task with file edits, verification and checkpoints', async () => {
  const dir = fixture('workflow');
  const runtime = makeRuntime(dir);
  const result = await runtime.runTask({
    goal: 'add a computed module and tests',
    title: 'integration workflow',
    spec: {
      files: [
        { path: 'src/derived.js', content: 'export const derived = () => 21 * 2;\n' },
        { path: 'tests/derived.test.js', content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { derived } from '../src/derived.js';\ntest('derived', () => assert.equal(derived(), 42));\n" }
      ],
      verification: { command: 'node --test', reason: 'fixture tests' }
    }
  });
  assert.equal(result.success, true, result.summary);
  assert.equal(result.status, 'completed');
  assert.ok(result.steps.some((step) => step.tool === 'repo.scan' && step.ok));
  assert.ok(result.steps.some((step) => step.tool === 'fs.write' && step.ok));
  assert.equal(result.verification.ok, true);
  assert.ok(result.checkpoints.length >= 2);
  const task = runtime.tasks.snapshot(result.taskId);
  assert.equal(task.status, 'completed');
  assert.ok(task.result.durationMs >= 0);
  assert.ok(existsSync(join(dir, 'src', 'derived.js')));
  assert.ok(existsSync(join(dir, '.ora-state', 'state.json')));
  const eventTypes = runtime.events.history({ limit: 500 }).map((event) => event.type);
  assert.ok(eventTypes.includes('tool:end'));
  assert.ok(eventTypes.includes('task:finished'));
});

test('runtime refuses a failing verification and records failure honestly', async () => {
  const dir = fixture('failure');
  writeFileSync(join(dir, 'bad.test.js'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fails', () => assert.equal(1, 2));\n");
  const runtime = makeRuntime(dir);
  const result = await runtime.runTask({
    goal: 'verify failing tests',
    spec: { verification: { command: 'node --test', reason: 'expect failure' } }
  });
  assert.equal(result.success, false);
  assert.equal(result.status, 'failed');
  assert.match(result.summary, /failed/);
  assert.equal(runtime.tasks.snapshot(result.taskId).status, 'failed');
});

test('resume reuses the existing task and its stored goal', async () => {
  const dir = fixture('resume');
  const runtime = makeRuntime(dir);
  const created = runtime.tasks.create({ title: 'resumable', goal: 'analyze repository', root: dir });
  const result = await runtime.resumeTask(created.id);
  assert.equal(result.taskId, created.id);
  assert.equal(result.success, true);
  assert.ok(result.steps.length > 0);
});

test('local dashboard serves read-only JSON endpoints', async () => {
  const dir = fixture('ui');
  const runtime = makeRuntime(dir);
  const handler = createDashboardHandler({ runtime });
  const response = {
    headers: null,
    status: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; }
  };
  await handler({ url: '/api/status' }, response);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).product, 'OpenRuntimeAgent');
  assert.match(response.headers['content-security-policy'], /default-src 'self'/);
  await handler({ url: '/api/tasks' }, response);
  assert.ok(Array.isArray(JSON.parse(response.body)));
  await handler({ url: '/nope' }, response);
  assert.equal(response.status, 404);
});

test('CLI argument parser handles values, booleans and positional commands', () => {
  const parsed = parseArgs(['task', 'run', 'task-1', '--goal', 'do work', '--json', '--approval=auto', '--limit=5']);
  assert.deepEqual(parsed.positionals, ['task', 'run', 'task-1']);
  assert.equal(parsed.flags.goal, 'do work');
  assert.equal(parsed.flags.json, true);
  assert.equal(parsed.flags.approval, 'auto');
  assert.equal(parsed.flags.limit, '5');
  assert.equal(resolve(PROJECT_ROOT), PROJECT_ROOT);
  assert.ok(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8').includes('openruntimeagent'));
});
