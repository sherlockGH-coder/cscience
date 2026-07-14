import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createMockProvider } from '../helpers/mock-provider.mjs';
import { buildAdapterConfig } from '../../pkg/platform/lib/byok-adapter/config.mjs';
import { createAdapterServer } from '../../pkg/platform/lib/byok-adapter/server.mjs';
import { createLogger } from '../../pkg/platform/lib/byok-adapter/log.mjs';
import { responsesToNormalized } from '../../pkg/platform/lib/byok-adapter/protocols/openai-responses.mjs';

const LOCAL_TOKEN = `local-token-${'a'.repeat(40)}`;

describe('OpenAI Responses item normalization', () => {
  it('keeps each opaque output item exactly once for later replay', () => {
    const opaque = { id: 'search_1', type: 'web_search_call', status: 'completed' };
    const normalized = responsesToNormalized({
      id: 'resp_opaque',
      status: 'completed',
      output: [opaque],
    }, 'responses-model');

    assert.deepEqual(normalized.rawItems, [opaque]);
  });
});

describe('adapter server integration', () => {
  let mock;
  let mockInfo;
  let adapter;
  let adapterInfo;

  before(async () => {
    mock = createMockProvider();
    mock.setHandler('GET /v1/models', {
      status: 200,
      body: {
        data: [
          { id: 'model-a', name: 'Model A' },
          { id: 'model-b', name: 'Model B' },
        ],
      },
    });
    mock.setHandler('POST /v1/chat/completions', ({ body }) => {
      if (body.stream) {
        if (body.model === 'truncated-chat-model') {
          return {
            sse: [
              {
                data: {
                  id: 'chatcmpl_truncated',
                  choices: [
                    {
                      index: 0,
                      delta: { role: 'assistant', content: 'partial' },
                    },
                  ],
                },
              },
            ],
          };
        }
        return {
          sse: [
            {
              data: {
                id: 'chatcmpl_1',
                choices: [
                  {
                    index: 0,
                    delta: { role: 'assistant', content: 'hel' },
                  },
                ],
              },
            },
            {
              data: {
                id: 'chatcmpl_1',
                choices: [
                  {
                    index: 0,
                    delta: { content: 'lo' },
                    finish_reason: 'stop',
                  },
                ],
              },
            },
            {
              data: {
                id: 'chatcmpl_1',
                choices: [],
                usage: { prompt_tokens: 2, completion_tokens: 2 },
              },
            },
            { data: '[DONE]' },
          ],
        };
      }
      return {
        status: 200,
        body: {
          id: 'chatcmpl_1',
          model: body.model,
          choices: [
            {
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'hello from chat' },
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 4 },
        },
      };
    });
    mock.setHandler('POST /anthropic/v1/messages', {
      status: 404,
      body: { error: { message: 'not found' } },
    });
    mock.setHandler('POST /v1/messages', {
      status: 404,
      body: { error: { message: 'not found' } },
    });
    mock.setHandler('POST /v1/responses', {
      status: 404,
      body: { error: { message: 'not found' } },
    });

    mockInfo = await mock.start();

    const config = buildAdapterConfig({
      ANTHROPIC_API_KEY: 'sk-test-provider-key',
      ANTHROPIC_BASE_URL: `${mockInfo.baseUrl}/anthropic`,
      BYOK_LOCAL_TOKEN: LOCAL_TOKEN,
      BYOK_API_FORMAT: 'openai-chat',
      BYOK_DEBUG: '0',
    });

    adapter = createAdapterServer(config, {
      logger: createLogger({ debug: false }),
    });
    adapterInfo = await adapter.listen(0, '127.0.0.1');
  });

  after(async () => {
    await adapter.shutdown(1000);
    await mock.stop();
  });

  it('rejects missing local token', async () => {
    const response = await fetch(
      `http://127.0.0.1:${adapterInfo.port}/v1/models`,
    );
    assert.equal(response.status, 401);
  });

  it('discovers models from root /v1/models when base is /anthropic', async () => {
    const response = await fetch(
      `http://127.0.0.1:${adapterInfo.port}/v1/models`,
      { headers: { 'x-api-key': LOCAL_TOKEN } },
    );
    assert.equal(response.status, 200);
    const json = await response.json();
    assert.equal(json.data.length, 2);
    assert.equal(json.data[0].id, 'model-a');
    assert.ok(
      mock.state.requests.some(
        (request) => request.method === 'GET' && request.path === '/v1/models',
      ),
    );
  });

  it('converts Anthropic messages to OpenAI chat completions', async () => {
    const response = await fetch(
      `http://127.0.0.1:${adapterInfo.port}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'x-api-key': LOCAL_TOKEN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'model-a',
          max_tokens: 32,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      },
    );
    assert.equal(response.status, 200);
    const json = await response.json();
    assert.equal(json.role, 'assistant');
    assert.equal(json.content[0].type, 'text');
    assert.equal(json.content[0].text, 'hello from chat');
    assert.equal(json.usage.input_tokens, 3);
  });

  it('forwards structured output requirements to Chat Completions', async () => {
    const response = await fetch(
      `http://127.0.0.1:${adapterInfo.port}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'x-api-key': LOCAL_TOKEN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'model-a',
          max_tokens: 32,
          messages: [{ role: 'user', content: 'return JSON' }],
          output_config: {
            format: {
              type: 'json_schema',
              name: 'answer',
              schema: {
                type: 'object',
                properties: { answer: { type: 'string' } },
                required: ['answer'],
              },
            },
          },
        }),
      },
    );

    assert.equal(response.status, 200);
    const providerRequest = mock.state.requests
      .filter((request) => request.method === 'POST' && request.path === '/v1/chat/completions')
      .at(-1);
    assert.equal(providerRequest.body.response_format.type, 'json_schema');
    assert.equal(providerRequest.body.response_format.json_schema.name, 'answer');
    assert.deepEqual(
      providerRequest.body.response_format.json_schema.schema.required,
      ['answer'],
    );
  });

  it('streams chat completions as Anthropic SSE', async () => {
    const response = await fetch(
      `http://127.0.0.1:${adapterInfo.port}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'x-api-key': LOCAL_TOKEN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'model-a',
          max_tokens: 32,
          stream: true,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      },
    );
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /event: message_start/);
    assert.match(text, /content_block_delta/);
    assert.match(text, /event: message_stop/);
    assert.match(text, /hel/);
    assert.match(text, /lo/);
  });

  it('ends a truncated chat stream with an error instead of a successful stop', async () => {
    const response = await fetch(
      `http://127.0.0.1:${adapterInfo.port}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'x-api-key': LOCAL_TOKEN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'truncated-chat-model',
          max_tokens: 32,
          stream: true,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      },
    );

    const text = await response.text();
    assert.match(text, /partial/);
    assert.match(text, /event: error/);
    assert.match(text, /ended without a completion marker/);
    assert.doesNotMatch(text, /event: message_stop/);
  });
});

