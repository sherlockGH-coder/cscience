import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateModelCandidateUrls,
  parseModelsResponse,
  parseOperonModels,
  safeModelDisplayName,
} from '../../pkg/platform/lib/byok-adapter/models.mjs';
import {
  adapterConfigFingerprint,
  normalizeBaseUrl,
  resolveApiFormatHint,
  buildAdapterConfig,
} from '../../pkg/platform/lib/byok-adapter/config.mjs';
import {
  applyDeepSeekThinkingNormalization,
  isDeepSeekProvider,
} from '../../pkg/platform/lib/byok-adapter/providers/deepseek.mjs';
import { anthropicRequestToNormalized } from '../../pkg/platform/lib/byok-adapter/normalize.mjs';
import {
  normalizedToChatRequest,
  chatResponseToNormalized,
} from '../../pkg/platform/lib/byok-adapter/protocols/openai-chat.mjs';
import {
  normalizedToResponsesRequest,
  responsesToNormalized,
} from '../../pkg/platform/lib/byok-adapter/protocols/openai-responses.mjs';
import { messagesEndpointForFormat } from '../../pkg/platform/lib/byok-adapter/detect.mjs';
import { API_FORMATS } from '../../pkg/platform/lib/byok-adapter/config.mjs';

describe('normalizeBaseUrl', () => {
  it('strips query/fragment and trailing slash', () => {
    const base = normalizeBaseUrl('https://api.deepseek.com/anthropic/?x=1#frag');
    assert.equal(base.pathname, '/anthropic');
    assert.equal(base.origin, 'https://api.deepseek.com');
  });

  it('rejects credentials in URL', () => {
    assert.throws(() => normalizeBaseUrl('https://user:pass@api.example.com'));
  });
});

describe('adapterConfigFingerprint', () => {
  const base = {
    ANTHROPIC_API_KEY: 'sk-test',
    ANTHROPIC_BASE_URL: 'https://api.example.com/anthropic',
  };

  it('changes when behavior-affecting options change', () => {
    const first = adapterConfigFingerprint({
      ...base,
      BYOK_API_FORMAT: 'openai-chat',
    });
    const second = adapterConfigFingerprint({
      ...base,
      BYOK_API_FORMAT: 'openai-responses',
    });
    assert.notEqual(first, second);
  });
});

describe('model candidate URLs', () => {
  it('M03: /anthropic falls back to root /v1/models', () => {
    const candidates = generateModelCandidateUrls('https://api.deepseek.com/anthropic');
    assert.deepEqual(candidates, [
      'https://api.deepseek.com/anthropic/v1/models',
      'https://api.deepseek.com/v1/models',
      'https://api.deepseek.com/models',
    ]);
  });

  it('M04: trailing slash matches no-slash candidates', () => {
    const a = generateModelCandidateUrls('https://api.deepseek.com/anthropic');
    const b = generateModelCandidateUrls('https://api.deepseek.com/anthropic/');
    assert.deepEqual(a, b);
  });

  it('M05: base already /v1 does not produce /v1/v1/models', () => {
    const candidates = generateModelCandidateUrls('https://api.example.com/v1');
    assert.ok(candidates.includes('https://api.example.com/v1/models'));
    assert.ok(!candidates.some((url) => url.includes('/v1/v1/')));
  });

  it('M06: preserves business prefix team-a', () => {
    const candidates = generateModelCandidateUrls(
      'https://gateway.example.com/team-a/anthropic',
    );
    assert.ok(
      candidates.includes('https://gateway.example.com/team-a/v1/models'),
    );
    assert.ok(
      !candidates.includes('https://gateway.example.com/v1/models'),
    );
  });

  it('M07: middle anthropic is not stripped', () => {
    const candidates = generateModelCandidateUrls(
      'https://gateway.example.com/anthropic-proxy/api',
    );
    assert.ok(
      candidates.every((url) => url.includes('/anthropic-proxy/api')),
    );
  });
});

