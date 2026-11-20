import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';

const PACKAGE = {
  name: 'ora-cloud-sandbox',
  version: '1.0.0',
  private: true,
  type: 'module',
  scripts: { check: 'node --check index.js', test: 'node --test' }
};

const INDEX = `export function greet(name = 'world') {
  return \`hello, \${name}\`;
}
`;

const TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { greet } from './index.js';

test('greet returns a greeting', () => {
  assert.equal(greet('ora'), 'hello, ora');
});
`;

function listFiles(dir, base = dir) {
  const files = [];
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.ora' || entry.name.startsWith('.ora-state')) continue;
      files.push(...listFiles(full, base));
    } else if (entry.isFile() && statSync(full).size < 200000) {
      files.push(relative(base, full).split(sep).join('/'));
    }
  }
  return files.sort();
}

export function createSandbox({ root, taskId }) {
  if (!/^task-[a-z0-9-]{6,80}$/.test(String(taskId))) throw new Error('Invalid task id for sandbox');
  const workspace = resolve(root, String(taskId));
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'package.json'), `${JSON.stringify(PACKAGE, null, 2)}\n`, 'utf8');
  writeFileSync(join(workspace, 'index.js'), INDEX, 'utf8');
  writeFileSync(join(workspace, 'index.test.js'), TEST, 'utf8');
  writeFileSync(join(workspace, 'README.md'), `# ORA cloud sandbox\n\nTask: ${taskId}\n\nThis is an isolated, controlled workspace. Files written here are discarded after the run; the resulting diff is stored as task evidence.\n`, 'utf8');
  return { root: workspace, files: listFiles(workspace) };
}

export function snapshotFiles(root) {
  const result = {};
  for (const path of listFiles(root)) {
    try { result[path] = readFileSync(join(root, path), 'utf8'); } catch {}
  }
  return result;
}

export function changedFiles(before, after) {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changes = [];
  for (const path of [...paths].sort()) {
    const previous = before[path] ?? null;
    const current = after[path] ?? null;
    if (previous === current) continue;
    changes.push({
      path,
      action: previous === null ? 'created' : current === null ? 'deleted' : 'modified',
      before: previous === null ? null : previous.slice(0, 20000),
      after: current === null ? null : current.slice(0, 20000)
    });
  }
  return changes;
}