describe('protocol capability fallback', () => {
  let mock;
  let mockInfo;
  let adapter;
  let adapterInfo;

  before(async () => {
    mock = createMockProvider({
      handlers: {
        'POST /v1/responses': {
          body: {
            id: 'unexpected-responses-result',
            status: 'completed',
            output: [],
          },
        },
        'POST /v1/chat/completions': ({ body }) => ({
          body: {
            id: 'chat-fallback',
            model: body.model,
            choices: [
              {
                finish_reason: 'stop',
                message: { role: 'assistant', content: 'chat fallback' },
              },
            ],
            usage: {},
          },
        }),
      },
    });
    mockInfo = await mock.start();
    const config = buildAdapterConfig({
      ANTHROPIC_API_KEY: 'sk-test-provider-key',
      ANTHROPIC_BASE_URL: `${mockInfo.baseUrl}/v1`,
      BYOK_LOCAL_TOKEN: LOCAL_TOKEN,
      BYOK_API_FORMAT: 'auto',
    });
    adapter = createAdapterServer(config, {
      logger: createLogger({ debug: false }),
    });
    adapterInfo = await adapter.listen(0, '127.0.0.1');
  });

  after(async () => {
    await adapter.shutdown(1000);
    await mock.stop();
  });

  it('falls back to Chat before sending Responses-unsupported generation controls', async () => {
    const response = await fetch(
      `http://127.0.0.1:${adapterInfo.port}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'x-api-key': LOCAL_TOKEN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'mixed-model',
          max_tokens: 32,
          stop_sequences: ['STOP'],
          presence_penalty: 0.5,
          frequency_penalty: 0.25,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      },
    );

    assert.equal(response.status, 200);
    const json = await response.json();
    assert.equal(json.content[0].text, 'chat fallback');
    assert.equal(
      mock.state.requests.filter((request) => request.path === '/v1/responses').length,
      0,
    );
    const chatRequest = mock.state.requests.find(
      (request) => request.path === '/v1/chat/completions',
    );
    assert.deepEqual(chatRequest.body.stop, ['STOP']);
    assert.equal(chatRequest.body.presence_penalty, 0.5);
    assert.equal(chatRequest.body.frequency_penalty, 0.25);
  });

  it('rejects unsupported generation controls when Responses is forced', async () => {
    const forcedConfig = buildAdapterConfig({
      ANTHROPIC_API_KEY: 'sk-test-provider-key',
      ANTHROPIC_BASE_URL: `${mockInfo.baseUrl}/v1`,
      BYOK_LOCAL_TOKEN: LOCAL_TOKEN,
      BYOK_API_FORMAT: 'openai-responses',
    });
    const forcedAdapter = createAdapterServer(forcedConfig, {
      logger: createLogger({ debug: false }),
    });
    const forcedAddress = await forcedAdapter.listen(0, '127.0.0.1');
    const responsesRequestsBefore = mock.state.requests.filter(
      (request) => request.path === '/v1/responses',
    ).length;

    try {
      const response = await fetch(
        `http://127.0.0.1:${forcedAddress.port}/v1/messages`,
        {
          method: 'POST',
          headers: {
            'x-api-key': LOCAL_TOKEN,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: 'responses-model',
            max_tokens: 32,
            stop_sequences: ['STOP'],
            messages: [{ role: 'user', content: 'hi' }],
          }),
        },
      );

      assert.equal(response.status, 400);
      const json = await response.json();
      assert.equal(json.error.type, 'invalid_request_error');
      assert.match(json.error.message, /stop_sequences/);
      assert.equal(
        mock.state.requests.filter((request) => request.path === '/v1/responses').length,
        responsesRequestsBefore,
      );
    } finally {
      await forcedAdapter.shutdown(1000);
    }
  });
});

