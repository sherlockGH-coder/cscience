import { createAdapterError, ERROR_KINDS } from './errors.mjs';
import { credentialFingerprint, sha256Hex } from './cache.mjs';

export const PROTOCOL_SUFFIXES = [
  '/anthropic/v1',
  '/anthropic',
  '/openai/v1',
  '/openai',
];

export const API_FORMATS = {
  AUTO: 'auto',
  ANTHROPIC: 'anthropic',
  OPENAI_CHAT: 'openai-chat',
  OPENAI_RESPONSES: 'openai-responses',
};

export const PROVIDER_KINDS = {
  AUTO: 'auto',
  DEEPSEEK: 'deepseek',
  GENERIC: 'generic',
};

export const DEFAULT_REASONING_EFFORT = 'high';
export const ADAPTER_VERSION = '1.0.0';

/**
 * Normalize provider Base URL per design doc §7.2.
 */
export function normalizeBaseUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw createAdapterError({
      kind: ERROR_KINDS.VALIDATION,
      status: 400,
      message: 'ANTHROPIC_BASE_URL is required for BYOK adapter',
    });
  }

  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw createAdapterError({
      kind: ERROR_KINDS.VALIDATION,
      status: 400,
      message: 'ANTHROPIC_BASE_URL is not a valid URL',
    });
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw createAdapterError({
      kind: ERROR_KINDS.VALIDATION,
      status: 400,
      message: 'ANTHROPIC_BASE_URL must use http or https',
    });
  }

  if (parsed.username || parsed.password) {
    throw createAdapterError({
      kind: ERROR_KINDS.VALIDATION,
      status: 400,
      message: 'ANTHROPIC_BASE_URL must not include username or password',
    });
  }

  parsed.search = '';
  parsed.hash = '';

  let pathname = parsed.pathname || '/';
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  if (!pathname) pathname = '/';
  parsed.pathname = pathname;

  return {
    href: parsed.href.endsWith('/') && parsed.pathname === '/'
      ? parsed.origin + '/'
      : parsed.origin + (pathname === '/' ? '' : pathname) + (pathname === '/' ? '/' : ''),
    origin: parsed.origin,
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port,
    pathname,
    url: new URL(parsed.href),
  };
}

export function stripProtocolSuffix(pathname) {
  const normalized = pathname === '/' ? '/' : pathname.replace(/\/+$/, '') || '/';
  for (const suffix of PROTOCOL_SUFFIXES) {
    if (normalized === suffix) return '/';
    if (normalized.endsWith(suffix)) {
      const stripped = normalized.slice(0, -suffix.length);
      return stripped === '' ? '/' : stripped;
    }
  }
  return null;
}

export function endsWithProtocolSuffix(pathname) {
  const normalized = pathname === '/' ? '/' : pathname.replace(/\/+$/, '') || '/';
  return PROTOCOL_SUFFIXES.some(
    (suffix) => normalized === suffix || normalized.endsWith(suffix),
  );
}

export function resolveApiFormatHint(pathname) {
  const normalized = pathname === '/' ? '/' : pathname.replace(/\/+$/, '') || '/';
  if (normalized.endsWith('/anthropic') || normalized.endsWith('/anthropic/v1')) {
    return [API_FORMATS.ANTHROPIC, API_FORMATS.OPENAI_RESPONSES, API_FORMATS.OPENAI_CHAT];
  }
  if (
    normalized.endsWith('/openai') ||
    normalized.endsWith('/openai/v1') ||
    normalized.endsWith('/v1')
  ) {
    return [API_FORMATS.OPENAI_RESPONSES, API_FORMATS.OPENAI_CHAT, API_FORMATS.ANTHROPIC];
  }
  return [API_FORMATS.ANTHROPIC, API_FORMATS.OPENAI_RESPONSES, API_FORMATS.OPENAI_CHAT];
}

export function parseCredential(config) {
  const apiKey = config.ANTHROPIC_API_KEY?.trim() || null;
  const authToken = config.ANTHROPIC_AUTH_TOKEN?.trim() || null;
  if (!apiKey && !authToken) {
    throw createAdapterError({
      kind: ERROR_KINDS.AUTH,
      status: 401,
      message: 'No credentials. Set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN.',
    });
  }
  // Prefer API key when both are present (matches common Anthropic tooling).
  if (apiKey) {
    return { type: 'api_key', value: apiKey, headerMode: 'x-api-key' };
  }
  return { type: 'auth_token', value: authToken, headerMode: 'bearer' };
}

