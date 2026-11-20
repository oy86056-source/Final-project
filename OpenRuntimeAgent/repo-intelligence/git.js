import { execFile } from 'node:child_process';
import { resolve } from 'node:path';

function gitOutput(cwd, args) {
  return new Promise((done) => {
    execFile('git', ['-C', cwd, ...args], {
      cwd,
      timeout: 5000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        LC_ALL: 'C'
      }
    }, (error, stdout) => {
      if (error) {
        done(null);
        return;
      }
      done(String(stdout ?? '').trim());
    });
  });
}

export async function inspectGit(root) {
  const cwd = resolve(typeof root === 'string' && root ? root : process.cwd());
  const inside = await gitOutput(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') {
    return { isRepo: false, branch: null, head: null, dirty: false, remotes: [] };
  }
  const [branch, head, status, remoteList] = await Promise.all([
    gitOutput(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    gitOutput(cwd, ['rev-parse', 'HEAD']),
    gitOutput(cwd, ['status', '--porcelain=v1', '--untracked-files=normal']),
    gitOutput(cwd, ['remote'])
  ]);
  const remotes = remoteList
    ? remoteList.split(/\r?\n/).map((name) => name.trim()).filter(Boolean).sort()
    : [];
  return {
    isRepo: true,
    branch: branch || null,
    head: head || null,
    dirty: Boolean(status),
    remotes
  };
}