describe('Chat Completions max-token dialect isolation', () => {
  it('re-probes the alternate dialect independently for each model', async () => {
    const mock = createMockProvider();
    let flippingModelUsesLegacyDialect = false;
    mock.setHandler('POST /v1/chat/completions', ({ body }) => {
      if (body.model === 'legacy' && Object.hasOwn(body, 'max_completion_tokens')) {
        return {
          status: 400,
          body: { error: { message: 'unknown parameter max_completion_tokens' } },
        };
      }
      if (body.model === 'modern' && Object.hasOwn(body, 'max_tokens')) {
        return {
          status: 400,
          body: { error: { message: 'unknown parameter max_tokens' } },
        };
      }
      if (body.model === 'flipping') {
        if (!flippingModelUsesLegacyDialect) {
          if (Object.hasOwn(body, 'max_completion_tokens')) {
            return {
              status: 400,
              body: { error: { message: 'unsupported max_completion_tokens' } },
            };
          }
          flippingModelUsesLegacyDialect = true;
        } else if (Object.hasOwn(body, 'max_tokens')) {
          return {
            status: 400,
            body: { error: { message: 'unsupported max_tokens' } },
          };
        }
      }
      return {
        body: {
          id: `chat-${body.model}`,
          model: body.model,
          choices: [
            {
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'ok' },
            },
          ],
          usage: {},
        },
      };
    });

    const mockInfo = await mock.start();
    const config = buildAdapterConfig({
      ANTHROPIC_API_KEY: 'sk-test-provider-key',
      ANTHROPIC_BASE_URL: mockInfo.baseUrl,
      BYOK_LOCAL_TOKEN: LOCAL_TOKEN,
      BYOK_API_FORMAT: 'openai-chat',
    });
    const adapter = createAdapterServer(config, {
      logger: createLogger({ debug: false }),
    });
    const adapterInfo = await adapter.listen(0, '127.0.0.1');

    try {
      const send = (model) => fetch(
        `http://127.0.0.1:${adapterInfo.port}/v1/messages`,
        {
          method: 'POST',
          headers: {
            'x-api-key': LOCAL_TOKEN,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model,
            max_tokens: 16,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        },
      );

      assert.equal((await send('legacy')).status, 200);
      assert.equal((await send('modern')).status, 200);
      assert.equal((await send('flipping')).status, 200);
      assert.equal((await send('flipping')).status, 200);

      const modernRequests = mock.state.requests.filter(
        (request) =>
          request.path === '/v1/chat/completions' && request.body.model === 'modern',
      );
      assert.equal(modernRequests.length, 1);
      assert.equal(Object.hasOwn(modernRequests[0].body, 'max_completion_tokens'), true);

      const flippingRequests = mock.state.requests.filter(
        (request) =>
          request.path === '/v1/chat/completions' && request.body.model === 'flipping',
      );
      assert.equal(flippingRequests.length, 4);
      assert.equal(Object.hasOwn(flippingRequests.at(-1).body, 'max_completion_tokens'), true);
    } finally {
      await adapter.shutdown(1000);
      await mock.stop();
    }
  });
});

