import {
  joinUrlPath,
  normalizeBaseUrl,
  stripProtocolSuffix,
} from './config.mjs';
import {
  cacheKeyParts,
  TtlLruCache,
} from './cache.mjs';
import {
  createAdapterError,
  ERROR_KINDS,
  errorFromHttpResponse,
  errorFromNetworkFailure,
} from './errors.mjs';
import { redactUrl } from './log.mjs';

export const MODELS_POSITIVE_TTL_MS = 5 * 60 * 1000;
export const MODELS_NEGATIVE_TTL_MS = 30 * 1000;
export const MODELS_REQUEST_TIMEOUT_MS = 5 * 1000;
export const MODELS_TOTAL_BUDGET_MS = 15 * 1000;
export const MODELS_MAX_HTTP_REQUESTS = 6;
export const MODELS_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const MODELS_MAX_ITEMS = 500;

const MODEL_NAME_WORDS = new Map([
  ['api', 'API'],
  ['claude', 'Claude'],
  ['deepseek', 'DeepSeek'],
  ['gemini', 'Gemini'],
  ['gpt', 'GPT'],
  ['llama', 'Llama'],
  ['mistral', 'Mistral'],
  ['opus', 'Opus'],
  ['pro', 'Pro'],
  ['sonnet', 'Sonnet'],
  ['flash', 'Flash'],
]);

/**
 * Claude Science hides model names that look like lowercase internal slugs.
 * Providers such as DeepSeek only return an id, so produce a readable display
 * name instead of copying the kebab-case id verbatim.
 */
export function safeModelDisplayName(displayName, id) {
  const raw = String(displayName || '').trim();
  const fallbackId = String(id || '').trim();
  const value = raw || fallbackId;
  if (!value) return '';

  const looksLikeInternalSlug = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(value);
  if (raw && raw !== fallbackId && !looksLikeInternalSlug) return raw;
  if (raw && !looksLikeInternalSlug && /[A-Z\s]/.test(raw)) return raw;

  return value
    .split(/[\s._/:+-]+/)
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase();
      if (MODEL_NAME_WORDS.has(lower)) return MODEL_NAME_WORDS.get(lower);
      if (/^v?\d+[a-z0-9]*$/i.test(word)) return word.toUpperCase();
      return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
    })
    .join(' ');
}

/**
 * Generate candidate model list URLs (max 4, ordered, de-duplicated).
 */
export function generateModelCandidateUrls(baseUrlInput) {
  const base =
    typeof baseUrlInput === 'string'
      ? normalizeBaseUrl(baseUrlInput)
      : baseUrlInput;

  const candidates = [];
  const seen = new Set();

  const push = (href) => {
    if (!href) return;
    if (seen.has(href)) return;
    // Guard against /v1/v1/models
    if (/\/v1\/v1\/models\/?$/.test(href)) return;
    if (candidates.length >= 4) return;
    seen.add(href);
    candidates.push(href);
  };

  const pathname = base.pathname === '/' ? '/' : base.pathname.replace(/\/+$/, '') || '/';
  const baseHref =
    pathname === '/'
      ? `${base.origin}/`
      : `${base.origin}${pathname}`;

  if (pathname.endsWith('/v1')) {
    push(joinUrlPath(baseHref, 'models'));
  } else {
    push(joinUrlPath(baseHref, 'v1/models'));
  }

  const strippedPath = stripProtocolSuffix(pathname);
  if (strippedPath !== null) {
    const rootHref =
      strippedPath === '/'
        ? `${base.origin}/`
        : `${base.origin}${strippedPath}`;
    push(joinUrlPath(rootHref, 'v1/models'));
    push(joinUrlPath(rootHref, 'models'));
  }

  return candidates;
}

export function parseModelsResponse(payload) {
  const items = extractModelArray(payload);
  if (!items) return null;

  const models = [];
  const seenIds = new Set();

  for (const item of items) {
    if (models.length >= MODELS_MAX_ITEMS) break;
    let id = null;
    let displayName = null;

    if (typeof item === 'string') {
      id = item.trim();
      displayName = safeModelDisplayName(null, id);
    } else if (item && typeof item === 'object') {
      id = typeof item.id === 'string' ? item.id.trim() : null;
      const providerDisplayName =
        (typeof item.display_name === 'string' && item.display_name.trim()) ||
        (typeof item.name === 'string' && item.name.trim()) ||
        null;
      displayName = safeModelDisplayName(providerDisplayName, id);
    }

    if (!id) continue;
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    models.push({
      id,
      display_name: displayName || safeModelDisplayName(null, id),
      type: 'model',
    });
  }

  if (models.length === 0) return null;
  return models;
}

function extractModelArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return null;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.models)) return payload.models;
  return null;
}

function preferredAuthModesForUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    if (pathname.includes('/v1/models') && !pathname.includes('/anthropic')) {
      return ['bearer', 'x-api-key'];
    }
  } catch {
    // fall through
  }
  return ['x-api-key', 'bearer'];
}

function buildAuthHeaders(credential, mode, anthropicVersion) {
  const headers = {
    accept: 'application/json',
  };
  if (mode === 'x-api-key') {
    headers['x-api-key'] = credential.value;
    headers['anthropic-version'] = anthropicVersion || '2023-06-01';
  } else {
    headers.authorization = `Bearer ${credential.value}`;
  }
  return headers;
}

/**
 * Discover models according to design doc §7.
 */
export async function discoverModels(context) {
  const {
    config,
    logger,
    fetchImpl = globalThis.fetch,
    cache = new TtlLruCache({ maxEntries: 32 }),
  } = context;

  const cacheKey = cacheKeyParts([
    'models',
    config.baseUrlFingerprint,
    config.credentialFingerprint,
    config.byok.modelsUrl || '',
  ]);

  const cached = cache.get(cacheKey);
  if (cached) {
    if (cached.kind === 'negative') {
      throw createAdapterError({
        kind: cached.errorKind || ERROR_KINDS.NOT_FOUND,
        status: cached.status || 404,
        message: cached.message || 'Model discovery previously failed',
      });
    }
    return {
      models: cached.models,
      source: cached.source,
      endpoint: cached.endpoint,
      authMode: cached.authMode,
      fromCache: true,
    };
  }

  // OPERON_MODELS is primary for runtime via P8; adapter still supports it for direct /v1/models.
  if (config.operonModels) {
    const models = parseOperonModels(config.operonModels);
    if (models?.length) {
      const result = {
        models,
        source: 'operon_models',
        endpoint: null,
        authMode: null,
        fromCache: false,
      };
      cache.set(
        cacheKey,
        {
          kind: 'positive',
          models,
          source: result.source,
          endpoint: null,
          authMode: null,
        },
        MODELS_POSITIVE_TTL_MS,
      );
      return result;
    }
  }

  const candidates = config.byok.modelsUrl
    ? [config.byok.modelsUrl]
    : generateModelCandidateUrls(config.baseUrl);

  if (candidates.length === 0) {
    throw createAdapterError({
      kind: ERROR_KINDS.NOT_FOUND,
      status: 404,
      message: 'No model list candidates generated from Base URL',
    });
  }

  const startedAt = Date.now();
  let requestCount = 0;
  let lastError = null;
  const attempts = [];

  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    if (Date.now() - startedAt > MODELS_TOTAL_BUDGET_MS) {
      lastError = createAdapterError({
        kind: ERROR_KINDS.TIMEOUT,
        status: 408,
        message: 'Model discovery exceeded total time budget',
      });
      break;
    }
    if (requestCount >= MODELS_MAX_HTTP_REQUESTS) break;

    const candidateUrl = candidates[candidateIndex];
    const authModes = preferredAuthModesForUrl(candidateUrl);
    let authIndex = 0;

    while (authIndex < authModes.length) {
      if (requestCount >= MODELS_MAX_HTTP_REQUESTS) break;
      if (Date.now() - startedAt > MODELS_TOTAL_BUDGET_MS) break;

      const authMode = authModes[authIndex];
      requestCount += 1;
      const attemptLabel = `${candidateIndex + 1}/${candidates.length}`;
      logger?.debug?.(
        `models probe ${attemptLabel}: ${redactUrl(candidateUrl)} auth=${authMode}`,
      );

      try {
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          MODELS_REQUEST_TIMEOUT_MS,
        );
        let response;
        try {
          response = await fetchImpl(candidateUrl, {
            method: 'GET',
            headers: buildAuthHeaders(
              config.credential,
              authMode,
              config.anthropicVersion,
            ),
            signal: controller.signal,
            redirect: 'manual',
          });
        } finally {
          clearTimeout(timeout);
        }

        // Same-origin redirect: follow once.
        if (
          response.status >= 300 &&
          response.status < 400 &&
          response.headers.get('location')
        ) {
          const location = response.headers.get('location');
          const redirected = new URL(location, candidateUrl);
          const original = new URL(candidateUrl);
          if (redirected.origin !== original.origin) {
            attempts.push({
              url: candidateUrl,
              authMode,
              status: response.status,
              result: 'cross-origin-redirect',
            });
            lastError = createAdapterError({
              kind: ERROR_KINDS.NETWORK,
              status: 502,
              message: 'Cross-origin redirect during model discovery is not followed with credentials',
            });
            break;
          }
          if (requestCount >= MODELS_MAX_HTTP_REQUESTS) break;
          requestCount += 1;
          const followController = new AbortController();
          const followTimeout = setTimeout(
            () => followController.abort(),
            MODELS_REQUEST_TIMEOUT_MS,
          );
          try {
            response = await fetchImpl(redirected.href, {
              method: 'GET',
              headers: buildAuthHeaders(
                config.credential,
                authMode,
                config.anthropicVersion,
              ),
              signal: followController.signal,
              redirect: 'manual',
            });
          } finally {
            clearTimeout(followTimeout);
          }
        }

        if (response.status === 401 || response.status === 403) {
          attempts.push({
            url: candidateUrl,
            authMode,
            status: response.status,
            result: 'auth-failed',
          });
          if (authIndex + 1 < authModes.length) {
            authIndex += 1;
            continue;
          }
          lastError = createAdapterError({
            kind: ERROR_KINDS.AUTH,
            status: response.status,
            message: 'Model discovery authentication failed with both credential header styles',
          });
          cache.delete(cacheKey);
          throw lastError;
        }

        if (response.status === 429) {
          lastError = errorFromHttpResponse(response, '', {
            fallbackMessage: 'Model discovery rate limited',
          });
          throw lastError;
        }

        if (response.status >= 500) {
          lastError = errorFromHttpResponse(response, '', {
            fallbackMessage: 'Model discovery provider error',
          });
          throw lastError;
        }

        if (
          response.status === 404 ||
          response.status === 405 ||
          response.status === 410
        ) {
          attempts.push({
            url: candidateUrl,
            authMode,
            status: response.status,
            result: 'path-unsupported',
          });
          break;
        }

        if (response.status < 200 || response.status >= 300) {
          attempts.push({
            url: candidateUrl,
            authMode,
            status: response.status,
            result: 'unexpected-status',
          });
          lastError = errorFromHttpResponse(response, '', {
            fallbackMessage: `Model discovery unexpected status ${response.status}`,
          });
          break;
        }

        const bodyText = await readBodyWithLimit(response, MODELS_MAX_BODY_BYTES);
        let parsed;
        try {
          parsed = JSON.parse(bodyText);
        } catch {
          attempts.push({
            url: candidateUrl,
            authMode,
            status: response.status,
            result: 'invalid-shape',
          });
          break;
        }

        const models = parseModelsResponse(parsed);
        if (!models) {
          attempts.push({
            url: candidateUrl,
            authMode,
            status: response.status,
            result: 'invalid-shape',
          });
          break;
        }

        logger?.info?.(
          `models probe ${attemptLabel}: ${redactUrl(candidateUrl)} -> success, ${models.length} models`,
        );

        const result = {
          models,
          source: 'network',
          endpoint: candidateUrl,
          authMode,
          fromCache: false,
        };
        cache.set(
          cacheKey,
          {
            kind: 'positive',
            models,
            source: result.source,
            endpoint: candidateUrl,
            authMode,
          },
          MODELS_POSITIVE_TTL_MS,
        );
        return result;
      } catch (error) {
        if (error?.name === 'ByokAdapterError') throw error;
        attempts.push({
          url: candidateUrl,
          authMode,
          status: null,
          result: 'network-error',
        });
        lastError = errorFromNetworkFailure(error);
        break;
      }
    }
  }

  const failure = lastError || createAdapterError({
    kind: ERROR_KINDS.NOT_FOUND,
    status: 404,
    message: 'Unable to discover models from any candidate URL',
  });

  cache.set(
    cacheKey,
    {
      kind: 'negative',
      errorKind: failure.kind,
      status: failure.status,
      message: failure.safeMessage || failure.message,
      attempts,
    },
    MODELS_NEGATIVE_TTL_MS,
  );

  logger?.warn?.('models discovery failed', {
    attempts: attempts.map((item) => ({
      url: redactUrl(item.url),
      authMode: item.authMode,
      status: item.status,
      result: item.result,
    })),
  });

  throw failure;
}

export function parseOperonModels(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parseModelsResponse(parsed);
  } catch {
    // comma-separated id:name
  }
  const models = [];
  const seen = new Set();
  for (const part of trimmed.split(',')) {
    const piece = part.trim();
    if (!piece) continue;
    const [idPart, ...nameParts] = piece.split(':');
    const id = idPart?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const displayName = safeModelDisplayName(nameParts.join(':').trim(), id);
    models.push({ id, display_name: displayName, type: 'model' });
    if (models.length >= MODELS_MAX_ITEMS) break;
  }
  return models.length ? models : null;
}

async function readBodyWithLimit(response, maxBytes) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw createAdapterError({
        kind: ERROR_KINDS.PROVIDER,
        status: 502,
        message: 'Model list response exceeded size limit',
      });
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
      throw createAdapterError({
        kind: ERROR_KINDS.PROVIDER,
        status: 502,
        message: 'Model list response exceeded size limit',
      });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

export function createModelsCache() {
  return new TtlLruCache({ maxEntries: 32, defaultTtlMs: MODELS_POSITIVE_TTL_MS });
}
