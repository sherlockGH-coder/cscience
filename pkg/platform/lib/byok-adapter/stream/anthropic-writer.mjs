import { randomUUID } from 'node:crypto';

export class AnthropicSseWriter {
  constructor(response, options = {}) {
    this.response = response;
    this.headersSent = false;
    this.closed = false;
    this.openBlocks = new Set();
    this.messageStarted = false;
    this.messageStopped = false;
    this.messageId = options.messageId || `msg_${randomUUID()}`;
    this.model = options.model || 'unknown';
  }

  begin(headers = {}) {
    if (this.headersSent) return;
    this.response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      ...headers,
    });
    this.headersSent = true;
  }

  writeEvent(eventType, data) {
    if (this.closed) return;
    this.begin();
    const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    this.response.write(payload);
  }

  messageStart(usage = {}) {
    if (this.messageStarted) return;
    this.messageStarted = true;
    this.writeEvent('message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: this.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: usage.inputTokens ?? 0,
          output_tokens: usage.outputTokens ?? 0,
        },
      },
    });
  }

  contentBlockStart(index, block) {
    if (this.openBlocks.has(index)) {
      throw new Error(`content block ${index} already started`);
    }
    this.openBlocks.add(index);
    this.writeEvent('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: block,
    });
  }

  contentBlockDelta(index, delta) {
    if (!this.openBlocks.has(index)) {
      throw new Error(`content block ${index} is not open`);
    }
    this.writeEvent('content_block_delta', {
      type: 'content_block_delta',
      index,
      delta,
    });
  }

  contentBlockStop(index) {
    if (!this.openBlocks.has(index)) return;
    this.openBlocks.delete(index);
    this.writeEvent('content_block_stop', {
      type: 'content_block_stop',
      index,
    });
  }

  messageDelta(stopReason, usage = {}, stopSequence = null) {
    for (const index of [...this.openBlocks].sort((a, b) => a - b)) {
      this.contentBlockStop(index);
    }
    this.writeEvent('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: stopReason,
        stop_sequence: stopSequence,
      },
      usage: {
        output_tokens: usage.outputTokens ?? 0,
      },
    });
  }

  messageStop() {
    if (this.messageStopped) return;
    for (const index of [...this.openBlocks].sort((a, b) => a - b)) {
      this.contentBlockStop(index);
    }
    this.messageStopped = true;
    this.writeEvent('message_stop', { type: 'message_stop' });
  }

  error(errorBody) {
    this.begin();
    this.writeEvent('error', {
      type: 'error',
      error: errorBody?.error || errorBody,
    });
  }

  fail(errorBody) {
    if (this.closed) return;
    for (const index of [...this.openBlocks].sort((a, b) => a - b)) {
      this.contentBlockStop(index);
    }
    this.error(errorBody);
    this.closed = true;
    try {
      this.response.end();
    } catch {
      // ignore
    }
  }

  end() {
    if (this.closed) return;
    if (this.messageStarted && !this.messageStopped) {
      this.messageStop();
    }
    this.closed = true;
    try {
      this.response.end();
    } catch {
      // ignore
    }
  }
}

export function writeAnthropicJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    'content-type': 'application/json',
    ...headers,
  });
  response.end(JSON.stringify(body));
}

export function normalizedResponseToAnthropicMessage(normalized) {
  return {
    id: normalized.id,
    type: 'message',
    role: normalized.role || 'assistant',
    content: (normalized.contentBlocks || []).map(contentBlockToAnthropic),
    model: normalized.model,
    stop_reason: normalized.stopReason ?? null,
    stop_sequence: normalized.stopSequence ?? null,
    usage: {
      input_tokens: normalized.usage?.inputTokens ?? 0,
      output_tokens: normalized.usage?.outputTokens ?? 0,
      ...(normalized.usage?.cacheReadTokens != null
        ? { cache_read_input_tokens: normalized.usage.cacheReadTokens }
        : {}),
      ...(normalized.usage?.cacheWriteTokens != null
        ? { cache_creation_input_tokens: normalized.usage.cacheWriteTokens }
        : {}),
    },
  };
}

function contentBlockToAnthropic(block) {
  if (block.type === 'text') {
    return { type: 'text', text: block.text || '' };
  }
  if (block.type === 'thinking') {
    const output = { type: 'thinking', thinking: block.thinking || '' };
    if (block.signature) output.signature = block.signature;
    return output;
  }
  if (block.type === 'tool_use') {
    return {
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: block.input ?? {},
    };
  }
  return block;
}
