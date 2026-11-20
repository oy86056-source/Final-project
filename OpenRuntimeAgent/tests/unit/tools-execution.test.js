import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../../core/config.js';
import { createRepoIntelligence } from '../../repo-intelligence/index.js';
import { createToolRegistry } from '../../tools/registry.js';
import { createPermissions, createApprovalGate } from '../../security/permissions.js';
import { createShellExecutor, sanitizeEnv } from '../../execution/shell.js';
import { createPatchEngine, parseUnifiedDiff, generateUnifiedDiff } from '../../execution/patch.js';

function fixture() {
  mkdirSync(join(PROJECT_ROOT, '.ora-state-tests'), { recursive: true });
  const dir = mkdtempSync(join(PROJECT_ROOT, '.ora-state-tests/tools-'));
  writeFileSync(join(dir, 'README.md'), '# Tool fixture\n\nHello tools.\n');
  writeFileSync(join(dir, 'data.txt'), 'alpha\nbeta\ngamma\n');
  return dir;
}

function harness(dir, mode = 'auto') {
  const events = { emit() {} };
  const approvalGate = createApprovalGate({ mode });
  const permissions = createPermissions({
    config: { runtime: { cwd: dir }, security: { approvalMode: mode, allowNetwork: false, requireApproval: ['shell', 'write'], deniedPaths: [] } },
    roots: [dir],
    approvalGate
  });
  const repo = createRepoIntelligence({ root: dir });
  const shell = createShellExecutor({ root: dir, events });
  const patch = createPatchEngine({ root: dir, backupsDir: join(dir, '.backups'), events });
  const tools = createToolRegistry({ permissions, events, repo, shell, patch, config: { repo: {} } });
  tools.registerBuiltins();
  return { tools, permissions, approvalGate, repo, shell, patch };
}

test('tool registry lists builtins and reads repository files', async () => {
  const dir = fixture();
  const { tools } = harness(dir);
  const names = tools.list().map((tool) => tool.name);
  for (const name of ['fs.read', 'fs.list', 'fs.write', 'fs.patch', 'shell.exec', 'repo.scan', 'repo.search', 'repo.context', 'git.diff']) {
    assert.ok(names.includes(name), `missing ${name}`);
  }
  const result = await tools.invoke('fs.read', { path: 'README.md' });
  assert.equal(result.ok, true);
  assert.match(result.output, /Hello tools/);
  const denied = await tools.invoke('fs.read', { path: '../outside.txt' });
  assert.equal(denied.ok, false);
  assert.equal(denied.denied, true);
});

test('controlled write, patch and shell tools work with safeguards', async () => {
  const dir = fixture();
  const { tools } = harness(dir);
  const written = await tools.invoke('fs.write', { path: 'notes.txt', content: 'one\ntwo\n' });
  assert.equal(written.ok, true);
  assert.equal(readFileSync(join(dir, 'notes.txt'), 'utf8'), 'one\ntwo\n');
  const patchText = '--- a/notes.txt\n+++ b/notes.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+ TWO\n';
  const patched = await tools.invoke('fs.patch', { patch: patchText });
  assert.equal(patched.ok, true);
  assert.match(readFileSync(join(dir, 'notes.txt'), 'utf8'), / TWO/);
  const executed = await tools.invoke('shell.exec', { command: 'node -e "process.stdout.write(String(6*7))"' });
  assert.equal(executed.ok, false, 'arbitrary node -e must be blocked in auto mode');
  const safe = await tools.invoke('shell.exec', { command: 'node --test' });
  assert.equal(safe.ok, true, 'allowlisted verification command should run');
});

test('tool invocation times out and redacts data output', async () => {
  const dir = fixture();
  const { tools } = harness(dir);
  tools.register({
    name: 'slow.secret',
    description: 'test',
    inputSchema: {},
    risk: 'low',
    handler: async () => ({ output: 'ok', data: { text: 'sk-abcdefghijklmnopqrst' } })
  });
  const result = await tools.invoke('slow.secret', {});
  assert.equal(result.ok, true);
  assert.doesNotMatch(JSON.stringify(result.data), /sk-abcdefghijklmnopqrst/);
  tools.register({
    name: 'slow.tool',
    description: 'test',
    inputSchema: {},
    risk: 'low',
    handler: () => new Promise((resolvePromise) => setTimeout(resolvePromise, 5000))
  });
  const timedOut = await tools.invoke('slow.tool', {}, { timeoutMs: 120 });
  assert.equal(timedOut.ok, false);
  assert.match(timedOut.error.message, /abort|timeout|timed out/i);
});

test('patch engine parses and applies unified diffs and refuses traversal', () => {
  const dir = fixture();
  const patch = createPatchEngine({ root: dir, backupsDir: join(dir, '.backups') });
  const original = readFileSync(join(dir, 'data.txt'), 'utf8');
  const diff = generateUnifiedDiff(original, 'alpha\nBETA\ngamma\n', 'data.txt');
  const parsed = parseUnifiedDiff(diff);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].newPath, 'data.txt');
  const result = patch.applyPatch({ patch: diff, dryRun: true });
  assert.equal(result.ok, true);
  assert.equal(result.applied, false);
  assert.equal(readFileSync(join(dir, 'data.txt'), 'utf8'), 'alpha\nbeta\ngamma\n');
  assert.throws(() => patch.writeFile('../escape.txt', 'no'), /outside/);
});

test('shell executor captures output, sanitizes env and stops on timeout', async () => {
  const dir = fixture();
  const shell = createShellExecutor({ root: dir });
  const result = await shell.exec('printf hello && printf err >&2', { timeoutMs: 3000 });
  assert.equal(result.ok, true);
  assert.equal(result.stdout, 'hello');
  assert.equal(result.stderr, 'err');
  assert.equal(sanitizeEnv({ LD_PRELOAD: '/tmp/x' }, {}).LD_PRELOAD, undefined);
  const slow = await shell.exec('sleep 5', { timeoutMs: 120 });
  assert.equal(slow.ok, false);
  assert.equal(slow.timedOut, true);
});
