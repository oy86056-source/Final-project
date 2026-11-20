import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../../core/config.js';
import { createRepoIntelligence } from '../../repo-intelligence/index.js';
import { createToolRegistry } from '../../tools/registry.js';
import { createPermissions, createApprovalGate } from '../../security/permissions.js';
import { createShellExecutor } from '../../execution/shell.js';
import { createPatchEngine } from '../../execution/patch.js';
import { createAgentSystem, createAgentRegistry, planSteps, chooseVerification, extractActionsFromModel } from '../../agents/index.js';

function fixture() {
  mkdirSync(join(PROJECT_ROOT, '.ora-state-tests'), { recursive: true });
  const dir = mkdtempSync(join(PROJECT_ROOT, '.ora-state-tests/agents-'));
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'agent-fixture', scripts: { test: 'node --test' } })}\n`);
  writeFileSync(join(dir, 'README.md'), '# Fixture\n');
  return dir;
}

function system(dir, config = {}) {
  const events = { emit() {} };
  const approvalGate = createApprovalGate({ mode: 'auto' });
  const permissions = createPermissions({
    config: { runtime: { cwd: dir }, security: { approvalMode: 'auto', allowNetwork: false, requireApproval: ['shell', 'write'], deniedPaths: [] } },
    roots: [dir],
    approvalGate
  });
  const repo = createRepoIntelligence({ root: dir });
  const shell = createShellExecutor({ root: dir, events });
  const patch = createPatchEngine({ root: dir, backupsDir: join(dir, '.backups'), events });
  const tools = createToolRegistry({ permissions, events, repo, shell, patch, config: { agents: {}, repo: {} } });
  tools.registerBuiltins();
  const agents = createAgentSystem({ tools, repo, events, config });
  tools.bind({ agents });
  return { agents, tools, repo };
}

test('agent registry exposes specialists with tool allowlists', () => {
  const registry = createAgentRegistry();
  const ids = registry.list().map((agent) => agent.id);
  assert.deepEqual(ids, ['architect', 'coder', 'researcher', 'reviewer', 'security', 'tester']);
  assert.equal(registry.get('coder').readOnly, false);
  assert.ok(registry.get('security').tools.includes('repo.context'));
  assert.ok(!registry.get('security').tools.includes('fs.write'));
});

test('planner produces ordered steps from goal and spec', () => {
  const steps = planSteps({
    goal: 'implement feature and test it',
    manifest: { files: [{ path: 'package.json' }], scripts: { test: 'node --test' } },
    spec: {
      files: [{ path: 'src/feature.js', content: 'export const feature = 1;' }],
      verification: { command: 'node --test', reason: 'unit tests' }
    }
  });
  assert.equal(steps[0].tool, 'repo.scan');
  assert.ok(steps.some((step) => step.tool === 'fs.write' && step.args.path === 'src/feature.js'));
  assert.ok(steps.some((step) => step.tool === 'shell.exec' && step.args.command === 'node --test'));
  assert.equal(steps.at(-1).tool, 'git.diff');
  assert.equal(chooseVerification({ scripts: { check: 'npm run check' } }).command, 'npm run check');
  assert.deepEqual(extractActionsFromModel('```json\n{"actions":[{"tool":"repo.search","args":{"query":"x"}}]}\n```'), [
    { tool: 'repo.search', args: { query: 'x' }, reason: '' }
  ]);
});

test('coder agent writes requested files through allowed tools', async () => {
  const dir = fixture();
  const { agents } = system(dir);
  const result = await agents.delegate({
    role: 'coder',
    goal: 'create a utility',
    context: { edits: [{ path: 'src/util.js', content: 'export const util = 42;\n' }] }
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.filesTouched[0], 'src/util.js');
  assert.equal(readFileSync(join(dir, 'src', 'util.js'), 'utf8'), 'export const util = 42;\n');
  assert.equal(agents.review(result).ok, true);
  const blocked = await agents.delegate({ role: 'security', goal: 'safe review', context: { edits: [{ path: 'bad.js', content: 'x' }] } });
  assert.ok(!blocked.filesTouched.includes('bad.js'));
});

test('parallel delegation serializes overlapping file writes', async () => {
  const dir = fixture();
  const { agents } = system(dir);
  const result = await agents.runParallel([
    { role: 'coder', goal: 'write a', context: { edits: [{ path: 'shared.js', content: 'A' }] } },
    { role: 'coder', goal: 'write b', context: { edits: [{ path: 'shared.js', content: 'B' }] } }
  ], { concurrency: 2 });
  assert.equal(result.results.length, 2);
  assert.equal(readFileSync(join(dir, 'shared.js'), 'utf8'), 'B');
});
