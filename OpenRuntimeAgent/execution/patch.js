import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync, renameSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export function parseUnifiedDiff(patch) {
  const lines = String(patch || '').split(/\r?\n/);
  const files = [];
  let current = null;
  let hunk = null;

  for (const line of lines) {
    const oldHeader = line.match(/^--- (.+)$/);
    const newHeader = line.match(/^\+\+\+ (.+)$/);
    if (oldHeader) {
      current = { oldPath: stripPath(oldHeader[1]), newPath: '', hunks: [] };
      continue;
    }
    if (newHeader && current) {
      current.newPath = stripPath(newHeader[1]);
      files.push(current);
      continue;
    }
    const hunkHeader = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkHeader && current) {
      hunk = { oldStart: Number(hunkHeader[1]), newStart: Number(hunkHeader[2]), lines: [] };
      current.hunks.push(hunk);
      continue;
    }
    if (hunk && /^[ +\-\\]/.test(line)) hunk.lines.push(line);
  }
  return files.filter((file) => file.newPath);
}

function stripPath(value) {
  let path = value.trim().split('\t')[0];
  if (path === '/dev/null') return '';
  path = path.replace(/^(a|b)\//, '');
  return path;
}

function applyHunks(original, hunks) {
  const source = original ? original.split('\n') : [];
  const result = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const start = Math.max(0, Math.min(source.length, hunk.oldStart - 1));
    while (cursor < start) result.push(source[cursor++]);
    for (const line of hunk.lines) {
      if (line.startsWith('\\')) continue;
      if (line.startsWith('-')) {
        const expected = line.slice(1);
        if (source[cursor] !== expected) {
          throw new Error(`patch context mismatch at line ${cursor + 1}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(source[cursor])}`);
        }
        cursor += 1;
      } else if (line.startsWith('+')) {
        result.push(line.slice(1));
      } else if (line.startsWith(' ')) {
        const expected = line.slice(1);
        if (source[cursor] !== expected) {
          throw new Error(`patch context mismatch at line ${cursor + 1}`);
        }
        result.push(source[cursor++]);
      }
    }
  }
  while (cursor < source.length) result.push(source[cursor++]);
  return result.join('\n');
}

export function generateUnifiedDiff(oldText, newText, path = 'file') {
  const before = String(oldText || '').split('\n');
  const after = String(newText || '').split('\n');
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1;
  const removed = before.slice(prefix, before.length - suffix);
  const added = after.slice(prefix, after.length - suffix);
  if (!removed.length && !added.length) return '';
  const context = before.slice(Math.max(0, prefix - 3), prefix);
  const trailing = before.slice(before.length - suffix, before.length - suffix + 3);
  const body = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${prefix - context.length + 1},${context.length + removed.length + suffix} +${prefix - context.length + 1},${context.length + added.length + suffix} @@`,
    ...context.map((line) => ` ${line}`),
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    ...trailing.map((line) => ` ${line}`)
  ];
  return `${body.join('\n')}\n`;
}

export function createPatchEngine({ root = process.cwd(), backupsDir = null, events = null } = {}) {
  const base = resolve(root);
  const backupRoot = backupsDir ? resolve(backupsDir) : join(base, '.ora-state', 'backups');

  function confined(relative) {
    const raw = String(relative || '');
    if (!raw || raw.includes('\0')) throw new Error('invalid path');
    const absolute = resolve(base, raw);
    if (absolute !== base && !absolute.startsWith(`${base}/`)) throw new Error(`path outside repository: ${raw}`);
    let probe = dirname(absolute);
    while (probe !== base && probe.startsWith(`${base}/`)) {
      if (existsSync(probe) && lstatSync(probe).isSymbolicLink()) {
        throw new Error(`symlink traversal refused: ${raw}`);
      }
      probe = dirname(probe);
    }
    if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) {
      throw new Error(`symlink target refused: ${raw}`);
    }
    return absolute;
  }

  function hash(content) {
    let value = 0;
    for (let index = 0; index < content.length; index += 1) {
      value = ((value << 5) - value + content.charCodeAt(index)) | 0;
    }
    return String(value);
  }

  function backup(path, content) {
    mkdirSync(backupRoot, { recursive: true });
    const name = `${path.replace(/[^a-zA-Z0-9._-]/g, '_')}.${Date.now()}.${randomUUID().slice(0, 6)}.bak`;
    const target = join(backupRoot, name);
    writeFileSync(target, content, 'utf8');
    return target;
  }

  function writeFile(relative, content) {
    const target = confined(relative);
    const before = existsSync(target) ? readFileSync(target, 'utf8') : null;
    mkdirSync(dirname(target), { recursive: true });
    const backupPath = before === null ? null : backup(relative, before);
    const tmp = `${target}.${randomUUID()}.tmp`;
    writeFileSync(tmp, String(content ?? ''), 'utf8');
    renameSync(tmp, target);
    const after = readFileSync(target, 'utf8');
    const change = {
      path: relative,
      action: before === null ? 'created' : 'modified',
      beforeHash: before === null ? null : hash(before),
      afterHash: hash(after),
      backupPath,
      diff: generateUnifiedDiff(before || '', after, relative)
    };
    events?.emit('fs:write', { path: relative, action: change.action });
    return change;
  }

  function applyPatch({ patch = '', dryRun = false } = {}) {
    const files = parseUnifiedDiff(patch);
    if (!files.length) throw new Error('no files found in patch');
    const changes = [];
    const errors = [];
    for (const file of files) {
      const targetPath = file.newPath || file.oldPath;
      try {
        const target = confined(targetPath);
        const before = existsSync(target) ? readFileSync(target, 'utf8') : '';
        const after = applyHunks(before, file.hunks);
        const change = {
          path: targetPath,
          action: before ? 'modified' : 'created',
          beforeHash: hash(before),
          afterHash: hash(after),
          diff: generateUnifiedDiff(before, after, targetPath)
        };
        if (!dryRun) {
          mkdirSync(dirname(target), { recursive: true });
          const backupPath = before ? backup(targetPath, before) : null;
          const tmp = `${target}.${randomUUID()}.tmp`;
          writeFileSync(tmp, after, 'utf8');
          renameSync(tmp, target);
          change.backupPath = backupPath;
          events?.emit('fs:patch', { path: targetPath, action: change.action });
        }
        changes.push(change);
      } catch (error) {
        errors.push({ path: targetPath, error: error.message });
      }
    }
    return { ok: errors.length === 0, applied: !dryRun && errors.length === 0, dryRun, changes, errors };
  }

  return { writeFile, applyPatch, parseUnifiedDiff, generateUnifiedDiff, confined, hash, backupRoot };
}
