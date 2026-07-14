import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { anthropicRequestToNormalized } from './normalize.mjs';
import {
  createAdapterError,
  ERROR_KINDS,
  writeAnthropicError,
} from './errors.mjs';
import { discoverModels, createModelsCache } from './models.mjs';
import {
  canFallbackProtocol,
  clearCachedProtocol,
  createProtocolCache,
  getCachedProtocol,
  listProtocolCandidates,
  setCachedProtocol,
} from './detect.mjs';
import { API_FORMATS } from './config.mjs';
import { handleAnthropicUpstream } from './protocols/anthropic.mjs';
import {
  createChatDialectCache,
  handleOpenAiChat,
} from './protocols/openai-chat.mjs';
import {
  createResponseItemCache,
  handleOpenAiResponses,
} from './protocols/openai-responses.mjs';
import { createReasoningCache } from './providers/deepseek.mjs';
import {
  normalizedResponseToAnthropicMessage,
  writeAnthropicJson,
} from './stream/anthropic-writer.mjs';
import { createLogger } from './log.mjs';

export function createAdapterServer(config, options = {}) {
  const logger = options.logger || createLogger({ debug: config.byok.debug });
  const modelsCache = options.modelsCache || createModelsCache();
  const protocolCache = options.protocolCache || createProtocolCache();
  const chatDialectCache = options.chatDialectCache || createChatDialectCache();
  const reasoningCache = options.reasoningCache || createReasoningCache();
  const responseItemCache = options.responseItemCache || createResponseItemCache();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const activeControllers = new Set();
  let shuttingDown = false;

  const server = createServer(async (request, response) => {
    if (shuttingDown) {
      writeAnthropicError(
        response,
        createAdapterError({
          kind: ERROR_KINDS.PROVIDER,
          status: 503,
          message: 'Adapter is shutting down',
        }),
      );
      return;
    }

    try {
      await routeRequest(request, response);
    } catch (error) {
      if (!response.headersSent) {
        writeAnthropicError(
          response,
          error?.name === 'ByokAdapterError'
            ? error
            : createAdapterError({
                kind: ERROR_KINDS.INTERNAL,
                status: 500,
                message: error?.message || 'Internal adapter error',
              }),
        );
      } else {
        try {
          response.end();
        } catch (endError) {
          logger.debug(`failed to end response after post-headers error: ${endError?.message ?? endError}`);
        }
      }
    }
  });

  async function routeRequest(request, response) {
    if (!authorizeLocalRequest(request, config.localToken)) {
      writeAnthropicError(
        response,
        createAdapterError({
          kind: ERROR_KINDS.AUTH,
          status: 401,
          message: 'Invalid local adapter token',
        }),
      );
      return;
    }

    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'GET' && (path === '/health' || path === '/v1/health')) {
      writeAnthropicJson(response, 200, {
        ok: true,
        version: config.version,
        pid: process.pid,
      });
      return;
    }

    if (request.method === 'GET' && path === '/v1/models') {
      const result = await discoverModels({
        config,
        logger,
        fetchImpl,
        cache: modelsCache,
      });
      writeAnthropicJson(response, 200, {
        object: 'list',
        data: result.models,
      });
      return;
    }

    if (request.method === 'POST' && path === '/v1/messages') {
      await handleMessages(request, response);
      return;
    }

    writeAnthropicError(
      response,
      createAdapterError({
        kind: ERROR_KINDS.NOT_FOUND,
        status: 404,
        message: `Unknown adapter path: ${request.method} ${path}`,
      }),
    );
  }

  async function handleMessages(request, response) {
    const bodyText = await readRequestBody(request);
    let body;
    try {
      body = JSON.parse(bodyText || '{}');
    } catch {
      throw createAdapterError({
        kind: ERROR_KINDS.VALIDATION,
        status: 400,
        message: 'Request body must be valid JSON',
      });
    }

    const normalizedRequest = anthropicRequestToNormalized(body);
    const incomingHeaders = flattenHeaders(request.headers);
    const controller = new AbortController();
    activeControllers.add(controller);
    const abortProviderRequest = () => controller.abort();
    const onResponseClose = () => {
      if (!response.writableEnded) abortProviderRequest();
    };
    request.once('aborted', abortProviderRequest);
    response.once('close', onResponseClose);

    try {
      const forced =
        config.byok.apiFormat && config.byok.apiFormat !== API_FORMATS.AUTO
          ? config.byok.apiFormat
          : null;
      const cached = forced ? null : getCachedProtocol(protocolCache, config);
      const candidates = forced
        ? [forced]
        : cached
          ? [cached, ...listProtocolCandidates(config).filter((item) => item !== cached)]
          : listProtocolCandidates(config);

      let lastError = null;
      for (let index = 0; index < candidates.length; index += 1) {
        const format = candidates[index];
        try {
          const result = await dispatchProtocol({
            format,
            config,
            normalizedRequest,
            incomingHeaders,
            signal: controller.signal,
            logger,
            fetchImpl,
            reasoningCache,
            responseItemCache,
            chatDialectCache,
            clientResponse: response,
          });

          setCachedProtocol(protocolCache, config, format);
          logger.info(`api format: ${format}${cached === format ? ' (cached)' : ' (auto)'}`);

          if (result.kind === 'stream-written') return;
          if (result.kind === 'stream' && result.passthrough) {
            await pipePassthroughStream(result.response, response, controller.signal);
            return;
          }
          if (result.kind === 'json') {
            const payload =
              result.passthrough && result.body
                ? result.body
                : result.body || normalizedResponseToAnthropicMessage(result.normalized);
            writeAnthropicJson(response, 200, payload);
            return;
          }
          throw createAdapterError({
            kind: ERROR_KINDS.INTERNAL,
            status: 500,
            message: `Unexpected protocol result kind: ${result.kind}`,
          });
        } catch (error) {
          lastError = error;
          const mayFallback = canFallbackProtocol(error, {
            forcedFormat: Boolean(forced),
            responseStarted: response.headersSent,
            toolSideEffect: false,
          });
          if (mayFallback && index + 1 < candidates.length) {
            logger.debug(`protocol ${format} unsupported, trying next`);
            if (cached === format) clearCachedProtocol(protocolCache, config);
            continue;
          }
          if (error?.kind === ERROR_KINDS.UNSUPPORTED_ENDPOINT && cached === format) {
            clearCachedProtocol(protocolCache, config);
          }
          throw error;
        }
      }
      throw lastError || createAdapterError({
        kind: ERROR_KINDS.PROVIDER,
        status: 502,
        message: 'No compatible API format found',
      });
    } finally {
      request.off('aborted', abortProviderRequest);
      response.off('close', onResponseClose);
      activeControllers.delete(controller);
    }
  }

  async function dispatchProtocol(context) {
    const { format } = context;
    if (format === API_FORMATS.ANTHROPIC) {
      return handleAnthropicUpstream(context);
    }
    if (format === API_FORMATS.OPENAI_CHAT) {
      return handleOpenAiChat(context);
    }
    if (format === API_FORMATS.OPENAI_RESPONSES) {
      return handleOpenAiResponses(context);
    }
    throw createAdapterError({
      kind: ERROR_KINDS.VALIDATION,
      status: 400,
      message: `Unknown API format: ${format}`,
    });
  }

  function shutdown(timeoutMs = 5000) {
    shuttingDown = true;
    for (const controller of activeControllers) {
      try {
        controller.abort();
      } catch (abortError) {
        logger.debug(`failed to abort in-flight request during shutdown: ${abortError?.message ?? abortError}`);
      }
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          server.close();
        } catch (closeError) {
          logger.debug(`server.close() failed on shutdown timeout: ${closeError?.message ?? closeError}`);
        }
        resolve();
      }, timeoutMs);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  return {
    server,
    logger,
    modelsCache,
    protocolCache,
    chatDialectCache,
    reasoningCache,
    responseItemCache,
    shutdown,
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          const address = server.address();
          resolve({
            host: address.address,
            port: address.port,
          });
        });
      });
    },
  };
}

