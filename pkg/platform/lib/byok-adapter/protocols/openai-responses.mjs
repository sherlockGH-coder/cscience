import { randomUUID } from 'node:crypto';
import { API_FORMATS } from '../config.mjs';
import { messagesEndpointForFormat } from '../detect.mjs';
import {
  applyDeepSeekThinkingNormalization,
  isDeepSeekProvider,
  makeThinkingSignature,
  storeReasoningContent,
} from '../providers/deepseek.mjs';
import {
  assistantTurnHash,
  extractToolUseIds,
} from '../normalize.mjs';
import { TtlLruCache, sha256Hex } from '../cache.mjs';
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

const RESPONSE_ITEM_TTL_MS = 2 * 60 * 60 * 1000;
const RESPONSE_ITEM_MAX = 200;

export function createResponseItemCache() {
  return new TtlLruCache({
    maxEntries: RESPONSE_ITEM_MAX,
    defaultTtlMs: RESPONSE_ITEM_TTL_MS,
  });
}

export function normalizedToResponsesRequest(normalizedRequest, itemCache) {
  const input = [];
  let instructions = null;

  if (normalizedRequest.system?.length) {
    const allText = normalizedRequest.system.every((block) => block.type === 'text');
    if (allText) {
      instructions = normalizedRequest.system.map((block) => block.text).join('\n');
    } else {
      for (const block of normalizedRequest.system) {
        input.push(...contentBlockToInputItems(block, 'system'));
      }
    }
  }

  for (const message of normalizedRequest.messages) {
    if (message.role === 'user') {
      const toolResults = message.content.filter((block) => block.type === 'tool_result');
      const others = message.content.filter((block) => block.type !== 'tool_result');
      for (const block of toolResults) {
        input.push({
          type: 'function_call_output',
          call_id: block.toolUseId,
          output:
            typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content),
        });
      }
      if (others.length > 0) {
        const content = [];
        for (const block of others) {
          content.push(...contentBlockToInputContent(block));
        }
        input.push({
          type: 'message',
          role: 'user',
          content,
        });
      }
      continue;
    }

    if (message.role === 'assistant') {
      const restored = tryRestoreAssistantItems(message, itemCache);
      if (restored) {
        input.push(...restored);
        continue;
      }
      for (const block of message.content) {
        if (block.type === 'text') {
          input.push({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: block.text || '' }],
          });
        } else if (block.type === 'thinking') {
          input.push({
            type: 'reasoning',
            summary: [{ type: 'summary_text', text: block.thinking || '' }],
          });
        } else if (block.type === 'tool_use') {
          input.push({
            type: 'function_call',
            call_id: block.id,
            name: block.name,
            arguments:
              typeof block.input === 'string'
                ? block.input
                : JSON.stringify(block.input ?? {}),
          });
        } else {
          throw createAdapterError({
            kind: ERROR_KINDS.UNSUPPORTED_FEATURE,
            status: 400,
            message: `Cannot rebuild Responses item for block type: ${block.type}`,
          });
        }
      }
    }
  }

  const body = {
    model: normalizedRequest.model,
    input,
    store: false,
    stream: Boolean(normalizedRequest.stream),
  };
  if (instructions) body.instructions = instructions;

  if (normalizedRequest.tools?.length) {
    body.tools = normalizedRequest.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema || {},
      ...(tool.strict ? { strict: true } : {}),
    }));
  }

  if (normalizedRequest.toolChoice) {
    body.tool_choice = mapResponsesToolChoice(normalizedRequest.toolChoice);
  }

  if (normalizedRequest.maxOutputTokens != null) {
    body.max_output_tokens = normalizedRequest.maxOutputTokens;
  }
  if (normalizedRequest.temperature !== undefined) {
    body.temperature = normalizedRequest.temperature;
  }
  if (normalizedRequest.topP !== undefined) {
    body.top_p = normalizedRequest.topP;
  }
  if (normalizedRequest.metadata != null) {
    body.metadata = normalizedRequest.metadata;
  }
  if (normalizedRequest.outputFormat) {
    body.text = {
      format: mapResponsesOutputFormat(normalizedRequest.outputFormat),
    };
  }

  return body;
}

