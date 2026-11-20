import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitHubClient } from '../cloud/github.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SOURCE_BRANCH = process.env.ORA_SOURCE_BRANCH || 'ora-app';
const IGNORED = new Set(['node_modules', '.git']);
const IGNORED_PREFIX = '.ora-state';
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function collect(dir, base = ROOT, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED.has(entry.name) || entry.name.startsWith(IGNORED_PREFIX)) continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) collect(full, base, out);
    else if (entry.isFile() && statSync(full).size <= MAX_FILE_BYTES) {
      out.push({ path: `OpenRuntimeAgent/${relative(base, full).split(sep).join('/')}`, content: readFileSync(full, 'utf8') });
    }
  }
  return out;
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required');
  const github = createGitHubClient({ token, repository: process.env.GITHUB_REPOSITORY || undefined });
  const files = collect(ROOT).sort((a, b) => a.path.localeCompare(b.path));
  const existing = await github.getRef(SOURCE_BRANCH);
  const baseSha = existing || await github.getRef('main');
  if (!baseSha) throw new Error('Neither ora-app nor main exists in this repository');
  const { data: baseCommit } = await github.request(`/git/commits/${baseSha}`);
  const tree = await github.request('/git/trees', {
    method: 'POST',
    body: {
      base_tree: baseCommit.tree.sha,
      tree: files.map((file) => ({ path: file.path, type: 'blob', mode: '100644', content: file.content }))
    }
  });
  const commit = await github.request('/git/commits', {
    method: 'POST',
    body: {
      message: `ora: sync application source (${files.length} files)`,
      tree: tree.data.sha,
      parents: [baseSha]
    }
  });
  if (existing) {
    await github.request(`/git/refs/heads/${SOURCE_BRANCH}`, { method: 'PATCH', body: { sha: commit.data.sha, force: false } });
  } else {
    await github.request('/git/refs', { method: 'POST', body: { ref: `refs/heads/${SOURCE_BRANCH}`, sha: commit.data.sha } });
  }
  process.stdout.write(`${JSON.stringify({ ok: true, branch: SOURCE_BRANCH, files: files.length, commit: commit.data.sha }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
