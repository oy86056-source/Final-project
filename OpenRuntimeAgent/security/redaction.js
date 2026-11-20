const SECRET_ENV_PATTERN = /(?:^|[^A-Za-z0-9])(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE|ENCRYPTION|API_KEY|AUTHORIZATION)(?:[^A-Za-z0-9]|$)/i;

const PATTERNS = [
  /\b(sk-[A-Za-z0-9_-]{12,})\b/g,
  /\b(gh[pousr]_[A-Za-z0-9]{12,})\b/g,
  /\b(AKIA[0-9A-Z]{16})\b/g,
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  /\b(Bearer\s+)[^\s,;"'}\]]+/gi,
  /\b(api[_-]?key|apikey|authorization|access[_-]?token|refresh[_-]?token|token|secret|password)(["']?\s*[:=]\s*|["']?\s+)(Bearer\s+)?([^\s,;"'}&]+)/gi,
  /([?&](?:api[_-]?key|apikey|token|key|secret)=)[^&\s]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
];

export function collectSecretValues(env = process.env, extra = []) {
  const values = [];
  for (const [name, value] of Object.entries(env || {})) {
    if (!SECRET_ENV_PATTERN.test(name)) continue;
    if (typeof value === 'string' && value.length >= 8 && !value.includes(' ')) values.push(value);
  }
  for (const item of extra) {
    if (typeof item === 'string' && item.length >= 8) values.push(item);
  }
  return [...new Set(values)].sort((a, b) => b.length - a.length);
}

export function redact(text, { env = process.env, extraSecrets = [], maxLength = 20000 } = {}) {
  let output = typeof text === 'string' ? text : String(text ?? '');
  for (const value of collectSecretValues(env, extraSecrets)) {
    output = output.split(value).join('[REDACTED]');
  }
  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0;
    output = output.replace(pattern, (match, ...groups) => {
      const captures = groups.slice(0, -2).map((group) => (typeof group === 'string' ? group : ''));
      if (captures.length > 1) return `${captures.slice(0, -1).join('')}[REDACTED]`;
      if (captures.length === 1 && /^(Bearer\s+|[?&](?:api[_-]?key|apikey|token|key|secret)=)$/i.test(captures[0])) {
        return `${captures[0]}[REDACTED]`;
      }
      return '[REDACTED]';
    });
  }
  if (output.length > maxLength) output = `${output.slice(0, maxLength)}...[TRUNCATED]`;
  return output;
}

export function redactObject(value, options = {}) {
  if (typeof value === 'string') return redact(value, options);
  if (Array.isArray(value)) return value.map((item) => redactObject(item, options));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, nested] of Object.entries(value)) {
      if (SECRET_ENV_PATTERN.test(key) && typeof nested === 'string') result[key] = '[REDACTED]';
      else result[key] = redactObject(nested, options);
    }
    return result;
  }
  return value;
}

export function containsSecret(text, secrets = []) {
  const value = String(text ?? '');
  return secrets.some((secret) => typeof secret === 'string' && secret.length >= 8 && value.includes(secret));
}
