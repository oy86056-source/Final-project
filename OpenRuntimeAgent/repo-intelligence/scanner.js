import * as fs from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { detectProject } from './detect.js';
import { searchRepository } from './search.js';
import { assembleContext } from './context.js';
import { inspectGit } from './git.js';

const DEFAULT_IGNORED_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', '.ora-state', 'coverage', 'vendor', '.cache'
]);

const LANGUAGE_BY_EXT = new Map([
  ['js', 'JavaScript'], ['mjs', 'JavaScript'], ['cjs', 'JavaScript'], ['jsx', 'JavaScript'],
  ['ts', 'TypeScript'], ['tsx', 'TypeScript'], ['py', 'Python'], ['go', 'Go'], ['rs', 'Rust'],
  ['java', 'Java'], ['kt', 'Kotlin'], ['rb', 'Ruby'], ['php', 'PHP'], ['cs', 'C#'],
  ['cpp', 'C++'], ['cc', 'C++'], ['cxx', 'C++'], ['hpp', 'C++'], ['c', 'C'], ['h', 'C'],
  ['swift', 'Swift'], ['sh', 'Shell'], ['bash', 'Shell'], ['sql', 'SQL'], ['html', 'HTML'],
  ['css', 'CSS'], ['scss', 'CSS'], ['vue', 'Vue'], ['svelte', 'Svelte'], ['md', 'Markdown'],
  ['json', 'JSON'], ['yaml', 'YAML'], ['yml', 'YAML'], ['toml', 'TOML']
]);

const LOCK_NAMES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock',
  'poetry.lock', 'cargo.lock', 'gemfile.lock', 'composer.lock', 'deno.lock', 'uv.lock'
]);

const TEST_NAMES = /(?:\.(?:test|spec)\.[A-Za-z0-9]+$|^test_|_test\.|^tests?$|\/tests?\/|\/__tests__\/|\/__mocks__\/)/i;

const CONFIG_NAMES = new Set([
  'package.json', 'tsconfig.json', 'jsconfig.json', 'cargo.toml', 'go.mod', 'go.sum',
  'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'gemfile', 'pom.xml',
  'build.gradle', 'build.gradle.kts', 'composer.json', 'makefile', 'dockerfile',
  'vite.config.js', 'vite.config.ts', 'next.config.js', 'next.config.mjs',
  'webpack.config.js', 'rollup.config.js', 'eslint.config.js', '.eslintrc', '.prettierrc'
]);

const BUILD_DIRS = /(^|\/)(dist|build|out|target|coverage|\.next|\.nuxt|\.output|tmp)(\/|$)/;

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function inside(rootAbs, targetAbs) {
  const rel = relative(rootAbs, targetAbs);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

function normalizeRel(relPath) {
  return relPath.replace(/\\/g, '/');
}

export function classify(relPath) {
  const path = normalizeRel(String(relPath ?? ''));
  const name = basename(path).toLowerCase();
  const lower = path.toLowerCase();
  const ext = extname(name).slice(1).toLowerCase();
  if (LOCK_NAMES.has(name) || name.endsWith('.lock')) return 'lock';
  if (TEST_NAMES.test(path)) return 'test';
  if (BUILD_DIRS.test(lower) || name.endsWith('.min.js') || name.endsWith('.map')) return 'build';
  if (CONFIG_NAMES.has(name) || name.startsWith('.') || ['json', 'yaml', 'yml', 'toml', 'ini', 'env'].includes(ext)) {
    return 'config';
  }
  if (['md', 'mdx', 'rst', 'adoc', 'txt'].includes(ext) || /^readme\b|^license\b|^changelog\b|(^|\/)docs?\//i.test(path)) {
    return 'docs';
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'wav', 'pdf', 'zip', 'gz'].includes(ext)) {
    return 'asset';
  }
  if (LANGUAGE_BY_EXT.has(ext)) return 'source';
  return 'other';
}

function makeIgnoreMatcher(ignore) {
  const patterns = (Array.isArray(ignore) ? ignore : [])
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''))
    .filter(Boolean);
  const compiled = patterns.map((pattern) => ({
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
      const { pattern } = entry;
      if (name === pattern || relPath === pattern || relPath.startsWith(pattern + '/')) return true;
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
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(slice.subarray(0, Math.max(0, slice.length - 4)));
      return false;
    } catch {
      return true;
    }
  }
}