describe('parseModelsResponse', () => {
  it('M12: filters empty ids, dedupes, falls back name to id', () => {
    const models = parseModelsResponse({
      data: [
        { id: 'a', name: 'A' },
        { id: 'a', name: 'dup' },
        { id: '  ', name: 'bad' },
        { id: 'b' },
        'c',
      ],
    });
    assert.deepEqual(models, [
      { id: 'a', display_name: 'A', type: 'model' },
      { id: 'b', display_name: 'B', type: 'model' },
      { id: 'c', display_name: 'C', type: 'model' },
    ]);
  });

  it('keeps DeepSeek ids visible in the Claude Science model picker', () => {
    const models = parseModelsResponse({
      data: [
        { id: 'deepseek-v4-flash' },
        { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro' },
      ],
    });
    assert.deepEqual(models, [
      {
        id: 'deepseek-v4-flash',
        display_name: 'DeepSeek V4 Flash',
        type: 'model',
      },
      {
        id: 'deepseek-v4-pro',
        display_name: 'DeepSeek V4 Pro',
        type: 'model',
      },
    ]);
    assert.equal(
      /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(models[0].display_name),
      false,
    );
  });

  it('preserves an existing human-readable provider name', () => {
    assert.equal(
      safeModelDisplayName('DeepSeek Reasoner', 'deepseek-reasoner'),
      'DeepSeek Reasoner',
    );
  });

  it('parses OPERON_MODELS comma format', () => {
    const models = parseOperonModels('m1:One,m2:Two');
    assert.equal(models.length, 2);
    assert.equal(models[0].display_name, 'One');
  });
});

describe('protocol hints and endpoints', () => {
  it('anthropic path prefers anthropic protocol first', () => {
    const order = resolveApiFormatHint('/anthropic');
    assert.equal(order[0], API_FORMATS.ANTHROPIC);
  });

  it('openai path prefers responses then chat', () => {
    const order = resolveApiFormatHint('/openai/v1');
    assert.deepEqual(order.slice(0, 2), [
      API_FORMATS.OPENAI_RESPONSES,
      API_FORMATS.OPENAI_CHAT,
    ]);
  });

  it('builds chat endpoint from anthropic base by stripping suffix', () => {
    const base = normalizeBaseUrl('https://api.deepseek.com/anthropic');
    const endpoint = messagesEndpointForFormat(base, API_FORMATS.OPENAI_CHAT);
    assert.equal(endpoint, 'https://api.deepseek.com/v1/chat/completions');
  });
});

describe('DeepSeek thinking normalization', () => {
  const baseConfig = buildAdapterConfig({
    ANTHROPIC_API_KEY: 'sk-test-key',
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    BYOK_LOCAL_TOKEN: 'x'.repeat(32),
    BYOK_REASONING_EFFORT: 'high',
  });

  it('detects deepseek by hostname', () => {
    assert.equal(isDeepSeekProvider(baseConfig), true);
  });

  it('D01: budget_tokens becomes enabled + high and removes sampling', () => {
    const normalized = anthropicRequestToNormalized({
      model: 'deepseek-reasoner',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
      temperature: 0.7,
      top_p: 0.9,
      thinking: { type: 'enabled', budget_tokens: 8000 },
    });
    const result = applyDeepSeekThinkingNormalization(normalized, baseConfig);
    assert.equal(result.enabled, true);
    assert.equal(result.effort, 'high');
    const patched = result.openaiPatch({
      temperature: 0.7,
      top_p: 0.9,
      presence_penalty: 1,
      frequency_penalty: 1,
    });
    assert.equal(patched.thinking.type, 'enabled');
    assert.equal(patched.reasoning_effort, 'high');
    assert.equal(patched.temperature, undefined);
    assert.equal(patched.top_p, undefined);
  });

  it('D02: explicit disabled keeps sampling and drops effort', () => {
    const normalized = anthropicRequestToNormalized({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 50,
      temperature: 0.2,
      thinking: { type: 'disabled' },
    });
    const result = applyDeepSeekThinkingNormalization(normalized, baseConfig);
    assert.equal(result.enabled, false);
    const patched = result.openaiPatch({
      temperature: 0.2,
      reasoning_effort: 'high',
    });
    assert.equal(patched.thinking.type, 'disabled');
    assert.equal(patched.temperature, 0.2);
    assert.equal(patched.reasoning_effort, undefined);
  });
});

describe('OpenAI Chat conversion', () => {
  it('maps text + tool_use request and response', () => {
    const normalized = anthropicRequestToNormalized({
      model: 'gpt-test',
      system: 'be helpful',
      messages: [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'calling tool' },
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
      tools: [
        {
          name: 'lookup',
          description: 'lookup',
          input_schema: { type: 'object', properties: { q: { type: 'string' } } },
        },
      ],
      max_tokens: 128,
    });

    const chatRequest = normalizedToChatRequest(normalized);
    assert.equal(chatRequest.model, 'gpt-test');
    assert.equal(chatRequest.messages[0].role, 'system');
    assert.equal(chatRequest.messages.at(-1).role, 'tool');
    assert.equal(chatRequest.messages.at(-1).tool_call_id, 'call_1');
    assert.ok(chatRequest.tools[0].function.parameters);

    const normalizedResponse = chatResponseToNormalized({
      id: 'chatcmpl_1',
      model: 'gpt-test',
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: 'done',
            reasoning_content: 'think',
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    assert.equal(normalizedResponse.contentBlocks[0].type, 'thinking');
    assert.equal(normalizedResponse.contentBlocks[1].type, 'text');
    assert.equal(normalizedResponse.stopReason, 'end_turn');
    assert.equal(normalizedResponse.usage.inputTokens, 10);
  });

  it('maps Anthropic structured output to Chat Completions response_format', () => {
    const normalized = anthropicRequestToNormalized({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'return JSON' }],
      output_config: {
        format: {
          type: 'json_schema',
          name: 'review_result',
          description: 'Review result',
          strict: true,
          schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
          },
        },
      },
    });

    const body = normalizedToChatRequest(normalized);
    assert.deepEqual(body.response_format, {
      type: 'json_schema',
      json_schema: {
        name: 'review_result',
        description: 'Review result',
        strict: true,
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
        },
      },
    });
  });
});