function mapResponsesOutputFormat(format) {
  if (format.type === 'json_schema') {
    if (!format.schema || typeof format.schema !== 'object') {
      throw createAdapterError({
        kind: ERROR_KINDS.VALIDATION,
        status: 400,
        message: 'json_schema output format requires schema',
      });
    }
    return {
      ...format,
      name: format.name || 'structured_output',
    };
  }
  if (format.type === 'json_object' || format.type === 'text') {
    return { ...format };
  }
  throw createAdapterError({
    kind: ERROR_KINDS.UNSUPPORTED_FEATURE,
    status: 400,
    message: `Unsupported Responses output format: ${format.type}`,
  });
}

function contentBlockToInputContent(block) {
  if (block.type === 'text') {
    return [{ type: 'input_text', text: block.text || '' }];
  }
  if (block.type === 'image') {
    const source = block.source || {};
    if (source.type === 'url') {
      return [{ type: 'input_image', image_url: source.url }];
    }
    if (source.type === 'base64') {
      const mediaType = source.media_type || 'image/png';
      return [
        {
          type: 'input_image',
          image_url: `data:${mediaType};base64,${source.data}`,
        },
      ];
    }
  }
  if (block.type === 'document') {
    throw createAdapterError({
      kind: ERROR_KINDS.UNSUPPORTED_FEATURE,
      status: 400,
      message: 'document/file input requires provider-specific Responses file support',
    });
  }
  throw createAdapterError({
    kind: ERROR_KINDS.UNSUPPORTED_FEATURE,
    status: 400,
    message: `Unsupported input content block: ${block.type}`,
  });
}

function contentBlockToInputItems(block, role) {
  if (block.type === 'text') {
    return [
      {
        type: 'message',
        role,
        content: [{ type: 'input_text', text: block.text || '' }],
      },
    ];
  }
  throw createAdapterError({
    kind: ERROR_KINDS.UNSUPPORTED_FEATURE,
    status: 400,
    message: `Unsupported structured system block: ${block.type}`,
  });
}

function tryRestoreAssistantItems(message, itemCache) {
  if (!itemCache) return null;
  const toolIds = message.content
    .filter((block) => block.type === 'tool_use')
    .map((block) => block.id)
    .filter(Boolean);
  for (const toolId of toolIds) {
    const cached = itemCache.get(`tool:${toolId}`);
    if (cached?.items) return cached.items;
  }
  const thinking = message.content.find((block) => block.type === 'thinking' && block.signature);
  if (thinking?.signature) {
    const cached = itemCache.get(`sig:${thinking.signature}`);
    if (cached?.items) return cached.items;
  }
  return null;
}

function mapResponsesToolChoice(toolChoice) {
  if (!toolChoice) return undefined;
  if (toolChoice.type === 'auto') return 'auto';
  if (toolChoice.type === 'none') return 'none';
  if (toolChoice.type === 'any' || toolChoice.type === 'required') return 'required';
  if (toolChoice.type === 'tool' && toolChoice.name) {
    return { type: 'function', name: toolChoice.name };
  }
  return 'auto';
}