describe('adapter client cancellation', () => {
  it('aborts the provider request when the client disconnects after upload', async () => {
    const mock = createMockProvider();
    let markProviderStarted;
    let markProviderClosed;
    const providerStarted = new Promise((resolveStarted) => {
      markProviderStarted = resolveStarted;
    });
    const providerClosed = new Promise((resolveClosed) => {
      markProviderClosed = resolveClosed;
    });

    mock.setHandler('POST /v1/chat/completions', ({ response }) =>
      new Promise((resolveHandler) => {
        markProviderStarted();
        const timeout = setTimeout(() => {
          if (!response.writableEnded) {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({
              id: 'late-response',
              choices: [{ finish_reason: 'stop', message: { content: 'late' } }],
            }));
          }
          resolveHandler(undefined);
        }, 1500);
        response.once('close', () => {
          clearTimeout(timeout);
          markProviderClosed();
          resolveHandler(undefined);
        });
      }));

    const mockInfo = await mock.start();
    const config = buildAdapterConfig({
      ANTHROPIC_API_KEY: 'sk-test-provider-key',
      ANTHROPIC_BASE_URL: mockInfo.baseUrl,
      BYOK_LOCAL_TOKEN: LOCAL_TOKEN,
      BYOK_API_FORMAT: 'openai-chat',
    });
    const adapter = createAdapterServer(config, {
      logger: createLogger({ debug: false }),
    });
    const adapterInfo = await adapter.listen(0, '127.0.0.1');

    try {
      const client = httpRequest({
        host: '127.0.0.1',
        port: adapterInfo.port,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'x-api-key': LOCAL_TOKEN,
          'content-type': 'application/json',
        },
      });
      client.on('error', () => {});
      client.end(JSON.stringify({
        model: 'model-a',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'wait' }],
      }));

      await providerStarted;
      client.destroy();
      const closed = await Promise.race([
        providerClosed.then(() => true),
        new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 500)),
      ]);
      assert.equal(closed, true);
    } finally {
      await adapter.shutdown(1000);
      await mock.stop();
    }
  });
});

