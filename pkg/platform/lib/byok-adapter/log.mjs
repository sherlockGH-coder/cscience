/**
 * Centralized redacted logging for the BYOK adapter.
 * Never log credentials, tokens, request bodies, thinking, or tool payloads.
 */

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'x-api-key',
  'x-byok-token',
  'proxy-authorization',
  'cookie',
  'set-cookie',
]);

const SENSITIVE_QUERY_KEYS = new Set([
  'key',
  'api_key',
  'apikey',
  'token',
  'access_token',
  'auth',
]);

function isDebugEnabled(debugFlag) {
  return debugFlag === true || debugFlag === 1 || debugFlag === '1';
}

export function createLogger(options = {}) {
  const debugEnabled = isDebugEnabled(options.debug);
  const prefix = options.prefix ?? '[BYOK]';
  const output = options.output ?? console;

  function write(level, message, details) {
    if (level === 'debug' && !debugEnabled) return;
    const detailText = details === undefined ? '' : ` ${formatDetails(details)}`;
    const line = `${prefix} ${message}${detailText}`;
    if (level === 'error') {
      output.error(line);
      return;
    }
    if (level === 'warn') {
      output.warn(line);
      return;
    }
    output.log(line);
  }

  return {
    debugEnabled,
    info(message, details) {
      write('info', message, details);
    },
    warn(message, details) {
      write('warn', message, details);
    },
    error(message, details) {
      write('error', message, details);
    },
    debug(message, details) {
      write('debug', message, details);
    },
  };
}

export function redactUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const parsed = new URL(rawUrl);
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
        parsed.searchParams.set(key, '[redacted]');
      }
    }
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return '[invalid-url]';
  }
}

export function redactHeaders(headers) {
  const output = {};
  if (!headers) return output;
  const entries =
    typeof headers.entries === 'function'
      ? [...headers.entries()]
      : Object.entries(headers);
  for (const [name, value] of entries) {
    const lower = String(name).toLowerCase();
    output[lower] = SENSITIVE_HEADER_NAMES.has(lower) ? '[redacted]' : String(value);
  }
  return output;
}

export function shortFingerprint(value, length = 8) {
  if (!value) return 'none';
  // Non-cryptographic short tag for logs only; real fingerprints use SHA-256.
  let hash = 2166136261;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(length, '0').slice(0, length);
}

function formatDetails(details) {
  if (details === null || details === undefined) return '';
  if (typeof details === 'string') return details;
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}
