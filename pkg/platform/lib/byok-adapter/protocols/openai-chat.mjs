import { randomUUID } from 'node:crypto';
import { API_FORMATS } from '../config.mjs';
import { messagesEndpointForFormat } from '../detect.mjs';
import {
  applyDeepSeekThinkingNormalization,
  attachReasoningToChatMessages,
  isDeepSeekProvider,
  makeThinkingSignature,
  storeReasoningContent,
} from '../providers/deepseek.mjs';
import {
  assistantTurnHash,
  extractToolUseIds,
} from '../normalize.mjs';
import { TtlLruCache } from '../cache.mjs';
import {
  createAdapterError,
  ERROR_KINDS,
  errorFromHttpResponse,
  errorFromNetworkFailure,
} from '../errors.mjs';
import { readSseEvents } from '../stream/sse-reader.mjs';
import {
  AnthropicSseWriter,
  normalizedResponseToAnthropicMessage,
} from '../stream/anthropic-writer.mjs';

const CHAT_DIALECT_CACHE_TTL_MS = 60 * 60 * 1000;
const CHAT_DIALECT_CACHE_MAX = 200;
const MAX_COMPLETION_TOKENS = 'max_completion_tokens';
const MAX_TOKENS = 'max_tokens';

export function createChatDialectCache() {
  return new TtlLruCache({
    maxEntries: CHAT_DIALECT_CACHE_MAX,
    defaultTtlMs: CHAT_DIALECT_CACHE_TTL_MS,
  });
}

export function normalizedToChatRequest(normalizedRequest, options = {}) {
  const messages = [];

  if (normalizedRequest.system?.length) {
    const systemText = normalizedRequest.system
      .map((block) => {
        if (block.type === 'text') return block.text;
        throw createAdapterError({
          kind: ERROR_KINDS.UNSUPPORTED_FEATURE,
          status: 400,
          message: `Chat Completions does not support system block type: ${block.type}`,
        });
      })
      .join('\n');
    if (systemText) {
      messages.push({ role: 'system', content: systemText });
    }
  }

  for (const message of normalizedRequest.messages) {
    if (message.role === 'user') {
      messages.push(...convertUserMessage(message));
      continue;
    }
    if (message.role === 'assistant') {
      messages.push(...convertAssistantMessage(message));
    }
  }

  const body = {
    model: normalizedRequest.model,
    messages,
    stream: Boolean(normalizedRequest.stream),
  };

  if (normalizedRequest.stream) {
    body.stream_options = { include_usage: true };
  }

  if (normalizedRequest.tools?.length) {
    body.tools = normalizedRequest.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema || {},
        ...(tool.strict ? { strict: true } : {}),
      },
    }));
  }

  if (normalizedRequest.toolChoice) {
    body.tool_choice = mapToolChoice(normalizedRequest.toolChoice);
  }

  if (normalizedRequest.maxOutputTokens != null) {
    const dialect = options.maxTokensDialect || 'max_completion_tokens';
    if (dialect === 'max_tokens') {
      body.max_tokens = normalizedRequest.maxOutputTokens;
    } else {
      body.max_completion_tokens = normalizedRequest.maxOutputTokens;
    }
  }

  if (normalizedRequest.stopSequences?.length) {
    body.stop = normalizedRequest.stopSequences;
  }
  if (normalizedRequest.temperature !== undefined) {
    body.temperature = normalizedRequest.temperature;
  }
  if (normalizedRequest.topP !== undefined) {
    body.top_p = normalizedRequest.topP;
  }
  if (normalizedRequest.presencePenalty !== undefined) {
    body.presence_penalty = normalizedRequest.presencePenalty;
  }
  if (normalizedRequest.frequencyPenalty !== undefined) {
    body.frequency_penalty = normalizedRequest.frequencyPenalty;
  }
  if (normalizedRequest.outputFormat) {
    body.response_format = mapChatOutputFormat(normalizedRequest.outputFormat);
  }

  return body;
}