describe('OpenAI Responses conversion', () => {
  it('maps non-stream response items', () => {
    const normalized = responsesToNormalized({
      id: 'resp_1',
      model: 'gpt-test',
      status: 'completed',
      output: [
        {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'why' }],
        },
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'hello' }],
        },
        {
          type: 'function_call',
          call_id: 'call_9',
          name: 'search',
          arguments: '{"q":"a"}',
        },
      ],
      usage: { input_tokens: 3, output_tokens: 7 },
    });
    assert.equal(normalized.contentBlocks[0].type, 'thinking');
    assert.equal(normalized.contentBlocks[1].type, 'text');
    assert.equal(normalized.contentBlocks[2].type, 'tool_use');
    assert.equal(normalized.contentBlocks[2].id, 'call_9');
    assert.equal(normalized.stopReason, 'tool_use');
  });

  it('builds store:false request with function_call_output', () => {
    const normalized = anthropicRequestToNormalized({
      model: 'gpt-test',
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_9',
              name: 'search',
              input: { q: 'a' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_9',
              content: 'found',
            },
          ],
        },
      ],
    });
    const body = normalizedToResponsesRequest(normalized, null);
    assert.equal(body.store, false);
    assert.ok(body.input.some((item) => item.type === 'function_call_output'));
  });

  it('preserves metadata and structured output for Responses', () => {
    const normalized = anthropicRequestToNormalized({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'return JSON' }],
      metadata: { user_id: 'review-user' },
      output_config: {
        format: {
          type: 'json_schema',
          name: 'review_result',
          schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
          },
        },
      },
    });

    const body = normalizedToResponsesRequest(normalized, null);
    assert.deepEqual(body.metadata, { user_id: 'review-user' });
    assert.equal(body.text.format.type, 'json_schema');
    assert.equal(body.text.format.name, 'review_result');
    assert.deepEqual(body.text.format.schema.required, ['ok']);
  });
});
