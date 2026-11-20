const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const MAX_ERROR_LENGTH = 500;
const METADATA_HINTS = ['cost', 'speed', 'quality', 'capabilities', 'description', 'warning', 'latencyMs'];

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, nested] of Object.entries(value)) result[key] = cloneValue(nested);
    return result;
  }
  return value;
}

function redact(value, apiKey) {
  let text = value instanceof Error ? value.message : String(value ?? 'unknown error');
  if (apiKey) text = text.split(apiKey).join('[REDACTED]');
  text = text.replace(/(Bearer\s+)[^\s,;"'}\]]+/gi, '$1[REDACTED]');
  text = text.replace(/((?:api[_-]?key|apikey|authorization|access[_-]?token|refresh[_-]?token|token|secret|password)(?:["']?\s*[:=]\s*|["']?\s+))([^\s,;"'}&]+)/gi, '$1[REDACTED]');
  text = text.replace(/([?&](?:api[_-]?key|apikey|token|key|secret)=)[^&\s]+/gi, '$1[REDACTED]');
  return text.slice(0, MAX_ERROR_LENGTH);
}

function scrub(value, apiKey) {
  if (typeof value === 'string') {
    let text = value;
    if (apiKey) text = text.split(apiKey).join('[REDACTED]');
    text = text.replace(/(Bearer\s+)[^\s,;"'}\]]+/gi, '$1[REDACTED]');
    text = text.replace(/([?&](?:api[_-]?key|apikey|token|key|secret)=)[^&\s]+/gi, '$1[REDACTED]');
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => scrub(item, apiKey));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, nested] of Object.entries(value)) result[key] = scrub(nested, apiKey);
    return result;
  }
  return value;
}

function buildHeaders(specHeaders, apiKey) {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(specHeaders && typeof specHeaders === 'object' ? specHeaders : {})
  };
  if (apiKey) {
    for (const key of Object.keys(headers)) {
      if (/^authorization$/i.test(key)) delete headers[key];
    }
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function composeSignal(caller, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const onAbort = () => {
    clearTimeout(timer);
    controller.abort(caller.reason);
  };
  if (caller?.aborted) {
    controller.abort(caller.reason);
  } else if (caller) {
    caller.addEventListener('abort', onAbort, { once: true });
  }
  if (!controller.signal.aborted) {
    timer = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs);
  }
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      if (caller) caller.removeEventListener('abort', onAbort);
    }
  };
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Request aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal.reason ?? new Error('Request aborted'));
    };
    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isRetryable(error) {
  if (error?.retryable === true) return true;
  if (error?.retryable === false) return false;
  if (error?.status !== undefined) return RETRYABLE_STATUSES.has(error.status);
  if (error?.name === 'SyntaxError') return false;
  return true;
}

function extractModels(data) {
  const raw = Array.isArray(data) ? data : data?.data ?? data?.models ?? [];
  return raw
    .map((item) => (typeof item === 'string' ? item : item?.id ?? item?.name))
    .filter((value) => typeof value === 'string' && value.length > 0);
}