describe('DeepSeek tool-loop reasoning', () => {
  let mock;
  let mockInfo;
  let adapter;
  let adapterInfo;

  before(async () => {
    mock = createMockProvider();
    let stage = 0;
    mock.setHandler('POST /v1/chat/completions', ({ body }) => {
      stage += 1;
      if (stage === 1) {
        return {
          status: 200,
          body: {
            id: 'chatcmpl_tool',
            model: body.model,
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: null,
                  reasoning_content: 'need tool',
                  tool_calls: [
                    {
                      id: 'call_ds_1',
                      type: 'function',
                      function: {
                        name: 'lookup',
                        arguments: '{"q":"x"}',
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 2 },
          },
        };
      }

      const assistantWithTools = body.messages.find(
        (message) => message.role === 'assistant' && message.tool_calls,
      );
      if (!assistantWithTools?.reasoning_content) {
        return {
          status: 400,
          body: {
            error: {
              message: 'missing reasoning_content after tool call',
            },
          },
        };
      }
      return {
        status: 200,
        body: {
          id: 'chatcmpl_final',
          model: body.model,
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: 'final answer',
                reasoning_content: 'done thinking',
              },
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        },
      };
    });

    mockInfo = await mock.start();
    // Use deepseek hostname via BYOK_PROVIDER override since mock is localhost.
    const config = buildAdapterConfig({
      ANTHROPIC_API_KEY: 'sk-test-provider-key',
      ANTHROPIC_BASE_URL: mockInfo.baseUrl,
      BYOK_LOCAL_TOKEN: LOCAL_TOKEN,
      BYOK_API_FORMAT: 'openai-chat',
      BYOK_PROVIDER: 'deepseek',
    });
    adapter = createAdapterServer(config, {
      logger: createLogger({ debug: false }),
    });
    adapterInfo = await adapter.listen(0, '127.0.0.1');
  });

  after(async () => {
    await adapter.shutdown(1000);
    await mock.stop();
  });

  it('D06: preserves reasoning_content across tool result turn', async () => {
    const first = await fetch(
      `http://127.0.0.1:${adapterInfo.port}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'x-api-key': LOCAL_TOKEN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'deepseek-reasoner',
          max_tokens: 64,
          thinking: { type: 'enabled' },
          tools: [
            {
              name: 'lookup',
              description: 'lookup',
              input_schema: {
                type: 'object',
                properties: { q: { type: 'string' } },
              },
            },
          ],
          messages: [{ role: 'user', content: 'use tool' }],
        }),
      },
    );
    assert.equal(first.status, 200);
    const firstJson = await first.json();
    const thinking = firstJson.content.find((block) => block.type === 'thinking');
    const toolUse = firstJson.content.find((block) => block.type === 'tool_use');
    assert.ok(thinking);
    assert.ok(toolUse);

    const second = await fetch(
      `http://127.0.0.1:${adapterInfo.port}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'x-api-key': LOCAL_TOKEN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'deepseek-reasoner',
          max_tokens: 64,
          thinking: { type: 'enabled' },
          tools: [
            {
              name: 'lookup',
              description: 'lookup',
              input_schema: {
                type: 'object',
                properties: { q: { type: 'string' } },
              },
            },
          ],
          messages: [
            { role: 'user', content: 'use tool' },
            { role: 'assistant', content: firstJson.content },
            {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: toolUse.id,
                  content: 'tool output',
                },
              ],
            },
          ],
        }),
      },
    );
    assert.equal(second.status, 200);
    const secondJson = await second.json();
    assert.equal(secondJson.content.at(-1).text, 'final answer');
  });
});

