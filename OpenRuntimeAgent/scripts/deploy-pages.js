import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitHubClient } from '../cloud/github.js';
import { QUEUE_BRANCH, STATE_BRANCH } from '../cloud/validate.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const UI_DIR = join(ROOT, 'ui');
const FILES = ['index.html', 'app.js', 'styles.css'];

async function main() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required (a fine-grained token with Contents, Actions and Pages write access)');
  const github = createGitHubClient({ token, repository: process.env.GITHUB_REPOSITORY || undefined });

  const uiFiles = {};
  for (const name of FILES) uiFiles[name] = readFileSync(join(UI_DIR, name), 'utf8');

  const pages = await github.createOrphanBranch('gh-pages', uiFiles, 'ora: publish mobile dashboard');
  if (!pages.created) {
    for (const [name, content] of Object.entries(uiFiles)) {
      await github.putFile(name, content, { branch: 'gh-pages', message: 'ora: update mobile dashboard' });
    }
  }

  await github.createOrphanBranch(STATE_BRANCH, {
    'README.md': '# ORA cloud state\n\nTask records and index written by the GitHub Actions worker. Do not edit manually.\n',
    'tasks/index.json': `${JSON.stringify({ version: 1, tasks: [] }, null, 2)}\n`
  }, 'ora: initialize state branch');

  await github.createOrphanBranch(QUEUE_BRANCH, {
    'README.md': '# ORA task queue\n\nThe dashboard writes task requests here and dispatches `ora-task.yml`.\n'
  }, 'ora: initialize queue branch');

  const site = await github.enablePages('gh-pages');
  const pagesUrl = site?.html_url || `https://${github.owner}.github.io/${github.repo}/`;

  process.stdout.write(`${JSON.stringify({
    ok: true,
    repository: github.repository,
    pagesUrl,
    branches: { pages: 'gh-pages', state: STATE_BRANCH, queue: QUEUE_BRANCH },
    publishedFiles: FILES
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