function mapChatOutputFormat(format) {
  if (format.type === 'json_schema') {
    if (!format.schema || typeof format.schema !== 'object' || Array.isArray(format.schema)) {
      throw createAdapterError({
        kind: ERROR_KINDS.VALIDATION,
        status: 400,
        message: 'json_schema output format requires schema',
      });
    }
    return {
      type: 'json_schema',
      json_schema: {
        name: format.name || 'structured_output',
        ...(format.description ? { description: format.description } : {}),
        ...('strict' in format ? { strict: Boolean(format.strict) } : {}),
        schema: format.schema,
      },
    };
  }
  if (format.type === 'json_object' || format.type === 'text') {
    return { type: format.type };
  }
  throw createAdapterError({
    kind: ERROR_KINDS.UNSUPPORTED_FEATURE,
    status: 400,
    message: `Unsupported Chat Completions output format: ${format.type}`,
  });
}

function convertUserMessage(message) {
  const toolResults = message.content.filter((block) => block.type === 'tool_result');
  const other = message.content.filter((block) => block.type !== 'tool_result');
  const output = [];

  for (const block of toolResults) {
    output.push({
      role: 'tool',
      tool_call_id: block.toolUseId,
      content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
    });
  }

  if (other.length === 0) return output;

  const contentParts = [];
  for (const block of other) {
    if (block.type === 'text') {
      contentParts.push({ type: 'text', text: block.text || '' });
    } else if (block.type === 'image') {
      contentParts.push(mapImageBlock(block));
    } else if (block.type === 'document') {
      throw createAdapterError({
        kind: ERROR_KINDS.UNSUPPORTED_FEATURE,
        status: 400,
        message: 'document/file blocks are not supported for OpenAI Chat Completions in this adapter version',
      });
    } else if (block.type === 'thinking') {
      // thinking in user messages is ignored for chat outbound
    } else {
      throw createAdapterError({
        kind: ERROR_KINDS.UNSUPPORTED_FEATURE,
        status: 400,
        message: `Unsupported user content block for Chat Completions: ${block.type}`,
      });
    }
  }

  if (contentParts.length === 1 && contentParts[0].type === 'text') {
    output.push({ role: 'user', content: contentParts[0].text });
  } else if (contentParts.length > 0) {
    output.push({ role: 'user', content: contentParts });
  }

  return output;
}

function convertAssistantMessage(message) {
  const textParts = [];
  const toolCalls = [];
  let reasoning = null;
  let turnHash = null;

  for (const block of message.content) {
    if (block.type === 'text') {
      textParts.push(block.text || '');
    } else if (block.type === 'thinking') {
      reasoning = block.thinking || '';
      if (block.signature) turnHash = block.signature;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id || `call_${randomUUID()}`,
        type: 'function',
        function: {
          name: block.name,
          arguments:
            typeof block.input === 'string'
              ? block.input
              : JSON.stringify(block.input ?? {}),
        },
      });
    } else {
      throw createAdapterError({
        kind: ERROR_KINDS.UNSUPPORTED_FEATURE,
        status: 400,
        message: `Unsupported assistant content block for Chat Completions: ${block.type}`,
      });
    }
  }

  const assistant = {
    role: 'assistant',
    content: textParts.join('') || null,
  };
  if (toolCalls.length) assistant.tool_calls = toolCalls;
  if (reasoning) assistant.reasoning_content = reasoning;
  if (turnHash) assistant._byokTurnHash = turnHash;
  return [assistant];
}

function mapImageBlock(block) {
  const source = block.source || {};
  if (source.type === 'url') {
    return { type: 'image_url', image_url: { url: source.url } };
  }
  if (source.type === 'base64') {
    const mediaType = source.media_type || 'image/png';
    return {
      type: 'image_url',
      image_url: { url: `data:${mediaType};base64,${source.data}` },
    };
  }
  throw createAdapterError({
    kind: ERROR_KINDS.UNSUPPORTED_FEATURE,
    status: 400,
    message: 'Unsupported image source for Chat Completions',
  });
}