describe('OpenAI Responses streaming tool loop', () => {
  let mock;
  let mockInfo;
  let adapter;
  let adapterInfo;
  let stage = 0;

  before(async () => {
    mock = createMockProvider();
    mock.setHandler('POST /v1/responses', ({ body }) => {
      stage += 1;
      if (stage === 1) {
        assert.equal(body.stream, true);
        return {
          sse: [
            {
              event: 'response.output_item.added',
              data: {
                type: 'response.output_item.added',
                item: {
                  id: 'fc_1',
                  type: 'function_call',
                  call_id: 'call_1',
                  name: 'lookup',
                  arguments: '',
                  status: 'in_progress',
                },
              },
            },
            {
              event: 'response.function_call_arguments.delta',
              data: {
                type: 'response.function_call_arguments.delta',
                item_id: 'fc_1',
                call_id: 'call_1',
                delta: '{"q":"x"}',
              },
            },
            {
              event: 'response.output_item.done',
              data: {
                type: 'response.output_item.done',
                item: {
                  id: 'fc_1',
                  type: 'function_call',
                  call_id: 'call_1',
                  name: 'lookup',
                  arguments: '{"q":"x"}',
                  status: 'completed',
                },
              },
            },
            {
              event: 'response.completed',
              data: {
                type: 'response.completed',
                response: {
                  usage: { input_tokens: 2, output_tokens: 1 },
                },
              },
            },
          ],
        };
      }

      const functionCall = body.input.find((item) => item.type === 'function_call');
      const functionOutput = body.input.find(
        (item) => item.type === 'function_call_output',
      );
      assert.equal(functionCall.call_id, 'call_1');
      assert.equal(functionCall.arguments, '{"q":"x"}');
      assert.equal(functionCall.status, 'completed');
      assert.equal(functionOutput.call_id, 'call_1');
      return {
        status: 200,
        body: {
          id: 'resp_final',
          model: body.model,
          status: 'completed',
          output: [
            {
              id: 'msg_final',
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'tool loop complete' }],
            },
          ],
          usage: { input_tokens: 4, output_tokens: 3 },
        },
      };
    });
    mockInfo = await mock.start();
    const config = buildAdapterConfig({
      ANTHROPIC_API_KEY: 'sk-test-provider-key',
      ANTHROPIC_BASE_URL: `${mockInfo.baseUrl}/openai`,
      BYOK_LOCAL_TOKEN: LOCAL_TOKEN,
      BYOK_API_FORMAT: 'openai-responses',
    });
    adapter = createAdapterServer(config, {
      logger: createLogger({ debug: false }),
    });
    adapterInfo = await adapter.listen(0, '127.0.0.1');
  });

  after(async () => {
    await adapter.shutdown(1000);
    await mock.stop();
  });

  it('restores finalized streamed function-call items for the tool result turn', async () => {
    const first = await fetch(
      `http://127.0.0.1:${adapterInfo.port}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'x-api-key': LOCAL_TOKEN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'responses-model',
          max_tokens: 64,
          stream: true,
          tools: [
            {
              name: 'lookup',
              description: 'lookup',
              input_schema: { type: 'object' },
            },
          ],
          messages: [{ role: 'user', content: 'use tool' }],
        }),
      },
    );
    assert.equal(first.status, 200);
    const firstText = await first.text();
    assert.match(firstText, /call_1/);

    const second = await fetch(
      `http://127.0.0.1:${adapterInfo.port}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'x-api-key': LOCAL_TOKEN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'responses-model',
          max_tokens: 64,
          tools: [
            {
              name: 'lookup',
              description: 'lookup',
              input_schema: { type: 'object' },
            },
          ],
          messages: [
            { role: 'user', content: 'use tool' },
            {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: 'call_1',
                  name: 'lookup',
                  input: { q: 'x' },
                },
              ],
            },
            {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'call_1',
                  content: 'result',
                },
              ],
            },
          ],
        }),
      },
    );
    assert.equal(second.status, 200);
    const secondJson = await second.json();
    assert.equal(secondJson.content[0].text, 'tool loop complete');
  });
});

