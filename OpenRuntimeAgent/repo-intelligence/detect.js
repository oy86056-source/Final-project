import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';

const LANGUAGE_BY_EXT = new Map([
  ['js', 'JavaScript'],
  ['mjs', 'JavaScript'],
  ['cjs', 'JavaScript'],
  ['jsx', 'JavaScript'],
  ['ts', 'TypeScript'],
  ['tsx', 'TypeScript'],
  ['py', 'Python'],
  ['go', 'Go'],
  ['rs', 'Rust'],
  ['java', 'Java'],
  ['kt', 'Kotlin'],
  ['rb', 'Ruby'],
  ['php', 'PHP'],
  ['cs', 'C#'],
  ['cpp', 'C++'],
  ['cc', 'C++'],
  ['cxx', 'C++'],
  ['hpp', 'C++'],
  ['c', 'C'],
  ['h', 'C'],
  ['swift', 'Swift'],
  ['sh', 'Shell'],
  ['bash', 'Shell'],
  ['sql', 'SQL'],
  ['html', 'HTML'],
  ['css', 'CSS'],
  ['scss', 'CSS'],
  ['vue', 'Vue'],
  ['svelte', 'Svelte'],
  ['md', 'Markdown'],
  ['json', 'JSON'],
  ['yaml', 'YAML'],
  ['yml', 'YAML'],
  ['toml', 'TOML']
]);

const NODE_FRAMEWORKS = [
  ['react', ['react']],
  ['next', ['next']],
  ['vue', ['vue']],
  ['angular', ['@angular/core', 'angular']],
  ['svelte', ['svelte']],
  ['sveltekit', ['@sveltejs/kit']],
  ['express', ['express']],
  ['fastify', ['fastify']],
  ['nestjs', ['@nestjs/core', '@nestjs/common', 'nestjs']],
  ['koa', ['koa']],
  ['hono', ['hono']],
  ['vite', ['vite']],
  ['webpack', ['webpack']],
  ['jest', ['jest']],
  ['vitest', ['vitest']],
  ['typescript', ['typescript']],
  ['electron', ['electron']],
  ['prisma', ['prisma', '@prisma/client']]
];

const TEXT_FRAMEWORKS = [
  ['django', /django/i],
  ['flask', /\bflask\b/i],
  ['fastapi', /\bfastapi\b/i],
  ['rails', /\brails\b|railties/i],
  ['spring', /springframework|spring-boot|org\.springframework/i],
  ['tokio', /\btokio\b/i],
  ['actix', /actix-web/i],
  ['gin', /gin-gonic\/gin/i],
  ['fiber', /gofiber\/fiber/i],
  ['laravel', /laravel\/framework/i],
  ['symfony', /symfony\/symfony/i]
];

const PACKAGE_MARKERS = [
  ['npm', 'package-lock.json'],
  ['pnpm', 'pnpm-lock.yaml'],
  ['yarn', 'yarn.lock'],
  ['bun', 'bun.lockb'],
  ['bun', 'bun.lock'],
  ['pip', 'requirements.txt'],
  ['poetry', 'poetry.lock'],
  ['cargo', 'Cargo.lock'],
  ['cargo', 'Cargo.toml'],
  ['go', 'go.mod'],
  ['maven', 'pom.xml'],
  ['gradle', 'gradle-wrapper.properties'],
  ['composer', 'composer.lock'],
  ['bundler', 'Gemfile'],
  ['bundler', 'Gemfile.lock']
];

const SUPPORT_FILES = [
  'requirements.txt',
  'pyproject.toml',
  'setup.py',
  'Pipfile',
  'Cargo.toml',
  'go.mod',
  'Gemfile',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json'
];

