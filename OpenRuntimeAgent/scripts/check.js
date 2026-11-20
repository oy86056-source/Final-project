import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PROJECT_ROOT } from '../index.js';

const SKIP_DIRS = new Set(['node_modules', '.git', '.ora-state', '.ora-state-dev', '.ora-state-smoke', '.ora-state-tests']);

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walk(path, files);
    } else if (entry.endsWith('.js') || entry.endsWith('.json')) {
      files.push(path);
    }
  }
  return files;
}

export function runChecks({ root = PROJECT_ROOT } = {}) {
  const files = walk(root);
  const failures = [];
  for (const file of files) {
    const rel = relative(root, file);
    try {
      if (file.endsWith('.json')) JSON.parse(readFileSync(file, 'utf8'));
      else execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (error) {
      failures.push({ file: rel, error: String(error.stderr || error.message).slice(0, 500) });
    }
  }
  return { ok: failures.length === 0, checked: files.length, failures };
}

if (process.argv[1] && process.argv[1].endsWith('check.js')) {
  const result = runChecks();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}