export function parseByokOptions(raw = {}) {
  const apiFormat = (raw.BYOK_API_FORMAT || API_FORMATS.AUTO).trim().toLowerCase();
  const allowedFormats = new Set(Object.values(API_FORMATS));
  if (!allowedFormats.has(apiFormat)) {
    throw createAdapterError({
      kind: ERROR_KINDS.VALIDATION,
      status: 400,
      message: `Invalid BYOK_API_FORMAT: ${apiFormat}`,
    });
  }

  const provider = (raw.BYOK_PROVIDER || PROVIDER_KINDS.AUTO).trim().toLowerCase();
  const allowedProviders = new Set(Object.values(PROVIDER_KINDS));
  if (!allowedProviders.has(provider)) {
    throw createAdapterError({
      kind: ERROR_KINDS.VALIDATION,
      status: 400,
      message: `Invalid BYOK_PROVIDER: ${provider}`,
    });
  }

  const reasoningEffort = (raw.BYOK_REASONING_EFFORT || DEFAULT_REASONING_EFFORT)
    .trim()
    .toLowerCase();
  if (reasoningEffort !== 'high' && reasoningEffort !== 'max') {
    throw createAdapterError({
      kind: ERROR_KINDS.VALIDATION,
      status: 400,
      message: `Invalid BYOK_REASONING_EFFORT: ${reasoningEffort}`,
    });
  }

  let modelsUrl = null;
  if (raw.BYOK_MODELS_URL?.trim()) {
    try {
      const parsed = new URL(raw.BYOK_MODELS_URL.trim());
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('bad protocol');
      }
      modelsUrl = parsed.href;
    } catch {
      throw createAdapterError({
        kind: ERROR_KINDS.VALIDATION,
        status: 400,
        message: 'BYOK_MODELS_URL must be a valid http(s) URL',
      });
    }
  }

  return {
    apiFormat,
    modelsUrl,
    provider,
    reasoningEffort,
    debug: raw.BYOK_DEBUG === '1' || raw.BYOK_DEBUG === 1 || raw.BYOK_DEBUG === true,
  };
}

export function adapterConfigFingerprint(raw = {}) {
  const baseUrlRaw = raw.ANTHROPIC_BASE_URL?.trim() || 'https://api.anthropic.com';
  const base = normalizeBaseUrl(baseUrlRaw);
  const credential = parseCredential(raw);
  const byok = parseByokOptions(raw);
  return sha256Hex(JSON.stringify({
    version: ADAPTER_VERSION,
    baseUrl: base.href,
    credentialFingerprint: credentialFingerprint(credential),
    apiFormat: byok.apiFormat,
    modelsUrl: byok.modelsUrl,
    provider: byok.provider,
    reasoningEffort: byok.reasoningEffort,
    debug: byok.debug,
    operonModels: raw.OPERON_MODELS?.trim() || null,
    anthropicVersion: raw.ANTHROPIC_VERSION?.trim() || '2023-06-01',
  }));
}

/**
 * Build in-memory adapter configuration from env-like object.
 * Real credentials never leave process memory except when calling the provider.
 */
export function buildAdapterConfig(raw = {}) {
  const baseUrlRaw =
    raw.ANTHROPIC_BASE_URL?.trim() || 'https://api.anthropic.com';
  const base = normalizeBaseUrl(baseUrlRaw);
  const credential = parseCredential(raw);
  const byok = parseByokOptions(raw);
  const localToken = raw.BYOK_LOCAL_TOKEN?.trim();
  if (!localToken || localToken.length < 32) {
    throw createAdapterError({
      kind: ERROR_KINDS.INTERNAL,
      status: 500,
      message: 'BYOK_LOCAL_TOKEN must be at least 32 characters',
    });
  }

  return {
    baseUrl: base,
    credential,
    credentialFingerprint: credentialFingerprint(credential),
    baseUrlFingerprint: sha256Hex(base.href),
    localToken,
    byok,
    operonModels: raw.OPERON_MODELS?.trim() || null,
    anthropicVersion: raw.ANTHROPIC_VERSION?.trim() || '2023-06-01',
    version: ADAPTER_VERSION,
    configFingerprint: adapterConfigFingerprint(raw),
  };
}

export function joinUrlPath(baseHref, pathSegment) {
  const base = new URL(baseHref);
  const basePath = base.pathname.endsWith('/')
    ? base.pathname.slice(0, -1)
    : base.pathname;
  const segment = pathSegment.startsWith('/') ? pathSegment : `/${pathSegment}`;
  if (basePath === '' || basePath === '/') {
    base.pathname = segment;
  } else {
    base.pathname = `${basePath}${segment}`;
  }
  return base.href;
}
