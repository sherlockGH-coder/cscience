import { messagesEndpointForFormat } from '../detect.mjs';
import { API_FORMATS } from '../config.mjs';
import {
  applyDeepSeekThinkingNormalization,
  isDeepSeekProvider,
  makeThinkingSignature,
  storeReasoningContent,
} from '../providers/deepseek.mjs';
import {
  anthropicMessageToNormalizedResponse,
  assistantTurnHash,
  extractToolUseIds,
} from '../normalize.mjs';
import {
  errorFromHttpResponse,
  errorFromNetworkFailure,
} from '../errors.mjs';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'authorization',
  'x-api-key',
  'x-byok-token',
]);

export function filterOutboundHeaders(incomingHeaders, config) {
  const headers = {};
  for (const [name, value] of Object.entries(incomingHeaders || {})) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower.startsWith('x-byok-')) continue;
    headers[lower] = value;
  }

  if (config.credential.headerMode === 'bearer' || config.credential.type === 'auth_token') {
    headers.authorization = `Bearer ${config.credential.value}`;
  } else {
    headers['x-api-key'] = config.credential.value;
  }

  if (!headers['anthropic-version']) {
    headers['anthropic-version'] = config.anthropicVersion || '2023-06-01';
  }
  headers.accept = headers.accept || 'application/json';
  headers['content-type'] = 'application/json';
  return headers;
}

export async function handleAnthropicUpstream(context) {
  const {
    config,
    normalizedRequest,
    incomingHeaders,
    signal,
    logger,
    fetchImpl = globalThis.fetch,
    reasoningCache,
  } = context;

  const endpoint = messagesEndpointForFormat(config.baseUrl, API_FORMATS.ANTHROPIC);
  let body = { ...normalizedRequest.rawAnthropic };

  const deepseek = isDeepSeekProvider(config);
  if (deepseek) {
    const thinking = applyDeepSeekThinkingNormalization(
      normalizedRequest,
      config,
      logger,
    );
    body = thinking.anthropicPatch(body);
  }

  const headers = filterOutboundHeaders(incomingHeaders, config);

  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
      redirect: 'manual',
    });
  } catch (error) {
    throw errorFromNetworkFailure(error);
  }

  if (response.status >= 300 && response.status < 400) {
    throw errorFromHttpResponse(response, '', {
      fallbackMessage: 'Anthropic upstream redirect is not automatically followed with credentials',
      allowProtocolFallback: false,
    });
  }

  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) {
    const errorText = await response.text();
    throw errorFromHttpResponse(response, errorText);
  }

  if (normalizedRequest.stream || contentType.includes('text/event-stream')) {
    return {
      kind: 'stream',
      response,
      passthrough: true,
    };
  }

  const json = await response.json();
  let normalized = anthropicMessageToNormalizedResponse(json);

  if (deepseek && reasoningCache) {
    const thinkingBlock = normalized.contentBlocks.find(
      (block) => block.type === 'thinking' && block.thinking,
    );
    if (thinkingBlock) {
      const turnHash = assistantTurnHash(normalized);
      const toolIds = extractToolUseIds(normalized);
      const signature =
        thinkingBlock.signature || makeThinkingSignature(`${turnHash}:${toolIds.join(',')}`);
      thinkingBlock.signature = signature;
      storeReasoningContent(reasoningCache, {
        reasoningContent: thinkingBlock.thinking,
        toolCallIds: toolIds,
        assistantTurnHashValue: turnHash,
        signature,
      });
    }
  }

  return {
    kind: 'json',
    response,
    body: json,
    normalized,
    passthrough: !deepseek,
  };
}