export function responsesToNormalized(responseJson, modelFallback) {
  if (responseJson.status === 'failed' || responseJson.error) {
    throw createAdapterError({
      kind: ERROR_KINDS.PROVIDER,
      status: 502,
      message:
        responseJson.error?.message ||
        responseJson.incomplete_details?.reason ||
        'Responses API failed',
    });
  }

  const contentBlocks = [];
  const rawItems = [];
  let stopReason = 'end_turn';

  for (const item of responseJson.output || []) {
    rawItems.push(item);
    if (item.type === 'message') {
      for (const part of item.content || []) {
        if (part.type === 'output_text' || part.type === 'text') {
          contentBlocks.push({ type: 'text', text: part.text || '' });
        } else if (part.type === 'refusal') {
          contentBlocks.push({ type: 'text', text: part.refusal || part.text || '' });
          stopReason = 'end_turn';
        }
      }
    } else if (item.type === 'reasoning') {
      const texts = [];
      for (const summary of item.summary || []) {
        if (summary.text) texts.push(summary.text);
      }
      for (const part of item.content || []) {
        if (part.text) texts.push(part.text);
      }
      contentBlocks.push({
        type: 'thinking',
        thinking: texts.join('\n'),
        signature: null,
      });
    } else if (item.type === 'function_call') {
      let input = {};
      try {
        input = JSON.parse(item.arguments || '{}');
      } catch {
        input = { _raw: item.arguments || '' };
      }
      contentBlocks.push({
        type: 'tool_use',
        id: item.call_id || item.id || `call_${randomUUID()}`,
        name: item.name || 'unknown',
        input,
      });
      stopReason = 'tool_use';
    }
  }

  if (responseJson.status === 'incomplete') {
    stopReason =
      responseJson.incomplete_details?.reason === 'max_output_tokens'
        ? 'max_tokens'
        : 'end_turn';
  }

  return {
    id: responseJson.id || `msg_${randomUUID()}`,
    model: responseJson.model || modelFallback,
    role: 'assistant',
    contentBlocks,
    stopReason,
    stopSequence: null,
    usage: {
      inputTokens: responseJson.usage?.input_tokens ?? 0,
      outputTokens: responseJson.usage?.output_tokens ?? 0,
      cacheReadTokens: responseJson.usage?.input_tokens_details?.cached_tokens ?? null,
      cacheWriteTokens: null,
    },
    providerMetadata: {
      status: responseJson.status,
      incompleteDetails: responseJson.incomplete_details || null,
    },
    rawItems,
  };
}

function cacheResponseItems(itemCache, normalized) {
  if (!itemCache || !normalized.rawItems?.length) return;
  const toolIds = extractToolUseIds(normalized);
  const turnHash = assistantTurnHash(normalized);
  const signature = makeThinkingSignature(turnHash);
  const thinking = normalized.contentBlocks.find((block) => block.type === 'thinking');
  if (thinking) thinking.signature = thinking.signature || signature;

  const record = {
    items: normalized.rawItems,
    turnHash,
    signature: thinking?.signature || signature,
  };
  itemCache.set(`turn:${turnHash}`, record);
  itemCache.set(`sig:${record.signature}`, record);
  for (const toolId of toolIds) {
    itemCache.set(`tool:${toolId}`, record);
  }
}

export async function handleOpenAiResponses(context) {
  const {
    config,
    normalizedRequest,
    signal,
    logger,
    fetchImpl = globalThis.fetch,
    reasoningCache,
    responseItemCache,
    clientResponse,
  } = context;

  const unsupportedControls = listUnsupportedResponsesControls(normalizedRequest);
  if (unsupportedControls.length > 0) {
    throw createAdapterError({
      kind: ERROR_KINDS.UNSUPPORTED_FEATURE,
      status: 400,
      message:
        `OpenAI Responses does not support Anthropic control(s): ${unsupportedControls.join(', ')}`,
      allowProtocolFallback: true,
    });
  }

  const endpoint = messagesEndpointForFormat(
    config.baseUrl,
    API_FORMATS.OPENAI_RESPONSES,
  );

  let body = normalizedToResponsesRequest(normalizedRequest, responseItemCache);

  if (isDeepSeekProvider(config)) {
    const thinking = applyDeepSeekThinkingNormalization(
      normalizedRequest,
      config,
      logger,
    );
    // Responses API uses reasoning config rather than DeepSeek chat fields.
    if (thinking.enabled) {
      delete body.temperature;
      delete body.top_p;
      body.reasoning = { effort: thinking.effort || 'high' };
    }
  }

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
    throw errorFromHttpResponse(response, errorText);
  }

  if (normalizedRequest.stream) {
    await pipeResponsesStreamToAnthropic({
      upstream: response,
      clientResponse,
      model: normalizedRequest.model,
      signal,
      responseItemCache,
      reasoningCache,
    });
    return { kind: 'stream-written' };
  }

  const json = await response.json();
  const normalized = responsesToNormalized(json, normalizedRequest.model);
  cacheResponseItems(responseItemCache, normalized);

  if (reasoningCache) {
    const thinking = normalized.contentBlocks.find((block) => block.type === 'thinking');
    if (thinking?.thinking) {
      storeReasoningContent(reasoningCache, {
        reasoningContent: thinking.thinking,
        toolCallIds: extractToolUseIds(normalized),
        assistantTurnHashValue: assistantTurnHash(normalized),
        signature: thinking.signature,
      });
    }
  }

  return {
    kind: 'json',
    body: normalizedResponseToAnthropicMessage(normalized),
    normalized,
  };
}