function inside(rootAbs, targetAbs) {
  const rel = relative(rootAbs, targetAbs);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

function safeRel(relPath) {
  if (typeof relPath !== 'string' || !relPath.trim()) return null;
  if (isAbsolute(relPath) || /^[A-Za-z]:[\\/]/.test(relPath) || relPath.includes('\0')) return null;
  if (relPath.split(/[\\/]/).includes('..')) return null;
  return relPath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function readText(rootAbs, relPath, maxBytes = 2000000) {
  const normalized = safeRel(relPath);
  if (!normalized) return null;
  const abs = resolve(rootAbs, normalized);
  if (!inside(rootAbs, abs)) return null;
  try {
    let base = rootAbs;
    try {
      base = realpathSync(rootAbs);
    } catch {
    }
    const real = realpathSync(abs);
    if (!inside(base, real)) return null;
    const st = statSync(real);
    if (!st.isFile() || st.size > maxBytes) return null;
    return { path: normalized, text: readFileSync(real, 'utf8') };
  } catch {
    return null;
  }
}

function parseSpec(value) {
  const raw = String(value ?? '').trim().replace(/\s*#.*$/, '').trim();
  if (!raw || raw.startsWith('-') || /^[a-z]+:\/\//i.test(raw)) return null;
  const match = raw.match(/^([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*(.*)$/);
  if (!match) return null;
  const name = match[1];
  let version = match[2].replace(/\s*;\s*.*$/, '').trim();
  version = version.replace(/^==\s*/, '');
  return { name, version };
}

function parseRequirements(text, deps) {
  for (const line of text.split(/\r?\n/)) {
    const spec = parseSpec(line);
    if (spec) deps[spec.name] = spec.version || '*';
  }
}

function parsePythonProject(text, deps, frameworks) {
  const blocks = text.match(/^\s*(?:optional-)?dependencies\s*=\s*\[[\s\S]*?\]/gm) || [];
  for (const block of blocks) {
    const quoted = block.match(/["']([^"']+)["']/g) || [];
    for (const item of quoted) {
      const spec = parseSpec(item.slice(1, -1));
      if (spec) deps[spec.name] = spec.version || '*';
    }
  }
  const poetry = text.match(/^\[tool\.poetry\.(?:dependencies|dev-dependencies)\]\s*([\s\S]*?)(?=^\[|$)/m);
  if (poetry) {
    frameworks.add('poetry');
    for (const line of poetry[1].split(/\r?\n/)) {
      const pair = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*["']([^"']+)["']/);
      if (pair && pair[1] !== 'python') deps[pair[1]] = pair[2];
    }
  }
  if (/\[tool\.poetry\]/m.test(text)) frameworks.add('poetry');
}

function parseCargo(text, deps) {
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]/);
    if (header) {
      section = header[1].trim();
      continue;
    }
    if (!/^(dependencies|dev-dependencies|build-dependencies)$/.test(section)) continue;
    const pair = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!pair) continue;
    const inline = pair[2].match(/version\s*=\s*["']([^"']+)["']/);
    const plain = pair[2].match(/^["']([^"']+)["']/);
    deps[pair[1]] = inline ? inline[1] : plain ? plain[1] : '*';
  }
}

function parseGoMod(text, deps) {
  let inBlock = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === 'require (') {
      inBlock = true;
      continue;
    }
    if (inBlock && trimmed === ')') {
      inBlock = false;
      continue;
    }
    const body = inBlock ? trimmed : trimmed.replace(/^require\s+/, '');
    if (body === trimmed && !inBlock) continue;
    const pair = body.match(/^([^\s]+\.[^\s]+\/[^\s]+|[^\s]+\/[^\s]+)\s+(v[^\s]+)/);
    if (pair) deps[pair[1]] = pair[2];
  }
}

function parseGemfile(text, deps) {
  for (const line of text.split(/\r?\n/)) {
    const pair = line.match(/^\s*gem\s+["']([^"']+)["'](?:\s*,\s*["']([^"']+)["'])?/);
    if (pair) deps[pair[1]] = pair[2] || '*';
  }
}

function parseComposer(text, deps) {
  try {
    const parsed = JSON.parse(text);
    const source = { ...(parsed.require || {}), ...(parsed['require-dev'] || {}) };
    for (const [name, version] of Object.entries(source)) {
      if (name !== 'php' && typeof version === 'string') deps[name] = version;
    }
  } catch {
  }
}

function cleanPath(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (value.includes('\0')) return null;
  return safeRel(value);
}