function authorizeLocalRequest(request, localToken) {
  const headerKey = request.headers['x-api-key'];
  const auth = request.headers.authorization || '';
  let provided = null;
  if (typeof headerKey === 'string' && headerKey) provided = headerKey;
  else if (auth.toLowerCase().startsWith('bearer ')) {
    provided = auth.slice(7).trim();
  }
  if (!provided) return false;
  const expected = Buffer.from(localToken);
  const actual = Buffer.from(provided);
  if (expected.length !== actual.length) return false;
  try {
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function flattenHeaders(headers) {
  const output = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (Array.isArray(value)) output[name] = value.join(',');
    else if (value != null) output[name] = String(value);
  }
  return output;
}

async function readRequestBody(request, maxBytes = 20 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) {
      throw createAdapterError({
        kind: ERROR_KINDS.VALIDATION,
        status: 413,
        message: 'Request body too large',
      });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function pipePassthroughStream(upstreamResponse, clientResponse, signal) {
  const headers = {
    'content-type':
      upstreamResponse.headers.get('content-type') || 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
  };
  const requestId = upstreamResponse.headers.get('request-id') ||
    upstreamResponse.headers.get('x-request-id');
  if (requestId) headers['request-id'] = requestId;

  clientResponse.writeHead(upstreamResponse.status, headers);

  const reader = upstreamResponse.body.getReader();
  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel();
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      clientResponse.write(Buffer.from(value));
    }
  } finally {
    try {
      clientResponse.end();
    } catch (endError) {
      console.error(`[BYOK] failed to close passthrough stream to client: ${endError?.message ?? endError}`);
    }
  }
}