async function pipeResponsesStreamToAnthropic(options) {
  const {
    upstream,
    clientResponse,
    model,
    signal,
    responseItemCache,
    reasoningCache,
  } = options;

  const writer = new AnthropicSseWriter(clientResponse, { model });
  writer.messageStart();

  let nextIndex = 0;
  const textIndexByItem = new Map();
  const thinkingIndexByItem = new Map();
  const toolIndexByItem = new Map();
  const toolMeta = new Map();
  const collectedItems = [];
  const collectedItemIndex = new Map();
  let usage = { inputTokens: 0, outputTokens: 0 };
  let stopReason = 'end_turn';
  let reasoningText = '';

  try {
    for await (const event of readSseEvents(upstream.body, { signal })) {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        continue;
      }
      const type = payload.type || event.event;

      if (type === 'response.created' || type === 'response.in_progress') {
        continue;
      }

      if (type === 'response.output_item.added') {
        const item = payload.item;
        if (!item) continue;
        const itemKey = item.id || item.call_id || `item:${collectedItems.length}`;
        collectedItemIndex.set(itemKey, collectedItems.length);
        collectedItems.push(item);
        if (item.type === 'message') {
          const blockIndex = nextIndex++;
          textIndexByItem.set(item.id || collectedItems.length - 1, blockIndex);
          writer.contentBlockStart(blockIndex, { type: 'text', text: '' });
        } else if (item.type === 'reasoning') {
          const blockIndex = nextIndex++;
          thinkingIndexByItem.set(item.id || collectedItems.length - 1, blockIndex);
          writer.contentBlockStart(blockIndex, { type: 'thinking', thinking: '' });
        } else if (item.type === 'function_call') {
          const blockIndex = nextIndex++;
          const key = item.id || item.call_id || collectedItems.length - 1;
          toolIndexByItem.set(key, blockIndex);
          toolMeta.set(key, {
            id: item.call_id || item.id || `call_${randomUUID()}`,
            name: item.name || 'unknown',
          });
          writer.contentBlockStart(blockIndex, {
            type: 'tool_use',
            id: toolMeta.get(key).id,
            name: toolMeta.get(key).name,
            input: {},
          });
          stopReason = 'tool_use';
        }
        continue;
      }

      if (
        type === 'response.output_text.delta' ||
        type === 'response.content_part.delta'
      ) {
        const itemId = payload.item_id;
        let blockIndex = textIndexByItem.get(itemId);
        if (blockIndex === undefined) {
          blockIndex = nextIndex++;
          textIndexByItem.set(itemId, blockIndex);
          writer.contentBlockStart(blockIndex, { type: 'text', text: '' });
        }
        const deltaText = payload.delta || payload.text || '';
        if (deltaText) {
          writer.contentBlockDelta(blockIndex, {
            type: 'text_delta',
            text: deltaText,
          });
        }
        continue;
      }

      if (
        type === 'response.reasoning_summary_text.delta' ||
        type === 'response.reasoning.delta'
      ) {
        const itemId = payload.item_id || 'reasoning';
        let blockIndex = thinkingIndexByItem.get(itemId);
        if (blockIndex === undefined) {
          blockIndex = nextIndex++;
          thinkingIndexByItem.set(itemId, blockIndex);
          writer.contentBlockStart(blockIndex, { type: 'thinking', thinking: '' });
        }
        const deltaText = payload.delta || payload.text || '';
        if (deltaText) {
          reasoningText += deltaText;
          writer.contentBlockDelta(blockIndex, {
            type: 'thinking_delta',
            thinking: deltaText,
          });
        }
        continue;
      }

      if (type === 'response.function_call_arguments.delta') {
        const itemId = payload.item_id;
        let blockIndex = toolIndexByItem.get(itemId);
        if (blockIndex === undefined) {
          blockIndex = nextIndex++;
          toolIndexByItem.set(itemId, blockIndex);
          const meta = {
            id: payload.call_id || `call_${randomUUID()}`,
            name: 'unknown',
          };
          toolMeta.set(itemId, meta);
          writer.contentBlockStart(blockIndex, {
            type: 'tool_use',
            id: meta.id,
            name: meta.name,
            input: {},
          });
          stopReason = 'tool_use';
        }
        const argsDelta = payload.delta || '';
        if (argsDelta) {
          writer.contentBlockDelta(blockIndex, {
            type: 'input_json_delta',
            partial_json: argsDelta,
          });
        }
        continue;
      }

      if (type === 'response.output_item.done') {
        const item = payload.item;
        if (!item) continue;
        const key = item.id || item.call_id;
        const collectedIndex = key == null ? undefined : collectedItemIndex.get(key);
        if (collectedIndex === undefined) {
          const fallbackKey = key || `item:${collectedItems.length}`;
          collectedItemIndex.set(fallbackKey, collectedItems.length);
          collectedItems.push(item);
        } else {
          collectedItems[collectedIndex] = item;
        }
        if (item.type === 'message') {
          const blockIndex = textIndexByItem.get(key);
          if (blockIndex !== undefined) writer.contentBlockStop(blockIndex);
        } else if (item.type === 'reasoning') {
          const blockIndex = thinkingIndexByItem.get(key);
          if (blockIndex !== undefined) writer.contentBlockStop(blockIndex);
        } else if (item.type === 'function_call') {
          const blockIndex = toolIndexByItem.get(key);
          if (blockIndex !== undefined) writer.contentBlockStop(blockIndex);
        }
        continue;
      }

      if (type === 'response.completed') {
        if (payload.response?.usage) {
          usage = {
            inputTokens: payload.response.usage.input_tokens ?? 0,
            outputTokens: payload.response.usage.output_tokens ?? 0,
          };
        }
        const finalItems =
          Array.isArray(payload.response?.output) && payload.response.output.length
            ? payload.response.output
            : collectedItems;
        if (responseItemCache && finalItems.length) {
          // Seed tool indexes for later turns.
          for (const item of finalItems) {
            if (item.type === 'function_call' && item.call_id) {
              responseItemCache.set(`tool:${item.call_id}`, {
                items: finalItems,
              });
            }
          }
        }
        if (reasoningCache && reasoningText) {
          const toolIds = [...toolMeta.values()].map((meta) => meta.id);
          storeReasoningContent(reasoningCache, {
            reasoningContent: reasoningText,
            toolCallIds: toolIds,
            assistantTurnHashValue: sha256Hex(reasoningText).slice(0, 16),
            signature: makeThinkingSignature(reasoningText),
          });
        }
        writer.messageDelta(stopReason, usage);
        writer.messageStop();
        writer.end();
        return;
      }

      if (type === 'response.incomplete') {
        const reason = payload.response?.incomplete_details?.reason;
        if (payload.response?.usage) {
          usage = {
            inputTokens: payload.response.usage.input_tokens ?? 0,
            outputTokens: payload.response.usage.output_tokens ?? 0,
          };
        }
        if (reason === 'max_output_tokens') {
          writer.messageDelta('max_tokens', usage);
          writer.messageStop();
          writer.end();
          return;
        }
        writer.fail({
          type: 'api_error',
          message: reason
            ? `Responses stream incomplete: ${reason}`
            : 'Responses stream incomplete',
        });
        return;
      }

      if (
        type === 'response.failed' ||
        type === 'response.error' ||
        type === 'error'
      ) {
        const message =
          payload.response?.error?.message ||
          payload.error?.message ||
          payload.message ||
          'Responses stream failed';
        writer.fail({ type: 'api_error', message });
        return;
      }
    }

    writer.fail({
      type: 'api_error',
      message: 'Responses stream ended without a terminal event',
    });
  } catch (error) {
    writer.fail({
      type: 'api_error',
      message: error.message || 'Responses stream failed',
    });
  }
}

function listUnsupportedResponsesControls(normalizedRequest) {
  const controls = [];
  if (normalizedRequest.stopSequences?.length) controls.push('stop_sequences');
  if (normalizedRequest.presencePenalty != null) controls.push('presence_penalty');
  if (normalizedRequest.frequencyPenalty != null) controls.push('frequency_penalty');
  return controls;
}