async function requestJSON(path, { method = 'GET', body } = {}, callerSignal, context) {
  const { baseURL, apiKey, timeoutMs, fetchImpl, log, id } = context;
  const endpoint = `${baseURL.replace(/\/+$/, '')}${path}`;
  let lastError;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (callerSignal?.aborted) throw callerSignal.reason ?? new Error('Request aborted');
    const combined = composeSignal(callerSignal, timeoutMs);
    let shouldRetry = false;

    try {
      const response = await fetchImpl(endpoint, {
        method,
        headers: buildHeaders(context.spec.headers, apiKey),
        ...(body === undefined ? {} : { body }),
        signal: combined.signal
      });
      const rawText = await response.text();
      let data;
      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch (parseError) {
        const error = new Error(`Invalid JSON response: ${parseError.message}`);
        error.retryable = false;
        throw error;
      }
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}: ${redact(rawText, apiKey)}`);
        error.status = response.status;
        error.retryable = RETRYABLE_STATUSES.has(response.status);
        throw error;
      }
      return data;
    } catch (error) {
      lastError = error;
      if (callerSignal?.aborted || !isRetryable(error) || attempt === MAX_ATTEMPTS - 1) throw error;
      log('provider.retry', { id, attempt: attempt + 1, path, error: redact(error, apiKey) });
      shouldRetry = true;
    } finally {
      combined.cleanup();
    }

    if (shouldRetry) await wait(250 * 2 ** attempt, callerSignal);
  }

  throw lastError ?? new Error('Request failed');
}

export function createOpenAICompatibleProvider(
  spec,
  { fetchImpl = globalThis.fetch, logger = () => {} } = {}
) {
  const providerSpec = spec && typeof spec === 'object' ? spec : {};
  const id = providerSpec.id;
  const name = providerSpec.name ?? id;
  const kind = providerSpec.kind ?? 'openai-compatible';
  const baseURL = providerSpec.baseURL;
  const apiKey = typeof providerSpec.apiKey === 'string' ? providerSpec.apiKey : '';
  const models = Array.isArray(providerSpec.models) ? providerSpec.models.map(String) : [];
  const defaultModel = providerSpec.defaultModel ?? models[0] ?? '';
  const contextWindow = Number(providerSpec.contextWindow) > 0 ? Number(providerSpec.contextWindow) : 8192;
  const maxOutput = Number(providerSpec.maxOutput) > 0 ? Number(providerSpec.maxOutput) : 4096;
  const timeoutMs = Number(providerSpec.timeoutMs) > 0 ? Number(providerSpec.timeoutMs) : 30000;

  if (typeof id !== 'string' || id.length === 0) throw new Error('Invalid provider id');
  if (typeof baseURL !== 'string' || !/^https?:\/\//i.test(baseURL)) throw new Error('Invalid provider baseURL');

  const log = (event, fields) => {
    try {
      logger({ event, ...fields });
    } catch {
      return;
    }
  };
  const context = { id, baseURL, apiKey, timeoutMs, fetchImpl, log, spec: providerSpec };

  function metadata() {
    const result = {
      id,
      name,
      kind,
      baseURL,
      models: [...models],
      defaultModel,
      contextWindow,
      maxOutput
    };
    for (const key of METADATA_HINTS) {
      if (providerSpec[key] !== undefined) result[key] = cloneValue(providerSpec[key]);
    }
    return scrub(result, apiKey);
  }

  async function health({ signal } = {}) {
    const startedAt = Date.now();
    try {
      const data = await requestJSON('/models', { method: 'GET' }, signal, context);
      return {
        id,
        ok: true,
        latencyMs: Date.now() - startedAt,
        models: extractModels(data),
        error: null
      };
    } catch (error) {
      const reason = redact(error, apiKey);
      log('provider.health', { id, ok: false, error: reason });
      return {
        id,
        ok: false,
        latencyMs: Date.now() - startedAt,
        models: [],
        error: reason
      };
    }
  }

  async function complete({ messages, model, maxTokens, temperature, signal } = {}) {
    const chosenModel = model || defaultModel || models[0];
    const normalizedMessages = Array.isArray(messages) ? messages : messages ? [messages] : [];
    const body = { model: chosenModel, messages: normalizedMessages };
    if (maxTokens !== undefined) body.max_tokens = maxTokens;
    if (temperature !== undefined) body.temperature = temperature;

    const data = await requestJSON(
      '/chat/completions',
      { method: 'POST', body: JSON.stringify(body) },
      signal,
      context
    );
    const choice = Array.isArray(data?.choices) ? data.choices[0] : undefined;
    const content = choice?.message?.content ?? choice?.text ?? '';
    const text = typeof content === 'string' ? content : JSON.stringify(content ?? '');
    return {
      text,
      usage: data?.usage && typeof data.usage === 'object' ? data.usage : {},
      model: chosenModel,
      provider: id
    };
  }

  return { id, metadata, health, complete };
}
