import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../../core/config.js';
import { createPermissions, createApprovalGate, redact, redactObject, collectSecretValues } from '../../security/index.js';

function roots() {
  mkdirSync(join(PROJECT_ROOT, '.ora-state-tests'), { recursive: true });
  const dir = mkdtempSync(join(PROJECT_ROOT, '.ora-state-tests/security-'));
  const outside = mkdtempSync(join(PROJECT_ROOT, '.ora-state-tests/outside-'));
  writeFileSync(join(outside, 'secret.txt'), 'outside data');
  symlinkSync(outside, join(dir, 'escape'));
  return { dir, outside };
}

function config(overrides = {}) {
  return {
    runtime: { cwd: PROJECT_ROOT },
    security: {
      approvalMode: 'manual',
      allowNetwork: false,
      requireApproval: ['shell', 'write', 'network', 'external'],
      deniedPaths: ['.env', '*.pem', '.ora-state/**'],
      ...overrides
    }
  };
}

test('permissions confine paths, traversal and symlink escapes', () => {
  const { dir } = roots();
  const permissions = createPermissions({ config: config(), roots: [dir] });
  assert.equal(permissions.confined('src/file.txt').allowed, true);
  assert.equal(permissions.confined('../outside').allowed, false);
  assert.equal(permissions.confined('/etc/passwd').allowed, false);
  assert.equal(permissions.confined('escape/secret.txt').allowed, false);
  assert.equal(permissions.confined('.env').allowed, false);
  assert.equal(permissions.confined('key.pem').allowed, false);
});

test('permissions classify destructive and network commands as critical', () => {
  const { dir } = roots();
  const permissions = createPermissions({ config: config(), roots: [dir] });
  assert.equal(permissions.assess({ tool: 'shell.exec', command: 'rm -rf /tmp/x' }).risk, 'critical');
  assert.equal(permissions.assess({ tool: 'shell.exec', command: 'find . -name x -delete' }).risk, 'critical');
  assert.equal(permissions.assess({ tool: 'shell.exec', command: 'curl https://example.com' }).requiresApproval, true);
  assert.equal(permissions.assess({ tool: 'repo.scan' }).requiresApproval, false);
});

test('approval gate mode can be switched at runtime', async () => {
  const gate = createApprovalGate({ mode: 'manual' });
  const denied = await gate.request({ action: 'fs.write', risk: 'medium' });
  assert.equal(denied.approved, false);
  gate.mode = 'auto';
  assert.equal(gate.mode, 'auto');
  const approved = await gate.request({ action: 'fs.write', risk: 'medium' });
  assert.equal(approved.approved, true);
  gate.mode = 'manual';
});

test('auto approval mode only allows allowlisted commands and blocks external integrations', async () => {
  const { dir } = roots();
  const gate = createApprovalGate({ mode: 'auto' });
  const permissions = createPermissions({ config: config({ approvalMode: 'auto' }), roots: [dir], approvalGate: gate });
  const safe = await permissions.authorize({ tool: 'shell.exec', command: 'node --test' });
  const unsafe = await permissions.authorize({ tool: 'shell.exec', command: 'node -e "process.exit(0)"' });
  const adapter = await permissions.authorize({ tool: 'adapter.execute' });
  assert.equal(safe.approved, true);
  assert.equal(unsafe.approved, false);
  assert.equal(adapter.approved, false);
});

test('approval gate supports manual, auto and deny modes', async () => {
  const auto = createApprovalGate({ mode: 'auto' });
  const denied = createApprovalGate({ mode: 'deny' });
  let answer = null;
  const manual = createApprovalGate({ mode: 'manual', prompt: () => new Promise((resolvePromise) => { answer = resolvePromise; }) });
  assert.equal((await auto.request({ action: 'fs.write', risk: 'medium' })).approved, true);
  assert.equal((await denied.request({ action: 'fs.write' })).approved, false);
  const pending = manual.request({ action: 'fs.write', risk: 'medium' });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(manual.pending().length, 1);
  manual.approve(manual.pending()[0].id, 'approved by operator');
  answer({ approved: true });
  assert.equal((await pending).approved, true);
  assert.equal(manual.pending().length, 0);
});

test('redaction preserves key labels and removes secret material', () => {
  const env = { ...process.env, ORA_TEST_TOKEN: 'value-secret-9876543210' };
  const text = 'url=?api_key=abcdef1234567890&x=1 Authorization: Bearer abcDEF123456xyz key: sk-abcdefghijklmnop AKIAIOSFODNN7EXAMPLE value-secret-9876543210';
  const redacted = redact(text, { env });
  assert.match(redacted, /\?api_key=\[REDACTED\]/);
  assert.match(redacted, /Bearer \[REDACTED\]/);
  assert.doesNotMatch(redacted, /abcdef1234567890/);
  assert.doesNotMatch(redacted, /AKIAIOSFODNN7EXAMPLE/);
  assert.doesNotMatch(redacted, /value-secret-9876543210/);
  assert.deepEqual(redactObject({ author: 'Bob Smith', api_key: 'secret-abcdef123' }, { env }), {
    author: 'Bob Smith',
    api_key: '[REDACTED]'
  });
  assert.ok(collectSecretValues(env).includes('value-secret-9876543210'));
});

test('shell environment sanitizer rejects pre-execution injection keys', async () => {
  const { sanitizeEnv } = await import('../../execution/shell.js');
  const env = sanitizeEnv({ BASH_ENV: '/tmp/evil', LD_PRELOAD: '/tmp/evil.so', NODE_OPTIONS: '--require evil', SAFE_FLAG: 'yes' }, { PATH: '/bin' });
  assert.equal(env.BASH_ENV, undefined);
  assert.equal(env.LD_PRELOAD, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.SAFE_FLAG, 'yes');
  assert.equal(env.PATH, '/bin');
});
