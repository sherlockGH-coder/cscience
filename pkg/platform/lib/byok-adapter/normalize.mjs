import { createAdapterError, ERROR_KINDS } from './errors.mjs';
import { sha256Hex } from './cache.mjs';

/**
 * Convert Anthropic Messages HTTP body into NormalizedRequest.
 */
export function anthropicRequestToNormalized(body) {
  if (!body || typeof body !== 'object') {
    throw createAdapterError({
      kind: ERROR_KINDS.VALIDATION,
      status: 400,
      message: 'Request body must be a JSON object',
    });
  }

  if (!body.model || typeof body.model !== 'string') {
    throw createAdapterError({
      kind: ERROR_KINDS.VALIDATION,
      status: 400,
      message: 'model is required',
    });
  }

  const system = normalizeSystem(body.system);
  const messages = normalizeMessages(body.messages);
  const tools = normalizeTools(body.tools);
  const toolChoice = normalizeToolChoice(body.tool_choice);
  const thinking = normalizeThinking(body.thinking, body.output_config);
  const outputFormat = normalizeOutputFormat(body.output_config?.format);

  const normalized = {
    model: body.model,
    system,
    messages,
    tools,
    toolChoice,
    stream: Boolean(body.stream),
    maxOutputTokens: body.max_tokens ?? body.max_output_tokens ?? null,
    stopSequences: Array.isArray(body.stop_sequences) ? body.stop_sequences : [],
    temperature: body.temperature,
    topP: body.top_p,
    presencePenalty: body.presence_penalty,
    frequencyPenalty: body.frequency_penalty,
    metadata: body.metadata ?? null,
    outputFormat,
    thinking,
    rawAnthropic: body,
  };

  return normalized;
}

function normalizeOutputFormat(format) {
  if (format == null) return null;
  if (typeof format !== 'object' || Array.isArray(format) || !format.type) {
    throw createAdapterError({
      kind: ERROR_KINDS.VALIDATION,
      status: 400,
      message: 'output_config.format must be an object with a type',
    });
  }
  return { ...format };
}

function normalizeSystem(system) {
  if (!system) return [];
  if (typeof system === 'string') {
    return [{ type: 'text', text: system }];
  }
  if (Array.isArray(system)) {
    return system.map((block, index) => normalizeContentBlock(block, `system[${index}]`));
  }
  throw createAdapterError({
    kind: ERROR_KINDS.VALIDATION,
    status: 400,
    message: 'system must be a string or content block array',
  });
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) {
    throw createAdapterError({
      kind: ERROR_KINDS.VALIDATION,
      status: 400,
      message: 'messages must be an array',
    });
  }
  return messages.map((message, messageIndex) => {
    if (!message || typeof message !== 'object') {
      throw createAdapterError({
        kind: ERROR_KINDS.VALIDATION,
        status: 400,
        message: `messages[${messageIndex}] is invalid`,
      });
    }
    const role = message.role;
    if (role !== 'user' && role !== 'assistant') {
      throw createAdapterError({
        kind: ERROR_KINDS.VALIDATION,
        status: 400,
        message: `messages[${messageIndex}].role is unsupported`,
      });
    }
    let content = message.content;
    if (typeof content === 'string') {
      content = [{ type: 'text', text: content }];
    }
    if (!Array.isArray(content)) {
      throw createAdapterError({
        kind: ERROR_KINDS.VALIDATION,
        status: 400,
        message: `messages[${messageIndex}].content is invalid`,
      });
    }
    return {
      role,
      content: content.map((block, blockIndex) =>
        normalizeContentBlock(block, `messages[${messageIndex}].content[${blockIndex}]`),
      ),
    };
  });
}

