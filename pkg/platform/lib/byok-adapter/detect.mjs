import { API_FORMATS, resolveApiFormatHint } from './config.mjs';
import { cacheKeyParts, TtlLruCache } from './cache.mjs';
import { ERROR_KINDS } from './errors.mjs';

export const PROTOCOL_CACHE_TTL_MS = 60 * 60 * 1000;

export function createProtocolCache() {
  return new TtlLruCache({ maxEntries: 32, defaultTtlMs: PROTOCOL_CACHE_TTL_MS });
}

export function listProtocolCandidates(config) {
  if (config.byok.apiFormat && config.byok.apiFormat !== API_FORMATS.AUTO) {
    return [config.byok.apiFormat];
  }
  return resolveApiFormatHint(config.baseUrl.pathname);
}

export function getCachedProtocol(cache, config) {
  const key = protocolCacheKey(config);
  return cache.get(key) || null;
}

export function setCachedProtocol(cache, config, format) {
  cache.set(protocolCacheKey(config), format, PROTOCOL_CACHE_TTL_MS);
}

export function clearCachedProtocol(cache, config) {
  cache.delete(protocolCacheKey(config));
}

function protocolCacheKey(config) {
  return cacheKeyParts([
    'protocol',
    config.baseUrlFingerprint,
    config.credentialFingerprint,
  ]);
}

/**
 * Whether a failed attempt may fall back to the next protocol with the same request.
 */
export function canFallbackProtocol(error, options = {}) {
  if (options.forcedFormat) return false;
  if (options.responseStarted) return false;
  if (options.toolSideEffect) return false;
  if (!error) return false;
  if (error.allowProtocolFallback === true) return true;
  if (error.kind === ERROR_KINDS.UNSUPPORTED_ENDPOINT) return true;
  // Non-standard relays may drop the connection instead of returning 404/405
  // for unsupported endpoints. If no response headers were received, treat a
  // network-level failure as "endpoint likely unsupported" and allow fallback.
  if (error.kind === ERROR_KINDS.NETWORK) return true;
  return false;
}

export function messagesEndpointForFormat(baseUrl, format) {
  const pathname = baseUrl.pathname === '/' ? '/' : baseUrl.pathname.replace(/\/+$/, '') || '/';
  const origin = baseUrl.origin;

  if (format === API_FORMATS.ANTHROPIC) {
    // Preserve path prefix including /anthropic when present.
    if (pathname.endsWith('/v1')) {
      return `${origin}${pathname}/messages`;
    }
    if (pathname === '/') {
      return `${origin}/v1/messages`;
    }
    return `${origin}${pathname}/v1/messages`;
  }

  // OpenAI-style endpoints: strip protocol suffix then use /v1/...
  let rootPath = pathname;
  for (const suffix of ['/anthropic/v1', '/anthropic', '/openai/v1', '/openai']) {
    if (rootPath === suffix) {
      rootPath = '/';
      break;
    }
    if (rootPath.endsWith(suffix)) {
      rootPath = rootPath.slice(0, -suffix.length) || '/';
      break;
    }
  }
  if (rootPath.endsWith('/v1')) {
    // already on v1
  } else if (rootPath === '/') {
    rootPath = '/v1';
  } else {
    rootPath = `${rootPath}/v1`;
  }

  if (format === API_FORMATS.OPENAI_CHAT) {
    return `${origin}${rootPath}/chat/completions`;
  }
  if (format === API_FORMATS.OPENAI_RESPONSES) {
    return `${origin}${rootPath}/responses`;
  }
  throw new Error(`Unknown API format: ${format}`);
}
