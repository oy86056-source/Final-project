import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateRequest, isAllowedCommand, validatePath } from '../../cloud/validate.js';
import { createCloudStore } from '../../cloud/store.js';
import { createSandbox, snapshotFiles, changedFiles } from '../../cloud/workspace.js';

function fakeGithub() {
  const files = new Map([
    ['tasks/index.json', JSON.stringify({ version: 1, tasks: [] })]
  ]);
  return {
    files,
    async listDirectory(path, ref) {
      assert.equal(path, 'tasks');
      assert.equal(ref, 'ora-state');
      return [...files.keys()].filter((key) => key.startsWith('tasks/') && key !== 'tasks/index.json').map((key) => ({ name: key.split('/').pop(), type: 'file' }));
    },
    async getJson(path, ref) {
      assert.equal(ref, 'ora-state');
      const value = files.get(path);
      return value === undefined ? null : JSON.parse(value);
    },
    async getFile(path, ref) {
      assert.equal(ref, 'ora-queue');
      const content = files.get(`queue:${path}`);
      return content === undefined
        ? { path, content: '', exists: false, sha: null }
        : { path, content, exists: true, sha: 'sha' };
    },
    async putFile(path, content, { branch }) {
      files.set(branch === 'ora-queue' ? `queue:${path}` : path, content);
      return { path, branch };
    },
    async deleteFile(path) {
      files.delete(`queue:${path}`);
      return true;
    }
  };
}

test('cloud validation confines file paths', () => {
  assert.equal(validatePath('notes/ok.md'), 'notes/ok.md');
  assert.throws(() => validatePath('../outside.md'), /Invalid file path|inside the sandbox/);
  assert.throws(() => validatePath('/etc/passwd'), /Invalid file path|inside the sandbox/);
  assert.throws(() => validatePath('a/../../b'), /Invalid file path|inside the sandbox/);
});

test('cloud validation restricts commands to the safe allowlist', () => {
  assert.equal(isAllowedCommand('npm run check'), true);
  assert.equal(isAllowedCommand('node --check src/app.js'), true);
  assert.equal(isAllowedCommand('rm -rf /'), false);
  assert.equal(isAllowedCommand('curl https://example.com'), false);
  assert.equal(isAllowedCommand('npm install evil'), false);
});

test('cloud validation accepts bounded specs and rejects unsafe ones', () => {
  const task = validateRequest({
    id: 'task-cloud-test-1',
    goal: 'create a note and verify it',
    spec: {
      files: [{ path: 'notes/n.md', content: 'hello' }],
      verification: { command: 'npm run check' }
    }
  });
  assert.equal(task.mode, 'offline-deterministic');
  assert.equal(task.spec.files[0].path, 'notes/n.md');
  assert.throws(() => validateRequest({ id: 'task-cloud-x', goal: 'valid goal text', spec: { commands: ['rm -rf /'] } }), /allowlist/);
  assert.throws(() => validateRequest({ id: 'task-cloud-x', goal: 'valid goal text', spec: { files: [{ path: '../x' }] } }), /Invalid file path|sandbox/);
});

test('cloud store persists task records and the index', async () => {
  const github = fakeGithub();
  const store = createCloudStore({ github });
  const task = { id: 'task-cloud-store-1', status: 'completed', goal: 'verify', createdAt: new Date().toISOString() };
  await store.saveTask(task);
  const loaded = await store.getTask(task.id);
  assert.equal(loaded.status, 'completed');
  const tasks = await store.listTasks();
  assert.deepEqual(tasks.map((item) => item.id), [task.id]);
  assert.deepEqual(await store.listTaskIds(), [task.id]);
});

test('cloud store writes and clears cancellation markers', async () => {
  const github = fakeGithub();
  const store = createCloudStore({ github });
  assert.equal(await store.readCancelMarker('task-cloud-cancel-1'), false);
  await store.writeCancelMarker('task-cloud-cancel-1', true);
  assert.equal(await store.readCancelMarker('task-cloud-cancel-1'), true);
  await store.writeCancelMarker('task-cloud-cancel-1', false);
  assert.equal(await store.readCancelMarker('task-cloud-cancel-1'), false);
});

test('sandbox is confined and changed files are captured', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ora-sandbox-test-'));
  try {
    const sandbox = createSandbox({ root: dir, taskId: 'task-sandbox-test-1' });
    const before = snapshotFiles(sandbox.root);
    assert.ok(before['index.js']);
    writeFileSync(join(sandbox.root, 'notes.md'), 'new');
    const changes = changedFiles(before, snapshotFiles(sandbox.root));
    assert.equal(changes.length, 1);
    assert.equal(changes[0].path, 'notes.md');
    assert.equal(changes[0].action, 'created');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