async function isBinaryFile(absPath) {
  let handle;
  try {
    handle = await fs.promises.open(absPath, 'r');
    const buffer = Buffer.allocUnsafe(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return looksBinary(buffer.subarray(0, bytesRead));
  } catch {
    return true;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function walk(rootAbs, maxBytesPerFile, ignored, warnings) {
  const files = [];
  const dirs = [];
  async function visit(dirAbs, relDir) {
    let entries;
    try {
      entries = await fs.promises.readdir(dirAbs, { withFileTypes: true });
    } catch (error) {
      warnings.push(`Unable to read directory: ${relDir || '.'} (${error.code || error.message})`);
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
        let targetStat;
        try {
          targetStat = await fs.promises.stat(real);
        } catch {
          continue;
        }
        isDir = targetStat.isDirectory();
        isFile = targetStat.isFile();
        if (isDir) continue;
        absPath = real;
      }
      if (isDir) {
        if (ignored(relPath, entry.name, true)) continue;
        dirs.push(normalizeRel(relPath));
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
      if (!st.isFile() || st.size > maxBytesPerFile) continue;
      if (await isBinaryFile(absPath)) continue;
      const path = normalizeRel(relPath);
      const ext = extname(path).slice(1).toLowerCase();
      files.push({
        path,
        size: st.size,
        ext,
        category: classify(path),
        language: LANGUAGE_BY_EXT.get(ext) || null
      });
    }
  }
  await visit(rootAbs, '');
  return { files, dirs };
}

async function cacheSignature(rootAbs, maxFiles, maxBytesPerFile, ignore) {
  const parts = [rootAbs, String(maxFiles), String(maxBytesPerFile), JSON.stringify(ignore)];
  try {
    const st = await fs.promises.stat(rootAbs);
    parts.push(`root:${st.mtimeMs}:${st.size}`);
  } catch {
    parts.push('root:missing');
  }
  const samples = [
    'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb',
    'README.md', 'README', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'src', 'index.js', '.git/HEAD'
  ];
  for (const rel of samples) {
    try {
      const st = await fs.promises.lstat(join(rootAbs, rel));
      parts.push(`${rel}:${st.mtimeMs}:${st.size}`);
    } catch {
      parts.push(`${rel}:-`);
    }
  }
  return parts.join('|');
}

async function resolveConfined(rootAbs, relPath) {
  if (typeof relPath !== 'string' || !relPath.trim()) {
    throw new Error('Invalid path: expected a non-empty relative path');
  }
  if (isAbsolute(relPath) || /^[A-Za-z]:[\\/]/.test(relPath) || relPath.includes('\0')) {
    throw new Error(`Path must be relative to the repository root: ${relPath}`);
  }
  if (relPath.split(/[\\/]/).includes('..')) {
    throw new Error(`Path traversal is not allowed: ${relPath}`);
  }
  const absPath = resolve(rootAbs, relPath);
  if (!inside(rootAbs, absPath)) {
    throw new Error(`Path escapes the repository root: ${relPath}`);
  }
  let realRoot = rootAbs;
  try {
    realRoot = await fs.promises.realpath(rootAbs);
  } catch {
  }
  let real;
  try {
    real = await fs.promises.realpath(absPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') throw new Error(`File not found: ${relPath}`);
    throw new Error(`Unable to resolve path: ${relPath}`);
  }
  if (!inside(realRoot, real)) {
    throw new Error(`Path escapes the repository root via symlink: ${relPath}`);
  }
  return real;
}

export function createRepoIntelligence({
  root,
  ignore = [],
  maxFiles = 20000,
  maxBytesPerFile = 512000
} = {}) {
  const rootAbs = resolve(typeof root === 'string' && root ? root : process.cwd());
  const ignoreList = Array.isArray(ignore) ? [...ignore] : [];
  const fileLimit = Number.isFinite(maxFiles) && maxFiles >= 0 ? Math.floor(maxFiles) : 20000;
  const byteLimit = Number.isFinite(maxBytesPerFile) && maxBytesPerFile > 0
    ? Math.floor(maxBytesPerFile)
    : 512000;
  const cache = new Map();

  async function buildManifest() {
    const warnings = [];
    const ignored = makeIgnoreMatcher(ignoreList);
    const { files, dirs } = await walk(rootAbs, byteLimit, ignored, warnings);
    files.sort((a, b) => cmp(a.path, b.path));
    if (files.length > fileLimit) {
      warnings.push(`File cap reached: kept ${fileLimit} of ${files.length} files`);
      files.length = fileLimit;
    }
    const languages = {};
    for (const file of files) {
      if (file.language) languages[file.language] = (languages[file.language] || 0) + 1;
    }
    const detected = detectProject({ root: rootAbs, files }, { root: rootAbs });
    warnings.push(...detected.warnings);
    const git = await inspectGit(rootAbs);
    return {
      root: rootAbs,
      files,
      dirs: dirs.sort(cmp),
      languages,
      frameworks: detected.frameworks,
      packageManagers: detected.packageManagers,
      entryPoints: detected.entryPoints,
      scripts: detected.scripts,
      dependencies: detected.dependencies,
      git,
      warnings,
      generatedAt: new Date().toISOString()
    };
  }

  async function scan() {
    const key = await cacheSignature(rootAbs, fileLimit, byteLimit, ignoreList);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 1500) {
      cache.delete(key);
      cache.set(key, hit);
      return hit.value;
    }
    const manifest = await buildManifest();
    cache.set(key, { value: manifest, at: Date.now() });
    while (cache.size > 3) cache.delete(cache.keys().next().value);
    return manifest;
  }

  return {
    scan,

    async context({ task = '', limit = 20000, paths = [] } = {}) {
      const manifest = await scan();
      return assembleContext(manifest, { task, limit, paths });
    },

    async search(query, { limit = 20 } = {}) {
      const manifest = await scan();
      return searchRepository(manifest.root || rootAbs, query, { limit, ignore: ignoreList });
    },

    async readFile(relPath, { maxBytes = 200000 } = {}) {
      const absPath = await resolveConfined(rootAbs, relPath);
      let st;
      try {
        st = await fs.promises.stat(absPath);
      } catch {
        throw new Error(`File not found: ${relPath}`);
      }
      if (!st.isFile()) throw new Error(`Not a regular file: ${relPath}`);
      const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 200000;
      if (st.size > limit) throw new Error(`File exceeds maxBytes (${limit}): ${relPath}`);
      let buffer;
      try {
        buffer = await fs.promises.readFile(absPath);
      } catch (error) {
        throw new Error(`Unable to read file: ${relPath} (${error.message})`);
      }
      if (looksBinary(buffer)) throw new Error(`File appears to be binary: ${relPath}`);
      return buffer.toString('utf8');
    },

    classify(relPath) {
      return classify(relPath);
    },

    refresh() {
      cache.clear();
    }
  };
}
