import { existsSync, readFileSync, realpathSync, lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { redact } from './redaction.js';
import { newId } from '../core/errors.js';

export function createApprovalGate({ mode = 'manual', prompt = null, events = null, autoApprove = [] } = {}) {
  const pending = new Map();
  const resolved = new Map();
  let currentMode = mode;

  function record(id, decision) {
    pending.delete(id);
    resolved.set(id, decision);
    if (resolved.size > 500) resolved.delete(resolved.keys().next().value);
    events?.emit('approval:resolved', { id, approved: decision.approved });
  }

  return {
    get mode() {
      return currentMode;
    },
    set mode(value) {
      currentMode = value;
    },
    async request(request = {}) {
      const id = request.id || newId('approval');
      const item = {
        id,
        action: String(request.action || 'tool'),
        reason: redact(String(request.reason || '')),
        risk: String(request.risk || 'medium'),
        details: request.details || {},
        requestedAt: new Date().toISOString(),
        status: 'pending'
      };
      if (mode === 'auto') {
        const allowed = item.risk !== 'critical';
        record(id, { id, approved: allowed, reason: allowed ? 'auto-approved' : 'auto-denied critical risk' });
        return resolved.get(id);
      }
      if (mode === 'deny') {
        record(id, { id, approved: false, reason: 'approval mode is deny' });
        return resolved.get(id);
      }
      if (typeof prompt !== 'function') {
        record(id, { id, approved: false, reason: 'no interactive approval handler configured' });
        return resolved.get(id);
      }
      pending.set(id, item);
      events?.emit('approval:required', { id, action: item.action, reason: item.reason, risk: item.risk });
      try {
        const answer = await prompt(item);
        const approved = answer === true || (answer && typeof answer === 'object' && answer.approved === true);
        record(id, {
          id,
          approved,
          reason: approved ? 'approved by operator' : 'denied by operator',
          respondedAt: new Date().toISOString()
        });
      } catch (error) {
        record(id, { id, approved: false, reason: `approval handler failed: ${error.message}` });
      }
      return resolved.get(id);
    },

    approve(id, reason = 'approved by operator') {
      if (!pending.has(id)) return null;
      record(id, { id, approved: true, reason, respondedAt: new Date().toISOString() });
      return resolved.get(id);
    },

    deny(id, reason = 'denied by operator') {
      if (!pending.has(id)) return null;
      record(id, { id, approved: false, reason, respondedAt: new Date().toISOString() });
      return resolved.get(id);
    },

    pending() {
      return [...pending.values()].map((item) => ({ ...item, details: redact(item.details) }));
    },

    get(id) {
      return resolved.get(id) || pending.get(id) || null;
    }
  };
}

const DESTRUCTIVE = [
  /\brm\s+(-[a-z]*[fr][a-z]*\s+.*)$/i,
  /\brm\s+-rf?\b/i,
  /\bgit\s+push\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\b(mkfs|dd\s+if=|shutdown|reboot|systemctl|service\s+\S+\s+(stop|restart))/i,
  /\b(chmod|chown)\s+[-0-7a-z]+\s+/i,
  /\b(npm|pnpm|yarn)\s+publish\b/i,
  /\bdocker\s+(run|rm|system\s+prune)\b/i,
  /\b(eval|exec)\s+["']/i,
  /\bfind\s+\S+\s+.*-delete\b/i,
  /\bshred\b/i,
  /\bgit\s+clean\b/i,
  /\b(dd\s+if=|mkfs|format\s+[A-Za-z]:)/i,
  /\b(:\(\)\{|:(){)/,
  /\b(sudo|su\s+-)\b/i
];

const NETWORK = [
  /\b(curl|wget|fetch|http|nc|ssh|scp|rsync)\b/i,
  /\bnpm\s+install\b/i,
  /\b(pip|pip3|python3?\s+-m\s+pip)\s+install\b/i,
  /\bgit\s+(clone|fetch|pull|push)\b/i,
  /\b\/dev\/tcp\b/i,
  /\bnode\s+-e\b/i
];

const SAFE_AUTO_COMMANDS = [
  /^(node|npm|pnpm|yarn|python3?|cargo|go|make|git)[ \t]+--?version$/i,
  /^node[ \t]+--test(?:[ \t]+[A-Za-z0-9_./][A-Za-z0-9_./-]*)*$/,
  /^node[ \t]+--check[ \t]+[A-Za-z0-9_./][A-Za-z0-9_./-]*$/,
  /^npm[ \t]+(?:test|run[ \t]+[A-Za-z0-9_:.-]+|check|build|lint)(?:[ \t]+--)?[ \t]*$/i,
  /^python3?[ \t]+-m[ \t]+pytest(?:[ \t]+[A-Za-z0-9_./:-]+)*$/,
  /^cargo[ \t]+test(?:[ \t]+[A-Za-z0-9_./:-]+)*$/,
  /^go[ \t]+test[ \t]+\.\/\.\.\.$/,
  /^make[ \t]+test$/,
  /^git[ \t]+(?:status|diff|log|show|branch)(?:[ \t]+[A-Za-z0-9_./:@-]+)*$/,
  /^(?:pwd|ls)(?:[ \t]+[A-Za-z0-9_./-]+)*$/
];

const SAFE_SCRIPT_BODIES = [
  /^node[ \t]+--test(?:[ \t]+[A-Za-z0-9_./][A-Za-z0-9_./-]*)*$/,
  /^node[ \t]+--check[ \t]+[A-Za-z0-9_./][A-Za-z0-9_./-]*$/,
  /^pwd$/,
  /^ls(?:[ \t]+[A-Za-z0-9_./-]+)*$/
];

const NPM_SCRIPT_RUNNER = /^npm[ \t]+(test|run[ \t]+([A-Za-z0-9_:.-]+)|check|build|lint)(?:[ \t]+--)?[ \t]*$/i;

const WRITE_TOOLS = new Set(['fs.write', 'fs.patch', 'fs.mkdir', 'fs.delete', 'shell.exec', 'adapter.execute']);

export function createPermissions({ config, roots = [], events = null, approvalGate = null, env = process.env } = {}) {
  const allowedRoots = [...new Set((roots.length ? roots : [config?.runtime?.cwd || process.cwd()]).map((root) => resolveRoot(root)))];
  const deniedPatterns = (config?.security?.deniedPaths || []).map((pattern) => String(pattern));
  const requireApproval = new Set(config?.security?.requireApproval || ['shell', 'write', 'network', 'external']);
  const allowNetwork = config?.security?.allowNetwork === true;

  function resolveRoot(root) {
    const path = String(root || '');
    return path.startsWith('file://') ? new URL(path).pathname : resolve(path);
  }

  function confined(path, base = allowedRoots[0]) {
    const raw = String(path || '');
    if (!raw) return { allowed: false, path: '', reason: 'empty path' };
    const absolute = raw.startsWith('file://') ? new URL(raw).pathname : resolve(base, raw);
    const insideRoots = (candidate) => allowedRoots.some((root) => candidate === root || candidate.startsWith(`${root}/`));
    if (!insideRoots(absolute)) return { allowed: false, path: absolute, reason: `path outside allowed roots: ${redact(absolute)}` };
    let probe = dirname(absolute);
    while (probe !== base && probe.startsWith(`${base}/`)) {
      if (existsSync(probe) && lstatSync(probe).isSymbolicLink()) {
        return { allowed: false, path: absolute, reason: `symlink traversal refused: ${redact(raw)}` };
      }
      probe = dirname(probe);
    }
    if (existsSync(absolute)) {
      if (lstatSync(absolute).isSymbolicLink()) {
        return { allowed: false, path: absolute, reason: `symlink target refused: ${redact(raw)}` };
      }
      const real = realpathSync(absolute);
      if (!insideRoots(real)) return { allowed: false, path: real, reason: `resolved path outside allowed roots: ${redact(real)}` };
    }
    const relativeToRoot = allowedRoots.map((root) => {
      if (absolute === root || absolute.startsWith(`${root}/`)) return absolute.slice(root.length).replace(/^\//, '');
      return null;
    }).find((value) => value !== null) || '';
    for (const pattern of deniedPatterns) {
      if (matchesDenied(relativeToRoot, pattern)) {
        return { allowed: false, path: absolute, reason: `path matches denied pattern: ${pattern}` };
      }
    }
    return { allowed: true, path: absolute, relative: relativeToRoot };
  }

  function matchesDenied(relative, pattern) {
    const normalized = pattern.replace(/^\.\//, '').replace(/^\//, '');
    if (normalized.endsWith('/**')) return relative.startsWith(normalized.slice(0, -2));
    if (normalized.startsWith('*.')) return relative.endsWith(normalized.slice(1));
    if (normalized.includes('*')) {
      const regex = new RegExp(`^${normalized.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
      return regex.test(relative) || relative.split('/').some((part) => regex.test(part));
    }
    return relative === normalized || relative.includes(`/${normalized}`) || relative.startsWith(`${normalized}/`);
  }

  function npmScriptName(command) {
    const match = NPM_SCRIPT_RUNNER.exec(command);
    if (!match) return null;
    return match[2] || match[1].replace(/^run[ \t]+/i, '');
  }

  function scriptRoot(request) {
    if (request.base === undefined || request.base === null || request.base === '') return allowedRoots[0];
    const raw = String(request.base);
    return raw.startsWith('file://') ? new URL(raw).pathname : resolve(allowedRoots[0], raw);
  }

  function npmScriptBodyAllowed(name, base) {
    try {
      const manifestPath = confined('package.json', base);
      if (!manifestPath.allowed) return false;
      const manifest = JSON.parse(readFileSync(manifestPath.path, 'utf8'));
      const scripts = manifest?.scripts;
      if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return false;
      const body = scripts[name];
      return typeof body === 'string' && SAFE_SCRIPT_BODIES.some((pattern) => pattern.test(body.trim()));
    } catch {
      return false;
    }
  }

  function assess(request = {}) {
    const tool = String(request.tool || request.action || 'unknown');
    const reasons = [];
    let risk = 'low';
    let needsApproval = false;

    if (request.path !== undefined) {
      const result = confined(request.path, request.base);
      if (!result.allowed) return { allowed: false, risk: 'high', requiresApproval: false, reason: result.reason };
    }

    if (WRITE_TOOLS.has(tool)) {
      risk = 'medium';
      if (tool === 'shell.exec' || tool === 'adapter.execute') risk = 'high';
      if (requireApproval.has('shell') || requireApproval.has('write')) needsApproval = true;
    }

    const command = String(request.command || '');
    const trimmedCommand = command.trim();
    let destructive = false;
    let networkCapable = false;
    let metacharacter = false;
    if (command) {
      destructive = DESTRUCTIVE.some((pattern) => pattern.test(command));
      networkCapable = NETWORK.some((pattern) => pattern.test(command));
      metacharacter = /[|>]|&&|;|\$\(|`/.test(command);
      if (destructive) {
        risk = 'critical';
        needsApproval = true;
        reasons.push('destructive command pattern');
      }
      if (networkCapable && !allowNetwork) {
        risk = risk === 'critical' ? risk : 'high';
        needsApproval = true;
        reasons.push('network-capable command');
      }
      if (metacharacter && tool === 'shell.exec') {
        risk = risk === 'critical' ? risk : 'high';
        needsApproval = true;
        reasons.push('shell metacharacters');
      }
    }

    const scriptName = npmScriptName(trimmedCommand);
    if (scriptName !== null && !npmScriptBodyAllowed(scriptName, scriptRoot(request))) {
      risk = 'critical';
      needsApproval = true;
      reasons.push('script runner body not auto-allowlisted');
    }

    if (approvalGate?.mode === 'auto') {
      if (destructive || networkCapable || metacharacter) {
        risk = 'critical';
        needsApproval = true;
        if (networkCapable && !reasons.includes('network-capable command')) reasons.push('network-capable command');
        if (metacharacter && !reasons.includes('shell metacharacters')) reasons.push('shell metacharacters');
      }
      if (tool === 'adapter.execute' || request.network === true || request.external === true) {
        risk = 'critical';
        needsApproval = true;
        reasons.push('auto policy denies external integrations');
      } else if (tool === 'shell.exec' && trimmedCommand && !SAFE_AUTO_COMMANDS.some((pattern) => pattern.test(trimmedCommand))) {
        risk = 'critical';
        needsApproval = true;
        reasons.push('auto policy denies commands outside the safe allowlist');
      }
    }

    if (request.network === true && !allowNetwork) {
      risk = risk === 'critical' ? risk : 'high';
      needsApproval = true;
      reasons.push('network operation');
    }

    if (request.external === true) {
      needsApproval = true;
      reasons.push('external integration');
    }

    if (requireApproval.has('all')) needsApproval = true;
    if (risk === 'critical') needsApproval = true;

    return {
      allowed: true,
      risk,
      requiresApproval: needsApproval,
      reason: reasons.length ? reasons.join('; ') : 'within policy',
      roots: allowedRoots
    };
  }

  async function authorize(request = {}) {
    const assessment = assess(request);
    if (!assessment.allowed) {
      events?.emit('security:denied', { tool: request.tool, reason: assessment.reason });
      return { ...assessment, approved: false };
    }
    if (!assessment.requiresApproval) return { ...assessment, approved: true };
    if (!approvalGate) return { ...assessment, approved: false, reason: 'approval required but no gate configured' };
    const decision = await approvalGate.request({
      action: request.tool || request.action,
      risk: assessment.risk,
      reason: assessment.reason,
      details: { path: request.path, command: redact(request.command || '') }
    });
    return { ...assessment, approved: decision.approved === true, approvalId: decision.id, reason: decision.reason };
  }

  return {
    assess,
    authorize,
    confined,
    roots: allowedRoots,
    async isPathAllowed(path, base) {
      return confined(path, base).allowed;
    }
  };
}
