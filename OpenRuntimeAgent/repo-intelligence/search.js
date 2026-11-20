import * as fs from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const MAX_FILE_BYTES = 512000;
const DEFAULT_IGNORED_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', '.ora-state', 'coverage', 'vendor', '.cache'
]);

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function inside(rootAbs, targetAbs) {
  const rel = relative(rootAbs, targetAbs);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

function makeIgnoreMatcher(ignore) {
  const compiled = (Array.isArray(ignore) ? ignore : [])
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''))
    .filter(Boolean)
    .map((pattern) => ({
      pattern,
      regex: pattern.includes('*')
        ? new RegExp('^' + pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
        : null
    }));
  return (relPath, name, isDir) => {
    if (isDir && DEFAULT_IGNORED_DIRS.has(name.toLowerCase())) return true;
    for (const entry of compiled) {
      if (entry.regex) {
        if (entry.regex.test(relPath) || entry.regex.test(name)) return true;
        continue;
      }
      if (name === entry.pattern || relPath === entry.pattern || relPath.startsWith(entry.pattern + '/')) return true;
    }
    return false;
  };
}

function looksBinary(buf) {
  const slice = buf.subarray(0, Math.min(buf.length, 8192));
  if (slice.includes(0)) return true;
  let suspicious = 0;
  for (const byte of slice) {
    if (byte < 32 && byte !== 8 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13) suspicious += 1;
  }
  if (suspicious > Math.max(1, slice.length) * 0.05) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(slice);
    return false;
  } catch {
    return true;
  }
}

async function collectFiles(rootAbs, ignored) {
  const found = [];
  async function visit(dirAbs, relDir) {
    let entries;
    try {
      entries = await fs.promises.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => cmp(a.name, b.name));
    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      let absPath = join(dirAbs, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        let real;
        try {
          real = await fs.promises.realpath(absPath);
        } catch {
          continue;
        }
        if (!inside(rootAbs, real)) continue;
        let st;
        try {
          st = await fs.promises.stat(real);
        } catch {
          continue;
        }
        isDir = st.isDirectory();
        isFile = st.isFile();
        if (isDir) continue;
        absPath = real;
      }
      if (isDir) {
        if (ignored(relPath, entry.name, true)) continue;
        await visit(absPath, relPath);
        continue;
      }
      if (!isFile || ignored(relPath, entry.name, false)) continue;
      let st;
      try {
        st = await fs.promises.stat(absPath);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      found.push({ path: relPath.replace(/\\/g, '/'), absPath });
    }
  }
  await visit(rootAbs, '');
  found.sort((a, b) => cmp(a.path, b.path));
  return found;
}

export async function searchRepository(root, query, { limit = 20, ignore = [] } = {}) {
  if (typeof query !== 'string' || query.length === 0) return [];
  const maxResults = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  if (maxResults === 0) return [];
  const rootAbs = resolve(typeof root === 'string' && root ? root : process.cwd());
  let realRoot = rootAbs;
  try {
    realRoot = await fs.promises.realpath(rootAbs);
  } catch {
    return [];
  }
  const ignored = makeIgnoreMatcher(ignore);
  const files = await collectFiles(realRoot, ignored);
  const needle = query.toLowerCase();
  const results = [];
  for (const file of files) {
    let buffer;
    try {
      buffer = await fs.promises.readFile(file.absPath);
    } catch {
      continue;
    }
    if (looksBinary(buffer)) continue;
    const lines = buffer.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const lower = line.toLowerCase();
      let from = 0;
      while (from <= lower.length - needle.length) {
        const index = lower.indexOf(needle, from);
        if (index === -1) break;
        results.push({ path: file.path, line: i + 1, column: index + 1, text: line });
        if (results.length >= maxResults) return results;
        from = index + Math.max(1, needle.length);
      }
    }
  }
  return results;
}