function normalizeContentBlock(block, path) {
  if (!block || typeof block !== 'object' || typeof block.type !== 'string') {
    throw createAdapterError({
      kind: ERROR_KINDS.VALIDATION,
      status: 400,
      message: `${path} is not a valid content block`,
    });
  }

  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text ?? '', cacheControl: block.cache_control };
    case 'image':
      return {
        type: 'image',
        source: block.source,
        cacheControl: block.cache_control,
      };
    case 'document':
    case 'file':
      return {
        type: 'document',
        source: block.source,
        title: block.title,
        context: block.context,
        cacheControl: block.cache_control,
      };
    case 'thinking':
      return {
        type: 'thinking',
        thinking: block.thinking ?? '',
        signature: block.signature ?? null,
      };
    case 'redacted_thinking':
      return {
        type: 'thinking',
        thinking: '',
        signature: block.data ?? block.signature ?? null,
        redacted: true,
      };
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input ?? {},
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        toolUseId: block.tool_use_id,
        content: normalizeToolResultContent(block.content),
        isError: Boolean(block.is_error),
      };
    default:
      throw createAdapterError({
        kind: ERROR_KINDS.UNSUPPORTED_FEATURE,
        status: 400,
        message: `Unsupported content block type: ${block.type}`,
      });
  }
}

function normalizeToolResultContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return part.text || '';
        return JSON.stringify(part);
      })
      .join('\n');
  }
  return String(content);
}

function normalizeTools(tools) {
  if (!tools) return [];
  if (!Array.isArray(tools)) {
    throw createAdapterError({
      kind: ERROR_KINDS.VALIDATION,
      status: 400,
      message: 'tools must be an array',
    });
  }
  return tools.map((tool, index) => {
    if (!tool?.name) {
      throw createAdapterError({
        kind: ERROR_KINDS.VALIDATION,
        status: 400,
        message: `tools[${index}].name is required`,
      });
    }
    return {
      name: tool.name,
      description: tool.description || '',
      inputSchema: tool.input_schema || tool.parameters || {},
      strict: tool.strict === true,
    };
  });
}

function normalizeToolChoice(toolChoice) {
  if (!toolChoice) return null;
  if (typeof toolChoice === 'string') {
    return { type: toolChoice };
  }
  if (toolChoice.type === 'tool' || toolChoice.type === 'function') {
    return {
      type: 'tool',
      name: toolChoice.name || toolChoice.function?.name,
    };
  }
  return { type: toolChoice.type || 'auto' };
}

function normalizeThinking(thinking, outputConfig) {
  const result = {
    enabled: false,
    effort: null,
    budgetTokens: null,
  };

  if (thinking && typeof thinking === 'object') {
    if (thinking.type === 'disabled') {
      result.enabled = false;
      return result;
    }
    if (thinking.type === 'enabled' || thinking.budget_tokens != null) {
      result.enabled = true;
    }
    if (thinking.budget_tokens != null) {
      result.budgetTokens = thinking.budget_tokens;
    }
    if (thinking.effort) result.effort = thinking.effort;
  }

  if (outputConfig?.effort) {
    result.enabled = true;
    result.effort = outputConfig.effort;
  }

  return result;
}

export function anthropicMessageToNormalizedResponse(body) {
  return {
    id: body.id,
    model: body.model,
    role: body.role || 'assistant',
    contentBlocks: (body.content || []).map((block) => {
      if (block.type === 'text') return { type: 'text', text: block.text || '' };
      if (block.type === 'thinking') {
        return {
          type: 'thinking',
          thinking: block.thinking || '',
          signature: block.signature || null,
        };
      }
      if (block.type === 'tool_use') {
        return {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input ?? {},
        };
      }
      return { type: block.type, ...block };
    }),
    stopReason: body.stop_reason ?? null,
    stopSequence: body.stop_sequence ?? null,
    usage: {
      inputTokens: body.usage?.input_tokens ?? 0,
      outputTokens: body.usage?.output_tokens ?? 0,
      cacheReadTokens: body.usage?.cache_read_input_tokens ?? null,
      cacheWriteTokens: body.usage?.cache_creation_input_tokens ?? null,
    },
    providerMetadata: {},
  };
}

export function assistantTurnHash(normalizedResponse) {
  const material = JSON.stringify({
    content: normalizedResponse.contentBlocks,
    model: normalizedResponse.model,
    stop: normalizedResponse.stopReason,
  });
  return sha256Hex(material);
}

export function extractToolUseIds(normalizedResponse) {
  return (normalizedResponse.contentBlocks || [])
    .filter((block) => block.type === 'tool_use' && block.id)
    .map((block) => block.id);
}
