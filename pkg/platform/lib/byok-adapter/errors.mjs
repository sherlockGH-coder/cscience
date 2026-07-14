/**
 * Provider error classification and Anthropic-compatible error mapping.
 */

export const ERROR_KINDS = {
  AUTH: 'auth',
  RATE_LIMIT: 'rate_limit',
  NOT_FOUND: 'not_found',
  UNSUPPORTED_ENDPOINT: 'unsupported_endpoint',
  VALIDATION: 'validation',
  PROVIDER: 'provider',
  TIMEOUT: 'timeout',
  NETWORK: 'network',
  CANCELLED: 'cancelled',
  UNSUPPORTED_FEATURE: 'unsupported_feature',
  INTERNAL: 'internal',
};

const ENDPOINT_UNSUPPORTED_STATUSES = new Set([404, 405, 410, 501]);
const AUTH_STATUSES = new Set([401, 403]);
const VALIDATION_STATUSES = new Set([400, 422]);

export function createAdapterError(options) {
  const error = new Error(options.message || 'BYOK adapter error');
  error.name = 'ByokAdapterError';
  error.kind = options.kind || ERROR_KINDS.INTERNAL;
  error.status = options.status ?? 500;
  error.providerType = options.providerType ?? null;
  error.providerCode = options.providerCode ?? null;
  error.providerRequestId = options.providerRequestId ?? null;
  error.retryAfter = options.retryAfter ?? null;
  error.allowProtocolFallback = Boolean(options.allowProtocolFallback);
  error.safeMessage = options.safeMessage || sanitizeErrorMessage(options.message);
  error.cause = options.cause;
  return error;
}

export function sanitizeErrorMessage(message) {
  if (!message) return 'Request failed';
  return String(message)
    .replace(/sk-[a-zA-Z0-9_-]{8,}/g, '[redacted-key]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/x-api-key[=:]\s*\S+/gi, 'x-api-key=[redacted]')
    .slice(0, 500);
}

export function classifyHttpStatus(status, bodyHint = '') {
  const text = String(bodyHint || '').toLowerCase();
  if (AUTH_STATUSES.has(status)) {
    return {
      kind: ERROR_KINDS.AUTH,
      allowProtocolFallback: false,
    };
  }
  if (status === 429) {
    return {
      kind: ERROR_KINDS.RATE_LIMIT,
      allowProtocolFallback: false,
    };
  }
  if (ENDPOINT_UNSUPPORTED_STATUSES.has(status)) {
    return {
      kind: ERROR_KINDS.UNSUPPORTED_ENDPOINT,
      allowProtocolFallback: true,
    };
  }
  if (VALIDATION_STATUSES.has(status)) {
    const endpointHint =
      text.includes('not found') ||
      text.includes('unknown endpoint') ||
      text.includes('unsupported api') ||
      text.includes('invalid url');
    return {
      kind: endpointHint ? ERROR_KINDS.UNSUPPORTED_ENDPOINT : ERROR_KINDS.VALIDATION,
      allowProtocolFallback: endpointHint,
    };
  }
  if (status >= 500) {
    return {
      kind: ERROR_KINDS.PROVIDER,
      allowProtocolFallback: false,
    };
  }
  if (status === 408) {
    return {
      kind: ERROR_KINDS.TIMEOUT,
      allowProtocolFallback: false,
    };
  }
  return {
    kind: ERROR_KINDS.PROVIDER,
    allowProtocolFallback: false,
  };
}

export function errorFromHttpResponse(response, bodyText = '', options = {}) {
  const classification = classifyHttpStatus(response.status, bodyText);
  let providerType = null;
  let providerCode = null;
  let parsedMessage = null;
  try {
    const parsed = JSON.parse(bodyText);
    providerType = parsed?.error?.type || parsed?.type || null;
    providerCode = parsed?.error?.code || parsed?.code || null;
    parsedMessage = parsed?.error?.message || parsed?.message || null;
  } catch {
    // non-JSON body is fine
  }

  const status = response.status;
  const safeMessage =
    parsedMessage ||
    options.fallbackMessage ||
    `Upstream returned HTTP ${status}`;

  return createAdapterError({
    kind: classification.kind,
    status,
    message: safeMessage,
    safeMessage: sanitizeErrorMessage(safeMessage),
    providerType,
    providerCode,
    providerRequestId:
      response.headers?.get?.('x-request-id') ||
      response.headers?.get?.('request-id') ||
      null,
    retryAfter: response.headers?.get?.('retry-after') || null,
    allowProtocolFallback:
      options.allowProtocolFallback ?? classification.allowProtocolFallback,
  });
}

export function errorFromNetworkFailure(error) {
  if (error?.name === 'AbortError') {
    return createAdapterError({
      kind: ERROR_KINDS.CANCELLED,
      status: 499,
      message: 'Request cancelled',
      allowProtocolFallback: false,
      cause: error,
    });
  }
  const message = error?.message || 'Network error';
  const isTimeout =
    /timeout|timed out|aborted/i.test(message) || error?.code === 'UND_ERR_CONNECT_TIMEOUT';
  return createAdapterError({
    kind: isTimeout ? ERROR_KINDS.TIMEOUT : ERROR_KINDS.NETWORK,
    status: isTimeout ? 408 : 502,
    message,
    allowProtocolFallback: false,
    cause: error,
  });
}

export function toAnthropicErrorBody(error) {
  const type =
    error.kind === ERROR_KINDS.AUTH
      ? 'authentication_error'
      : error.kind === ERROR_KINDS.RATE_LIMIT
        ? 'rate_limit_error'
        : error.kind === ERROR_KINDS.VALIDATION ||
            error.kind === ERROR_KINDS.UNSUPPORTED_FEATURE
          ? 'invalid_request_error'
          : error.kind === ERROR_KINDS.NOT_FOUND ||
              error.kind === ERROR_KINDS.UNSUPPORTED_ENDPOINT
            ? 'not_found_error'
            : 'api_error';

  return {
    type: 'error',
    error: {
      type,
      message: error.safeMessage || sanitizeErrorMessage(error.message),
    },
  };
}

export function writeAnthropicError(response, error) {
  const status = error.status && error.status >= 400 ? error.status : 500;
  const body = toAnthropicErrorBody(error);
  const headers = {
    'content-type': 'application/json',
  };
  if (error.retryAfter) headers['retry-after'] = String(error.retryAfter);
  if (error.providerRequestId) headers['x-request-id'] = String(error.providerRequestId);
  response.writeHead(status, headers);
  response.end(JSON.stringify(body));
}
