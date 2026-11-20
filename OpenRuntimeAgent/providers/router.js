const CAPABILITY_HINTS = [
  { words: ['code', 'coding', 'debug', 'refactor', 'programming', 'javascript', 'typescript'], tag: 'code' },
  { words: ['json', 'schema', 'structured'], tag: 'json' },
  { words: ['image', 'vision', 'screenshot', 'ocr'], tag: 'vision' },
  { words: ['tool', 'tools', 'function', 'functions', 'call', 'agent', 'agents'], tag: 'tools' },
  { words: ['long', 'context', 'document', 'documents', 'summarize', 'summarise'], tag: 'long-context' },
  { words: ['fast', 'realtime', 'real-time', 'latency'], tag: 'fast' },
  { words: ['cheap', 'cost', 'budget', 'free'], tag: 'cheap' }
];

function safeReason(value) {
  let text = value instanceof Error ? value.message : String(value ?? 'unknown error');
  text = text.replace(/(Bearer\s+)[^\s,;"'}\]]+/gi, '$1[REDACTED]');
  text = text.replace(/((?:api[_-]?key|apikey|authorization|access[_-]?token|refresh[_-]?token|token|secret|password)(?:["']?\s*[:=]\s*|["']?\s+))([^\s,;"'}&]+)/gi, '$1[REDACTED]');
  text = text.replace(/([?&](?:api[_-]?key|apikey|token|key|secret)=)[^&\s]+/gi, '$1[REDACTED]');
  return text.slice(0, 500);
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toArray(value) {
  return Array.isArray(value) ? value.filter((item) => item !== undefined && item !== null).map(String) : [];
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function scoreProvider(metadata, { task = '', requiredTokens = 0, prefer = [] } = {}) {
  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  const id = String(meta.id ?? '');
  const name = String(meta.name ?? '');
  const models = toArray(meta.models);
  const taskText = String(task ?? '').toLowerCase();
  const preferences = toArray(prefer);
  let score = 0;

  let preferenceScore = 0;
  for (let index = 0; index < preferences.length; index += 1) {
    const wanted = preferences[index].toLowerCase();
    if (id.toLowerCase() === wanted) {
      preferenceScore = Math.max(preferenceScore, 1000 - index * 10);
    } else if (name.toLowerCase() === wanted) {
      preferenceScore = Math.max(preferenceScore, 500 - index * 5);
    } else if (models.some((model) => model.toLowerCase() === wanted)) {
      preferenceScore = Math.max(preferenceScore, 250 - index * 5);
    }
  }
  score += preferenceScore;

  const contextWindow = finiteNumber(meta.contextWindow) ?? 0;
  const maxOutput = finiteNumber(meta.maxOutput) ?? 0;
  const required = Math.max(0, finiteNumber(requiredTokens) ?? 0);
  if (required > 0) {
    if (contextWindow >= required + maxOutput) score += 120;
    else if (contextWindow >= required) score += 40;
    else score -= 1000 + (required - contextWindow);
  } else {
    score += contextWindow >= 8192 ? 10 : 0;
  }

  if (meta.cost === 0 || meta.cost === '0' || meta.cost === 'free') {
    score += 80;
  } else {
    const cost = finiteNumber(meta.cost);
    if (cost !== null) score += Math.max(0, 40 - cost * 1000);
    else if (String(meta.cost ?? '').toLowerCase() === 'low') score += 40;
  }

  const speed = String(meta.speed ?? '').toLowerCase();
  if (['fast', 'faster', 'fastest', 'realtime', 'real-time', 'ultrafast'].includes(speed)) score += 60;
  else if (['medium', 'balanced'].includes(speed)) score += 20;
  else if (speed === 'slow') score -= 30;
  else {
    const numericSpeed = finiteNumber(meta.speed);
    if (numericSpeed !== null) score += Math.max(0, Math.min(50, numericSpeed));
  }

  const quality = finiteNumber(meta.quality);
  if (quality !== null) score += Math.max(0, Math.min(50, quality * 10));

  const capabilities = toArray(meta.capabilities).map((tag) => tag.toLowerCase());
  if (capabilities.length > 0) {
    for (const hint of CAPABILITY_HINTS) {
      if (hint.words.some((word) => taskText.includes(word)) && capabilities.includes(hint.tag)) score += 20;
    }
    if (capabilities.includes('chat')) score += 2;
  }

  return Math.round(score * 1000) / 1000;
}

export function createRouter({ registry, logger = () => {} } = {}) {
  if (!registry || typeof registry.list !== 'function' || typeof registry.get !== 'function') {
    throw new Error('Invalid registry');
  }

  const healthCache = new Map();
  const log = (event, fields) => {
    try {
      logger({ event, ...fields });
    } catch {
      return;
    }
  };

  function metadataList() {
    try {
      const list = registry.list();
      return Array.isArray(list) ? list.filter((item) => item && typeof item.id === 'string') : [];
    } catch (error) {
      log('router.list_failed', { error: safeReason(error) });
      return [];
    }
  }

  async function cachedHealth(id) {
    const now = Date.now();
    const existing = healthCache.get(id);
    if (existing && existing.expiresAt > now) return existing.value;

    const check = typeof registry.check === 'function'
      ? () => registry.check(id)
      : async () => {
          const provider = registry.get(id);
          return typeof provider?.health === 'function' ? provider.health() : { id, ok: false, error: 'health unavailable' };
        };

    const pending = Promise.resolve()
      .then(check)
      .then((result) => ({
        id,
        ok: result?.ok === true,
        latencyMs: finiteNumber(result?.latencyMs) ?? 0,
        models: toArray(result?.models),
        error: result?.error ? safeReason(result.error) : null
      }))
      .catch((error) => ({
        id,
        ok: false,
        latencyMs: 0,
        models: [],
        error: safeReason(error)
      }));

    const entry = { expiresAt: now + 30000, value: pending };
    healthCache.set(id, entry);
    const value = await pending;
    if (healthCache.get(id) === entry) {
      entry.value = value;
      entry.expiresAt = Date.now() + 30000;
    }
    return value;
  }

  function rankedCandidates({ task = '', requiredTokens = 0, prefer = [], exclude = [], includeModel = false, model } = {}) {
    const excluded = new Set(toArray(exclude));
    const preferences = toArray(prefer);
    if (includeModel && model !== undefined && model !== null) preferences.push(String(model));
    return metadataList()
      .filter((meta) => !excluded.has(meta.id))
      .map((meta) => ({ meta, score: scoreProvider(meta, { task, requiredTokens, prefer: preferences }) }))
      .sort((a, b) => b.score - a.score || compareStrings(a.meta.id, b.meta.id));
  }

  function aggregate(ids, reasons) {
    const uniqueIds = [...new Set(toArray(ids))];
    const uniqueReasons = [...new Set(reasons.map(safeReason))];
    const reasonText = uniqueReasons.length > 0 ? uniqueReasons.join('; ') : 'all attempts failed';
    return new Error(`Routing failed for providers [${uniqueIds.join(', ')}]: ${reasonText}`);
  }

  async function choose({ task = '', requiredTokens = 0, prefer = [], requireHealthy = false, exclude = [] } = {}) {
    const ranked = rankedCandidates({ task, requiredTokens, prefer, exclude });
    for (const item of ranked) {
      if (requireHealthy) {
        const health = await cachedHealth(item.meta.id);
        if (!health.ok) {
          log('router.unhealthy', { id: item.meta.id, error: health.error });
          continue;
        }
      }
      const provider = registry.get(item.meta.id);
      if (provider && typeof provider.complete === 'function') return provider;
    }
    throw new Error('No available provider');
  }

  async function route({
    task = '',
    messages = [],
    model,
    requiredTokens = 0,
    prefer = [],
    requireHealthy = false,
    exclude = [],
    maxAttempts = 3,
    signal,
    maxTokens,
    temperature,
    ...rest
  } = {}) {
    const ranked = rankedCandidates({ task, requiredTokens, prefer, exclude, includeModel: true, model });
    const usable = [];
    const skipped = [];

    for (const item of ranked) {
      if (requireHealthy) {
        const health = await cachedHealth(item.meta.id);
        if (!health.ok) {
          const reason = `unhealthy: ${health.error ?? 'unknown'}`;
          skipped.push({ id: item.meta.id, reason });
          log('router.unhealthy', { id: item.meta.id, error: health.error });
          continue;
        }
      }
      usable.push(item);
    }

    const limit = Number.isFinite(maxAttempts) ? Math.max(0, Math.floor(maxAttempts)) : 3;
    const attempts = usable.slice(0, limit);
    const attemptedIds = [];
    const failures = skipped.map((item) => `${item.id}: ${item.reason}`);

    if (attempts.length === 0) {
      if (failures.length === 0) failures.push(limit === 0 ? 'maxAttempts exhausted' : 'no available provider');
      throw aggregate([...skipped.map((item) => item.id), ...usable.slice(0, limit).map((item) => item.meta.id)], failures);
    }

    for (const item of attempts) {
      const id = item.meta.id;
      if (signal?.aborted) {
        failures.push(`${id}: ${safeReason(signal.reason ?? 'aborted')}`);
        break;
      }
      const provider = registry.get(id);
      if (!provider || typeof provider.complete !== 'function') {
        attemptedIds.push(id);
        failures.push(`${id}: provider unavailable`);
        continue;
      }
      attemptedIds.push(id);
      try {
        const completion = await provider.complete({
          ...rest,
          messages,
          model,
          maxTokens,
          temperature,
          signal
        });
        const result = completion && typeof completion === 'object' ? { ...completion } : {};
        return { ...result, provider: id };
      } catch (error) {
        const reason = safeReason(error);
        failures.push(`${id}: ${reason}`);
        log('router.attempt_failed', { id, error: reason });
      }
    }

    throw aggregate(attemptedIds, failures);
  }

  return { choose, route };
}