export function detectProject(manifestLike, { root } = {}) {
  const files = Array.isArray(manifestLike?.files) ? manifestLike.files : [];
  const relativePaths = files
    .map((entry) => (typeof entry === 'string' ? entry : entry?.path))
    .map((entry) => (typeof entry === 'string' ? cleanPath(entry) : null))
    .filter(Boolean);
  const fileSet = new Set(relativePaths);
  const rootAbs = resolve(typeof root === 'string' && root ? root : manifestLike?.root || process.cwd());
  const warnings = [];
  const languages = {};
  const frameworks = new Set();
  const packageManagers = new Set();
  const scripts = {};
  const dependencies = {};
  const entryPoints = new Map();

  for (const relPath of relativePaths) {
    const ext = extname(relPath).slice(1).toLowerCase();
    const language = LANGUAGE_BY_EXT.get(ext);
    if (language) languages[language] = (languages[language] || 0) + 1;
  }

  for (const [manager, marker] of PACKAGE_MARKERS) {
    if (fileSet.has(marker) || readText(rootAbs, marker, 4096)) packageManagers.add(manager);
  }

  const pkgFile = readText(rootAbs, 'package.json');
  let pkg = null;
  if (pkgFile) {
    try {
      pkg = JSON.parse(pkgFile.text);
      if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
        pkg = null;
        warnings.push('package.json is not an object');
      }
    } catch {
      warnings.push('package.json is not valid JSON');
    }
  } else if (fileSet.has('package.json')) {
    warnings.push('package.json could not be read');
  }

  const npmNames = new Set();
  if (pkg) {
    for (const group of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const section = pkg[group];
      if (!section || typeof section !== 'object' || Array.isArray(section)) continue;
      for (const [name, version] of Object.entries(section)) {
        npmNames.add(name.toLowerCase());
        if (group === 'dependencies' || group === 'devDependencies') {
          dependencies[name] = typeof version === 'string' ? version : '*';
        }
      }
    }
    if (pkg.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts)) {
      for (const [name, command] of Object.entries(pkg.scripts)) {
        if (typeof command === 'string') scripts[name] = command;
      }
    }
    for (const [name, aliases] of NODE_FRAMEWORKS) {
      if (aliases.some((alias) => npmNames.has(alias.toLowerCase()))) frameworks.add(name);
    }
    if (npmNames.has('@angular/cli')) frameworks.add('angular');
  }

  const supportText = [];
  for (const marker of SUPPORT_FILES) {
    const file = readText(rootAbs, marker);
    if (!file) continue;
    supportText.push(file.text);
    if (marker === 'requirements.txt') parseRequirements(file.text, dependencies);
    if (marker === 'pyproject.toml') parsePythonProject(file.text, dependencies, frameworks);
    if (marker === 'Cargo.toml') parseCargo(file.text, dependencies);
    if (marker === 'go.mod') parseGoMod(file.text, dependencies);
    if (marker === 'Gemfile') parseGemfile(file.text, dependencies);
    if (marker === 'composer.json') parseComposer(file.text, dependencies);
  }
  const combinedSupport = supportText.join('\n');
  for (const [name, pattern] of TEXT_FRAMEWORKS) {
    if (pattern.test(combinedSupport)) frameworks.add(name);
  }
  if (/\bgo\s+1\./.test(combinedSupport)) packageManagers.add('go');

  const indexNames = [
    'index.js', 'index.mjs', 'index.cjs', 'index.ts', 'index.tsx', 'index.jsx',
    'src/index.js', 'src/index.mjs', 'src/index.ts', 'src/index.tsx'
  ];
  for (const name of indexNames) {
    if (fileSet.has(name)) entryPoints.set(name, 'index entry point');
  }
  if (fileSet.has('main.py')) entryPoints.set('main.py', 'Python entry point');
  for (const path of relativePaths) {
    if (/^src\/main\.[A-Za-z0-9]+$/.test(path) && !entryPoints.has(path)) {
      entryPoints.set(path, 'src/main entry point');
    }
    if (/^cmd\/(?:.+\/)?main\.go$/.test(path) && !entryPoints.has(path)) {
      entryPoints.set(path, 'Go cmd entry point');
    }
  }
  if (fileSet.has('Cargo.toml')) entryPoints.set('Cargo.toml', 'Rust crate manifest');

  if (pkg) {
    const addDeclared = (value, reason) => {
      const normalized = cleanPath(value);
      if (normalized && !entryPoints.has(normalized)) entryPoints.set(normalized, reason);
    };
    addDeclared(pkg.main, 'package.json main');
    if (typeof pkg.bin === 'string') addDeclared(pkg.bin, 'package.json bin');
    if (pkg.bin && typeof pkg.bin === 'object' && !Array.isArray(pkg.bin)) {
      for (const value of Object.values(pkg.bin)) addDeclared(value, 'package.json bin');
    }
    if (scripts.start) {
      const tokens = scripts.start.trim().split(/\s+/);
      let target = null;
      for (let i = 0; i < tokens.length; i += 1) {
        if (/^(node|nodejs|tsx|ts-node|bun|deno)$/.test(tokens[i]) && tokens[i + 1]) {
          target = tokens[i + 1];
          break;
        }
        if (/\.(?:m?js|cjs|ts|tsx|jsx|py)$/.test(tokens[i])) {
          target = tokens[i];
          break;
        }
      }
      const normalized = target ? cleanPath(target) : null;
      if (normalized) entryPoints.set(normalized, 'package.json scripts.start');
      else if (!entryPoints.has('package.json')) entryPoints.set('package.json', 'package.json scripts.start');
    }
  }

  if (relativePaths.length === 0) warnings.push('manifest contains no files');

  return {
    languages,
    frameworks: [...frameworks].sort(),
    packageManagers: [...packageManagers].sort(),
    entryPoints: [...entryPoints.entries()]
      .map(([path, reason]) => ({ path, reason }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    scripts,
    dependencies,
    warnings
  };
}