function mapToolChoice(toolChoice) {
  if (!toolChoice) return undefined;
  if (toolChoice.type === 'auto') return 'auto';
  if (toolChoice.type === 'none') return 'none';
  if (toolChoice.type === 'any' || toolChoice.type === 'required') return 'required';
  if (toolChoice.type === 'tool' && toolChoice.name) {
    return { type: 'function', function: { name: toolChoice.name } };
  }
  return 'auto';
}

export function chatResponseToNormalized(chatJson, modelFallback) {
  const choice = chatJson.choices?.[0];
  if (!choice) {
    throw createAdapterError({
      kind: ERROR_KINDS.PROVIDER,
      status: 502,
      message: 'Chat Completions response missing choices',
    });
  }

  if (choice.finish_reason === 'content_filter') {
    throw createAdapterError({
      kind: ERROR_KINDS.PROVIDER,
      status: 400,
      message: 'Upstream content filter stopped the response',
    });
  }

  const message = choice.message || {};
  const contentBlocks = [];

  if (message.reasoning_content) {
    contentBlocks.push({
      type: 'thinking',
      thinking: message.reasoning_content,
      signature: null,
    });
  }

  if (typeof message.content === 'string' && message.content.length > 0) {
    contentBlocks.push({ type: 'text', text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part?.type === 'text') {
        contentBlocks.push({ type: 'text', text: part.text || '' });
      }
    }
  }

  for (const toolCall of message.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(toolCall.function?.arguments || '{}');
    } catch {
      input = { _raw: toolCall.function?.arguments || '' };
    }
    contentBlocks.push({
      type: 'tool_use',
      id: toolCall.id || `call_${randomUUID()}`,
      name: toolCall.function?.name || 'unknown',
      input,
    });
  }

  return {
    id: chatJson.id || `msg_${randomUUID()}`,
    model: chatJson.model || modelFallback,
    role: 'assistant',
    contentBlocks,
    stopReason: mapFinishReason(choice.finish_reason),
    stopSequence: null,
    usage: {
      inputTokens: chatJson.usage?.prompt_tokens ?? 0,
      outputTokens: chatJson.usage?.completion_tokens ?? 0,
      cacheReadTokens: chatJson.usage?.prompt_tokens_details?.cached_tokens ?? null,
      cacheWriteTokens: null,
    },
    providerMetadata: {
      finishReason: choice.finish_reason,
      reasoningTokens: chatJson.usage?.completion_tokens_details?.reasoning_tokens,
    },
    rawReasoningContent: message.reasoning_content || null,
  };
}

function mapFinishReason(reason) {
  if (reason === 'stop') return 'end_turn';
  if (reason === 'length') return 'max_tokens';
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'content_filter') return 'end_turn';
  return reason || 'end_turn';
}

