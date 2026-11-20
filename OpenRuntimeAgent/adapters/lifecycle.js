const KINDS = new Set(['cli', 'api', 'mcp', 'native', 'sdk']);
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const CONFIGURABLE_FIELDS = new Set(['timeoutMs', 'capabilities', 'enabled']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function createAdapterLifecycle({ registry, logger = () => {} } = {}) {
  if (!registry || typeof registry.register !== 'function' || typeof registry.get !== 'function' || typeof registry.list !== 'function') {
    throw new TypeError('registry is required');
  }

  const validationCache = new Map();

  function invalidate(id) {
    if (id === undefined) validationCache.clear();
    else validationCache.delete(id);
  }

  function metadata(id) {
    return registry.list().find((item) => item.id === id);
  }

  async function install(def) {
    invalidate();
    const id = isObject(def) && typeof def.id === 'string' ? def.id : undefined;
    try {
      if (!isObject(def)) throw new Error('definition must be an object');
      if (typeof def.id !== 'string' || !ID_PATTERN.test(def.id)) throw new Error('invalid id');
      if (typeof def.command !== 'string' || def.command.trim() === '') throw new Error('invalid command');
      if (!Array.isArray(def.capabilities)) throw new Error('capabilities must be an array');
      if (def.kind !== undefined && !KINDS.has(def.kind)) throw new Error(`unknown kind: ${def.kind}`);
      const result = registry.register(def);
      logger('install', { id: result.id, ok: true });
      return { ok: true, id: result.id };
    } catch (error) {
      logger('install', { id, ok: false, reason: error.message });
      return { ok: false, id, reason: error.message };
    }
  }

  async function discover() {
    const results = await registry.discover();
    logger('discover', { count: results.length });
    return results;
  }

  async function validate(id) {
    if (validationCache.has(id)) return validationCache.get(id);
    const result = await registry.validate(id);
    validationCache.set(id, result);
    return result;
  }

  async function configure(id, options = {}) {
    const def = registry.get(id);
    if (!def) throw new Error(`adapter not found: ${id}`);
    const opts = isObject(options) ? options : {};
    for (const key of Object.keys(opts)) {
      if (!CONFIGURABLE_FIELDS.has(key)) throw new Error(`unknown field: ${key}`);
    }
    if ('timeoutMs' in opts && (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0)) throw new Error('invalid timeoutMs');
    if ('capabilities' in opts && (!Array.isArray(opts.capabilities) || opts.capabilities.some((item) => typeof item !== 'string'))) throw new Error('invalid capabilities');
    if ('enabled' in opts && typeof opts.enabled !== 'boolean') throw new Error('invalid enabled');
    if ('timeoutMs' in opts) def.timeoutMs = opts.timeoutMs;
    if ('capabilities' in opts) def.capabilities = [...opts.capabilities];
    if ('enabled' in opts) def.enabled = opts.enabled;
    invalidate(id);
    logger('configure', { id });
    return metadata(id);
  }

  async function setEnabled(id, enabled, event) {
    const def = registry.get(id);
    if (!def) throw new Error(`adapter not found: ${id}`);
    def.enabled = enabled;
    invalidate(id);
    logger(event, { id, enabled });
    return metadata(id);
  }

  async function enable(id) {
    return await setEnabled(id, true, 'enable');
  }

  async function disable(id) {
    return await setEnabled(id, false, 'disable');
  }

  async function execute(id, options) {
    const result = await registry.execute(id, options);
    logger('execute', { id, ok: result.ok });
    return result;
  }

  async function remove(id) {
    invalidate();
    const result = await registry.remove(id);
    logger('remove', { id, removed: result.removed });
    return result;
  }

  async function report() {
    const items = registry.list();
    const byKind = {};
    let enabled = 0;
    let available = 0;
    const adapters = items.map((item) => {
      const def = registry.get(item.id) || item;
      const isAvailable = def.available === true;
      if (item.enabled) enabled += 1;
      if (isAvailable) available += 1;
      byKind[item.kind] = (byKind[item.kind] || 0) + 1;
      const cached = validationCache.get(item.id);
      return {
        ...item,
        available: isAvailable,
        validated: cached ? cached.ok === true : false,
        ...(cached ? { version: cached.version, validationReason: cached.reason } : {})
      };
    });
    return { total: items.length, enabled, available, byKind, adapters };
  }

  return { install, discover, validate, configure, enable, disable, execute, remove, report };
}
