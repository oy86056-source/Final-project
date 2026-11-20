import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../../index.js';

const CLI = join(PROJECT_ROOT, 'bin', 'ora.js');

function runCli(args, timeout = 30000) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    timeout
  });
  return { ...result, combined: `${result.stdout || ''}${result.stderr || ''}` };
}

function fixture() {
  mkdirSync(join(PROJECT_ROOT, '.ora-state-tests'), { recursive: true });
  const dir = mkdtempSync(join(PROJECT_ROOT, '.ora-state-tests/cli-'));
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'cli-fixture', type: 'module', scripts: { test: 'node --test' } })}\n`);
  writeFileSync(join(dir, 'README.md'), '# CLI fixture\n');
  const specPath = join(dir, 'spec.json');
  writeFileSync(specPath, `${JSON.stringify({
    files: [
      { path: 'src/cli-feature.js', content: 'export const cliFeature = () => "ok";\n' },
      { path: 'tests/cli-feature.test.js', content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { cliFeature } from '../src/cli-feature.js';\ntest('cliFeature', () => assert.equal(cliFeature(), 'ok'));\n" }
    ],
    verification: { command: 'node --test', reason: 'cli e2e verification' }
  }, null, 2)}\n`);
  return { dir, specPath };
}

test('CLI status and scan produce machine-readable output', () => {
  const status = runCli(['status', '--json']);
  assert.equal(status.status, 0, status.combined);
  assert.equal(JSON.parse(status.stdout).product, 'OpenRuntimeAgent');
  const { dir } = fixture();
  const scan = runCli(['scan', '--root', dir, '--json']);
  assert.equal(scan.status, 0, scan.combined);
  assert.ok(JSON.parse(scan.stdout).fileCount >= 2);
});

test('CLI runs an end-to-end task that edits files and verifies with tests', () => {
  const { dir, specPath } = fixture();
  const result = runCli([
    'task', 'run',
    '--root', dir,
    '--state-dir', join(dir, '.ora-state'),
    '--goal', 'implement cli feature and verify with tests',
    '--spec', specPath,
    '--approval', 'auto',
    '--json'
  ], 45000);
  assert.equal(result.status, 0, result.combined.slice(0, 2000));
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.success, true, payload.summary);
  assert.equal(payload.verification.ok, true);
  assert.ok(existsSync(join(dir, 'src', 'cli-feature.js')));
  assert.ok(existsSync(join(dir, 'tests', 'cli-feature.test.js')));
});

test('CLI rejects unsafe paths and unknown commands', () => {
  const { dir } = fixture();
  const denied = runCli(['tools', 'invoke', 'fs.read', '--root', dir, '--args-json', '{"path":"../../etc/passwd"}', '--json']);
  assert.notEqual(denied.status, 0);
  const unknown = runCli(['nonsense']);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.combined, /unknown command/);
});
