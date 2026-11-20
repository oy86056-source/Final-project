import { readFileSync } from 'node:fs';
import { resolve, fileURLToPath } from 'node:path';
import { createGitHubClient } from '../cloud/github.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SOURCE_DIR = resolve(ROOT, 'deploy', 'workflows');
const TARGET_DIR = '.github/workflows';
const WORKFLOWS = ['ora-task.yml', 'ora-recover.yml'];

async function main() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required');
  const github = createGitHubClient({ token, repository: process.env.GITHUB_REPOSITORY || undefined });
  const installed = [];
  for (const name of WORKFLOWS) {
    const content = readFileSync(resolve(SOURCE_DIR, name), 'utf8');
    await github.putFile(`${TARGET_DIR}/${name}`, content, {
      branch: 'main',
      message: `ora: install ${name} workflow`
    });
    installed.push(`${TARGET_DIR}/${name}`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, repository: github.repository, installed }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