export async function handleOpenAiChat(context) {
  const {
    config,
    normalizedRequest,
    signal,
    logger,
    fetchImpl = globalThis.fetch,
    reasoningCache,
    clientResponse,
  } = context;

  const endpoint = messagesEndpointForFormat(config.baseUrl, API_FORMATS.OPENAI_CHAT);
  const dialectCache = context.chatDialectCache || createChatDialectCache();
  const dialectKey = [
    config.baseUrlFingerprint,
    config.credentialFingerprint,
    normalizedRequest.model,
    'max_tokens',
  ].join('|');
  const maxTokensDialect =
    context._maxTokensDialect ||
    dialectCache.get(dialectKey) ||
    MAX_COMPLETION_TOKENS;

  let body = normalizedToChatRequest(normalizedRequest, { maxTokensDialect });

  if (isDeepSeekProvider(config)) {
    const thinking = applyDeepSeekThinkingNormalization(
      normalizedRequest,
      config,
      logger,
    );
    body = thinking.openaiPatch(body);
    if (reasoningCache) {
      body.messages = attachReasoningToChatMessages(body.messages, reasoningCache);
    }
  }

  // Strip internal fields before send.
  body.messages = body.messages.map((message) => {
    if (!message || typeof message !== 'object') return message;
    const { _byokTurnHash, ...rest } = message;
    return rest;
  });

  const headers = {
    authorization: `Bearer ${config.credential.value}`,
    'content-type': 'application/json',
    accept: normalizedRequest.stream ? 'text/event-stream' : 'application/json',
  };

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

  if (!response.ok) {
    const errorText = await response.text();
    if (
      !context._retriedMaxTokensDialect &&
      normalizedRequest.maxOutputTokens != null &&
      response.status === 400 &&
      isUnsupportedTokenParameter(errorText, maxTokensDialect)
    ) {
      const alternateDialect =
        maxTokensDialect === MAX_COMPLETION_TOKENS
          ? MAX_TOKENS
          : MAX_COMPLETION_TOKENS;
      return handleOpenAiChat({
        ...context,
        chatDialectCache: dialectCache,
        _retriedMaxTokensDialect: true,
        _maxTokensDialect: alternateDialect,
      });
    }
    throw errorFromHttpResponse(response, errorText);
  }

  if (normalizedRequest.maxOutputTokens != null) {
    dialectCache.set(dialectKey, maxTokensDialect);
  }

  if (normalizedRequest.stream) {
    await pipeChatStreamToAnthropic({
      upstream: response,
      clientResponse,
      model: normalizedRequest.model,
      signal,
      reasoningCache,
      deepseek: isDeepSeekProvider(config),
    });
    return { kind: 'stream-written' };
  }

  const json = await response.json();
  const normalized = chatResponseToNormalized(json, normalizedRequest.model);

  if (reasoningCache && normalized.rawReasoningContent) {
    const turnHash = assistantTurnHash(normalized);
    const toolIds = extractToolUseIds(normalized);
    const thinkingBlock = normalized.contentBlocks.find((block) => block.type === 'thinking');
    const signature = makeThinkingSignature(`${turnHash}:${toolIds.join(',')}`);
    if (thinkingBlock) thinkingBlock.signature = signature;
    storeReasoningContent(reasoningCache, {
      reasoningContent: normalized.rawReasoningContent,
      toolCallIds: toolIds,
      assistantTurnHashValue: turnHash,
      signature,
    });
  }

  return {
    kind: 'json',
    body: normalizedResponseToAnthropicMessage(normalized),
    normalized,
  };
}

