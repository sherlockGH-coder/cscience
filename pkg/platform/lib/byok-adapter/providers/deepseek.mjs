import { PROVIDER_KINDS } from '../config.mjs';
import { TtlLruCache, sha256Hex } from '../cache.mjs';
import { createAdapterError, ERROR_KINDS } from '../errors.mjs';

const REASONING_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const REASONING_CACHE_MAX = 200;

export function createReasoningCache() {
  return new TtlLruCache({
    maxEntries: REASONING_CACHE_MAX,
    defaultTtlMs: REASONING_CACHE_TTL_MS,
  });
}

export function isDeepSeekProvider(config, hints = {}) {
  if (config.byok.provider === PROVIDER_KINDS.DEEPSEEK) return true;
  if (config.byok.provider === PROVIDER_KINDS.GENERIC) return false;

  const hostname = config.baseUrl?.hostname || '';
  if (
    hostname === 'api.deepseek.com' ||
    hostname.endsWith('.deepseek.com')
  ) {
    return true;
  }

  if (hints.providerName && /deepseek/i.test(hints.providerName)) return true;
  if (hints.responseHeaders) {
    const server = hints.responseHeaders.get?.('server') || '';
    if (/deepseek/i.test(server)) return true;
  }
  return false;
}

export function applyDeepSeekThinkingNormalization(normalizedRequest, config, logger) {
  const thinking = normalizedRequest.thinking || { enabled: false };
  let enabled = Boolean(thinking.enabled);
  if (thinking.budgetTokens != null) enabled = true;

  const removedFields = [];
  let effort = null;

  if (!enabled) {
    return {
      enabled: false,
      effort: null,
      removedFields,
      anthropicPatch(body) {
        const next = { ...body };
        delete next.thinking;
        if (next.output_config) {
          const outputConfig = { ...next.output_config };
          delete outputConfig.effort;
          if (Object.keys(outputConfig).length === 0) delete next.output_config;
          else next.output_config = outputConfig;
        }
        next.thinking = { type: 'disabled' };
        return next;
      },
      openaiPatch(body) {
        const next = { ...body };
        delete next.reasoning_effort;
        next.thinking = { type: 'disabled' };
        return next;
      },
    };
  }

  effort =
    (thinking.effort === 'high' || thinking.effort === 'max' ? thinking.effort : null) ||
    config.byok.reasoningEffort ||
    'high';

  for (const fieldName of [
    'temperature',
    'top_p',
    'presence_penalty',
    'frequency_penalty',
  ]) {
    removedFields.push(fieldName);
  }

  logger?.debug?.(
    `deepseek thinking: enabled, effort=${effort}, removed=${removedFields.join(',')}`,
  );

  return {
    enabled: true,
    effort,
    removedFields,
    anthropicPatch(body) {
      const next = { ...body };
      delete next.thinking;
      delete next.temperature;
      delete next.top_p;
      delete next.presence_penalty;
      delete next.frequency_penalty;
      next.thinking = { type: 'enabled' };
      next.output_config = {
        ...(next.output_config || {}),
        effort,
      };
      return next;
    },
    openaiPatch(body) {
      const next = { ...body };
      delete next.temperature;
      delete next.top_p;
      delete next.presence_penalty;
      delete next.frequency_penalty;
      next.thinking = { type: 'enabled' };
      next.reasoning_effort = effort;
      return next;
    },
  };
}

export function storeReasoningContent(cache, options) {
  const {
    reasoningContent,
    toolCallIds = [],
    assistantTurnHashValue,
    signature,
  } = options;
  if (!reasoningContent) return null;

  const record = {
    reasoningContent,
    toolCallIds: [...toolCallIds],
    assistantTurnHash: assistantTurnHashValue || null,
    storedAt: Date.now(),
  };

  if (assistantTurnHashValue) {
    cache.set(`turn:${assistantTurnHashValue}`, record);
  }
  if (signature) {
    cache.set(`sig:${signature}`, record);
  }
  for (const toolCallId of toolCallIds) {
    cache.set(`tool:${toolCallId}`, record);
  }
  return record;
}

export function lookupReasoningContent(cache, options = {}) {
  if (options.signature) {
    const bySignature = cache.get(`sig:${options.signature}`);
    if (bySignature) return bySignature;
  }
  if (options.toolCallId) {
    const byTool = cache.get(`tool:${options.toolCallId}`);
    if (byTool) return byTool;
  }
  if (options.assistantTurnHashValue) {
    const byTurn = cache.get(`turn:${options.assistantTurnHashValue}`);
    if (byTurn) return byTurn;
  }
  return null;
}

export function attachReasoningToChatMessages(messages, reasoningCache) {
  return messages.map((message) => {
    if (message.role !== 'assistant') return message;
    const toolCalls = message.tool_calls || [];
    if (toolCalls.length === 0) return message;
    if (message.reasoning_content) return message;

    let record = null;
    for (const toolCall of toolCalls) {
      record = lookupReasoningContent(reasoningCache, { toolCallId: toolCall.id });
      if (record) break;
    }
    if (!record && message._byokTurnHash) {
      record = lookupReasoningContent(reasoningCache, {
        assistantTurnHashValue: message._byokTurnHash,
      });
    }
    if (!record) {
      throw createAdapterError({
        kind: ERROR_KINDS.VALIDATION,
        status: 400,
        message:
          'Missing DeepSeek reasoning_content for an assistant tool-call turn. Cannot safely continue the tool loop.',
      });
    }
    return {
      ...message,
      reasoning_content: record.reasoningContent,
    };
  });
}

export function makeThinkingSignature(seed) {
  return `byok_ds_${sha256Hex(seed).slice(0, 24)}`;
}
