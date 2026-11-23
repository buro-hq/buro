import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatibleProvider } from '../adapters/models/openai-compatible.ts';
import { OllamaProvider } from '../adapters/models/ollama.ts';
import { OpenAICompatibleConnectionConfigSchema } from '../protocol/resource-builtins.ts';
import { openAICompatibleContribution } from '../adapters/resources/contributions/openai-compatible.ts';
import type { ModelProvider } from '../agent/contracts/model.ts';

const input = (): Parameters<ModelProvider['complete']>[0] => ({
  requestId: 'local',
  model: 'qwen',
  messages: [{ role: 'user', content: 'Return JSON' }],
  tools: [],
  schema: {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
    additionalProperties: false,
  },
  maxOutputTokens: 128,
  contextTokens: 4096,
  signal: new AbortController().signal,
  onProgress() {},
});
function wire(calls = false) {
  return new Response(
    'data: ' +
      JSON.stringify({
        model: 'qwen',
        choices: [
          {
            index: 0,
            delta: calls
              ? {
                  reasoning_content: 'private',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-1',
                      function: { name: 'read_file', arguments: '{"path":"a"}' },
                    },
                  ],
                }
              : { content: '{"ok":true}' },
            finish_reason: calls ? 'tool_calls' : 'stop',
          },
        ],
      }) +
      '\n\ndata: [DONE]\n\n',
  );
}

test('OpenAI-compatible local endpoint uses /v1, optional auth, native schema and no vendor defaults', async () => {
  const bodies: any[] = [];
  const p = new OpenAICompatibleProvider({
    id: 'local',
    endpoint: 'http://127.0.0.1:8080/v1',
    sampling: { temperature: 0, topP: 0.8, presencePenalty: 0 },
    fetch: async (url, init) => {
      assert.equal(new Headers(init?.headers).has('Authorization'), false);
      if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'qwen' }] });
      assert.equal(String(url), 'http://127.0.0.1:8080/v1/chat/completions');
      bodies.push(JSON.parse(String(init?.body)));
      return wire(bodies.length === 1);
    },
  });
  assert.equal(p.local, true);
  assert.deepEqual(await p.listModels(input().signal), [{ id: 'qwen' }]);
  const first = await p.complete({
    ...input(),
    tools: [{ name: 'read_file', description: 'Read', parameters: { type: 'object' } }],
  });
  assert.equal(first.finish, 'tools');
  assert.equal(bodies[0].response_format, undefined);
  await p.complete({
    ...input(),
    messages: [
      ...input().messages,
      first.message,
      { role: 'tool', toolCallId: 'call-1', content: 'a' },
    ],
  });
  assert.deepEqual(bodies[1].response_format, {
    type: 'json_schema',
    json_schema: { name: 'response', strict: true, schema: input().schema },
  });
  assert.equal(bodies[1].messages[1].reasoning_content, 'private');
  assert.equal(bodies[1].messages[2].tool_call_id, 'call-1');
  assert.equal(bodies[1].max_tokens, 128);
  assert.equal(bodies[1].temperature, 0);
  assert.equal(bodies[1].top_p, 0.8);
  assert.equal(bodies[1].presence_penalty, 0);
  assert.equal(bodies[1].thinking, undefined);
  assert.equal(bodies[1].reasoning_effort, undefined);
});

test('explicit API dialect settings are honored and a missing configured key fails before fetch', async () => {
  let count = 0;
  const fetch: typeof globalThis.fetch = async (_, init) => {
    count++;
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-key');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.max_tokens, undefined);
    assert.equal(body.max_completion_tokens, 128);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.deepEqual(body.thinking, { type: 'enabled' });
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: true });
    return wire();
  };
  const options = {
    id: 'remote',
    endpoint: 'https://example.invalid/v1',
    fetch,
    responseFormat: 'json_object' as const,
    maxTokenField: 'max_completion_tokens' as const,
    thinking: 'enabled' as const,
    enableThinking: true,
  };
  await new OpenAICompatibleProvider({ ...options, apiKey: () => 'test-key' }).complete(input());
  const p = new OpenAICompatibleProvider({ ...options, apiKey: () => undefined });
  await assert.rejects(p.complete(input()), { code: 'MODEL_AUTH_REQUIRED' });
  assert.equal(count, 1);
});

test('LAN trust is explicit and external connections cannot send credentials over HTTP', () => {
  const c = openAICompatibleContribution();
  assert.equal(
    c.describe(c.parse({ endpoint: 'http://192.168.0.227:8080/v1', trust: 'private-network' }))
      .local,
    true,
  );
  for (const config of [
    { endpoint: 'http://192.168.0.227:8080/v1' },
    { endpoint: 'http://example.com/v1' },
    { endpoint: 'https://example.com/v1', trust: 'private-network' },
    { endpoint: 'http://user:secret@localhost/v1' },
  ])
    assert.equal(OpenAICompatibleConnectionConfigSchema.safeParse(config).success, false);
  const external = c.parse({
    endpoint: 'https://example.com/v1',
    apiKeyEnv: 'ENGINE_KEY',
    trust: 'external',
  });
  assert.equal(c.describe(external).local, false);
  assert.deepEqual(c.describe(external).credentialReferences, ['ENGINE_KEY']);
});

test('sampling is validated and changes the frozen provider identity for both local transports', () => {
  for (const sampling of [
    { temperature: -1 },
    { topP: 2 },
    { presencePenalty: 3 },
    { temperature: NaN },
    { num_ctx: 999999 },
  ])
    assert.equal(OpenAICompatibleConnectionConfigSchema.safeParse({ sampling }).success, false);
  const base = { id: 'local', endpoint: 'http://127.0.0.1:8080' };
  for (const Provider of [OpenAICompatibleProvider, OllamaProvider])
    assert.notEqual(
      new Provider(base).revision,
      new Provider({ ...base, sampling: { temperature: 0 } }).revision,
    );
});

test('the local reasoning budget is explicit, preserves zero and participates in connection identity', async () => {
  const revisions = new Set<string>();
  for (const budget of [undefined, -1, 0, 1024]) {
    const provider = new OpenAICompatibleProvider({
      id: 'local',
      endpoint: 'http://127.0.0.1:8080/v1',
      enableThinking: true,
      ...(budget !== undefined ? { reasoningBudgetTokens: budget } : {}),
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.reasoning_budget_tokens, budget);
        assert.equal(Object.hasOwn(body, 'reasoning_budget_tokens'), budget !== undefined);
        assert.equal(body.max_tokens, 128, 'Reasoning budget does not silently reduce output.');
        return wire();
      },
    });
    revisions.add(provider.revision);
    await provider.complete(input());
  }
  assert.equal(revisions.size, 4);
  for (const reasoningBudgetTokens of [-2, 0.5, Infinity])
    assert.equal(
      OpenAICompatibleConnectionConfigSchema.safeParse({ reasoningBudgetTokens }).success,
      false,
    );
});