async function pipeChatStreamToAnthropic(options) {
  const {
    upstream,
    clientResponse,
    model,
    signal,
    reasoningCache,
    deepseek,
  } = options;

  const writer = new AnthropicSseWriter(clientResponse, { model });
  writer.messageStart();

  let thinkingIndex = null;
  let textIndex = null;
  let nextIndex = 0;
  const toolIndexByStreamIndex = new Map();
  const toolArgsByStreamIndex = new Map();
  const toolMetaByStreamIndex = new Map();
  let finishReason = null;
  let usage = { inputTokens: 0, outputTokens: 0 };
  let reasoningText = '';
  let textText = '';
  let sawDoneMarker = false;

  try {
    for await (const event of readSseEvents(upstream.body, { signal })) {
      if (event.data === '[DONE]') {
        sawDoneMarker = true;
        break;
      }
      let chunk;
      try {
        chunk = JSON.parse(event.data);
      } catch {
        continue;
      }

      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens ?? usage.inputTokens,
          outputTokens: chunk.usage.completion_tokens ?? usage.outputTokens,
        };
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta || {};

      if (delta.reasoning_content) {
        if (thinkingIndex === null) {
          thinkingIndex = nextIndex;
          nextIndex += 1;
          writer.contentBlockStart(thinkingIndex, {
            type: 'thinking',
            thinking: '',
          });
        }
        reasoningText += delta.reasoning_content;
        writer.contentBlockDelta(thinkingIndex, {
          type: 'thinking_delta',
          thinking: delta.reasoning_content,
        });
      }

      if (typeof delta.content === 'string' && delta.content.length > 0) {
        if (textIndex === null) {
          textIndex = nextIndex;
          nextIndex += 1;
          writer.contentBlockStart(textIndex, { type: 'text', text: '' });
        }
        textText += delta.content;
        writer.contentBlockDelta(textIndex, {
          type: 'text_delta',
          text: delta.content,
        });
      }

      for (const toolDelta of delta.tool_calls || []) {
        const streamIndex = toolDelta.index ?? 0;
        if (!toolIndexByStreamIndex.has(streamIndex)) {
          const blockIndex = nextIndex;
          nextIndex += 1;
          toolIndexByStreamIndex.set(streamIndex, blockIndex);
          toolArgsByStreamIndex.set(streamIndex, '');
          const toolId = toolDelta.id || `call_${randomUUID()}`;
          const toolName = toolDelta.function?.name || 'unknown';
          toolMetaByStreamIndex.set(streamIndex, { id: toolId, name: toolName });
          writer.contentBlockStart(blockIndex, {
            type: 'tool_use',
            id: toolId,
            name: toolName,
            input: {},
          });
        }
        if (toolDelta.id || toolDelta.function?.name) {
          const meta = toolMetaByStreamIndex.get(streamIndex);
          if (toolDelta.id) meta.id = toolDelta.id;
          if (toolDelta.function?.name) meta.name = toolDelta.function.name;
        }
        if (toolDelta.function?.arguments) {
          const previous = toolArgsByStreamIndex.get(streamIndex) || '';
          toolArgsByStreamIndex.set(streamIndex, previous + toolDelta.function.arguments);
          writer.contentBlockDelta(toolIndexByStreamIndex.get(streamIndex), {
            type: 'input_json_delta',
            partial_json: toolDelta.function.arguments,
          });
        }
      }
    }

    if (thinkingIndex !== null) writer.contentBlockStop(thinkingIndex);
    if (textIndex !== null) writer.contentBlockStop(textIndex);
    for (const blockIndex of toolIndexByStreamIndex.values()) {
      writer.contentBlockStop(blockIndex);
    }

    if (!sawDoneMarker && !finishReason) {
      writer.fail({
        type: 'api_error',
        message: 'Chat Completions stream ended without a completion marker',
      });
      return;
    }

    if (deepseek && reasoningCache && reasoningText) {
      const toolIds = [...toolMetaByStreamIndex.values()].map((meta) => meta.id);
      const signature = makeThinkingSignature(`${reasoningText.slice(0, 32)}:${toolIds.join(',')}`);
      storeReasoningContent(reasoningCache, {
        reasoningContent: reasoningText,
        toolCallIds: toolIds,
        assistantTurnHashValue: signature,
        signature,
      });
    }

    if (finishReason === 'content_filter') {
      writer.fail({
        type: 'invalid_request_error',
        message: 'Upstream content filter stopped the response',
      });
      return;
    }

    writer.messageDelta(mapFinishReason(finishReason), usage);
    writer.messageStop();
    writer.end();
  } catch (error) {
    if (!writer.messageStarted) throw error;
    writer.fail({
      type: 'api_error',
      message: error.message || 'Stream failed',
    });
  }
}

function isUnsupportedTokenParameter(errorText, parameterName) {
  const text = String(errorText || '');
  if (!text.toLowerCase().includes(parameterName.toLowerCase())) return false;
  return /unknown|unsupported|unrecognized|unexpected|not\s+allowed|not\s+supported|invalid\s+parameter/i.test(text);
}