describe('OpenAI Responses streaming completion states', () => {
  let mock;
  let adapter;
  let adapterInfo;

  before(async () => {
    mock = createMockProvider({
      handlers: {
        'POST /v1/responses': ({ body }) => {
          if (body.model === 'failed-model') {
            return {
              sse: [
                {
                  event: 'response.failed',
                  data: {
                    type: 'response.failed',
                    response: {
                      status: 'failed',
                      error: { message: 'provider stream failed' },
                    },
                  },
                },
              ],
            };
          }
          if (body.model === 'truncated-responses-model') {
            return {
              sse: [
                {
                  event: 'response.output_item.added',
                  data: {
                    type: 'response.output_item.added',
                    item: { id: 'msg_truncated', type: 'message', content: [] },
                  },
                },
                {
                  event: 'response.output_text.delta',
                  data: {
                    type: 'response.output_text.delta',
                    item_id: 'msg_truncated',
                    delta: 'partial answer',
                  },
                },
              ],
            };
          }
          return {
            sse: [
              {
                event: 'response.output_item.added',
                data: {
                  type: 'response.output_item.added',
                  item: { id: 'msg_incomplete', type: 'message', content: [] },
                },
              },
              {
                event: 'response.output_text.delta',
                data: {
                  type: 'response.output_text.delta',
                  item_id: 'msg_incomplete',
                  delta: 'partial answer',
                },
              },
              {
                event: 'response.incomplete',
                data: {
                  type: 'response.incomplete',
                  response: {
                    status: 'incomplete',
                    incomplete_details: { reason: 'max_output_tokens' },
                    usage: { input_tokens: 3, output_tokens: 8 },
                  },
                },
              },
            ],
          };
        },
      },
    });
    const mockInfo = await mock.start();
    const config = buildAdapterConfig({
      ANTHROPIC_API_KEY: 'sk-test-provider-key',
      ANTHROPIC_BASE_URL: mockInfo.baseUrl,
      BYOK_LOCAL_TOKEN: LOCAL_TOKEN,
      BYOK_API_FORMAT: 'openai-responses',
    });
    adapter = createAdapterServer(config, {
      logger: createLogger({ debug: false }),
    });
    adapterInfo = await adapter.listen(0, '127.0.0.1');
  });

  after(async () => {
    await adapter.shutdown(1000);
    await mock.stop();
  });

  it('maps max_output_tokens incomplete to a normal max_tokens stop', async () => {
    const response = await fetch(
      `http://127.0.0.1:${adapterInfo.port}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'x-api-key': LOCAL_TOKEN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'responses-model',
          max_tokens: 8,
          stream: true,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      },
    );

    assert.equal(response.status, 200);
    const text = await response.text();
    assert.doesNotMatch(text, /event: error/);
    assert.match(text, /"stop_reason":"max_tokens"/);
    assert.match(text, /"output_tokens":8/);
    assert.match(text, /event: message_stop/);
    assert.ok(
      text.indexOf('event: content_block_stop') < text.indexOf('event: message_delta'),
    );
  });

  it('ends failed streams with an error and no successful message stop', async () => {
    const response = await fetch(
      `http://127.0.0.1:${adapterInfo.port}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'x-api-key': LOCAL_TOKEN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'failed-model',
          max_tokens: 8,
          stream: true,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      },
    );

    const text = await response.text();
    assert.match(text, /event: error/);
    assert.match(text, /provider stream failed/);
    assert.doesNotMatch(text, /event: message_stop/);
  });

  it('ends a truncated Responses stream with an error instead of a successful stop', async () => {
    const response = await fetch(
      `http://127.0.0.1:${adapterInfo.port}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'x-api-key': LOCAL_TOKEN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'truncated-responses-model',
          max_tokens: 8,
          stream: true,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      },
    );

    const text = await response.text();
    assert.match(text, /partial answer/);
    assert.match(text, /event: error/);
    assert.match(text, /ended without a terminal event/);
    assert.doesNotMatch(text, /event: message_stop/);
  });
});
