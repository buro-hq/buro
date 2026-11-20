import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DeepSeekProvider } from '../adapters/models/deepseek.ts';
import { CapabilityProbeService, type ProbeReceipt } from '../core/capability-probe.ts';
import type { ModelProvider } from '../core/model-ports.ts';

function completed(content: string) {
  return new Response(
    'data: ' +
      JSON.stringify({
        choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }],
      }) +
      '\n\ndata: [DONE]\n\n',
  );
}

test('DeepSeek tool-only requests with undefined or null schemas do not enable JSON mode', async () => {
  const provider = new DeepSeekProvider({
    id: 'deepseek',
    endpoint: 'https://api.deepseek.com',
    apiKey: () => 'synthetic-credential',
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(Object.hasOwn(body, 'response_format'), false);
      assert.equal(body.tools[0].function.name, 'diagnostic_echo');
      return completed('ready');
    },
  });
  for (const schema of [undefined, null]) {
    const input: Parameters<ModelProvider['complete']>[0] = {
      requestId: 'tool-only',
      model: 'fixture-model',
      messages: [{ role: 'user', content: 'Call diagnostic_echo once, then wait.' }],
      tools: [
        { name: 'diagnostic_echo', description: 'Read-only echo', parameters: { type: 'object' } },
      ],
      schema,
      maxOutputTokens: 1024,
      contextTokens: 16384,
      signal: new AbortController().signal,
      onProgress() {},
    };
    assert.equal((await provider.complete(input)).message.content, 'ready');
  }
});

test('DeepSeek capability probe starts without JSON mode and enables it only for the instructed final response', async () => {
  const bodies: any[] = [];
  const provider = new DeepSeekProvider({
    id: 'deepseek',
    endpoint: 'https://api.deepseek.com',
    apiKey: () => 'synthetic-credential',
    thinking: 'enabled',
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (
        body.response_format &&
        !body.messages.some(
          (message: any) =>
            ['user', 'system'].includes(message.role) && /json/i.test(message.content),
        )
      )
        return Response.json(
          { error: { message: 'Synthetic JSON-mode precondition failure.' } },
          { status: 400 },
        );
      if (bodies.length === 1) {
        assert.equal(Object.hasOwn(body, 'response_format'), false);
        assert.equal(body.tools[0].function.name, 'diagnostic_echo');
        return new Response(
          'data: ' +
            JSON.stringify({
              model: 'fixture-reported',
              choices: [
                {
                  index: 0,
                  delta: {
                    reasoning_content:
                      'Full private reasoning remains in the native tool continuation.',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'diagnostic-call',
                        type: 'function',
                        function: { name: 'diagnostic_echo', arguments: '{"value":"buro-ready"}' },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            }) +
            '\n\ndata: [DONE]\n\n',
        );
      }
      assert.equal(bodies.length, 2, 'Only the bounded two probe generations are allowed.');
      assert.deepEqual(body.response_format, { type: 'json_object' });
      assert.equal(body.tools, undefined);
      assert.equal(body.thinking.type, 'enabled');
      const assistant = body.messages.find((message: any) => message.role === 'assistant');
      assert.equal(
        assistant.reasoning_content,
        'Full private reasoning remains in the native tool continuation.',
      );
      assert.deepEqual(assistant.tool_calls, [
        {
          id: 'diagnostic-call',
          type: 'function',
          function: { name: 'diagnostic_echo', arguments: '{"value":"buro-ready"}' },
        },
      ]);
      assert.equal(
        body.messages.find((message: any) => message.role === 'tool').tool_call_id,
        'diagnostic-call',
      );
      assert.match(body.messages.at(-1).content, /Return only JSON/);
      return completed('{"ok":true}');
    },
  });
  const receipts = new Map<string, ProbeReceipt>();
  let generations = 0;
  const probe = new CapabilityProbeService({
    binding: () => ({
      provider,
      model: 'fixture-model',
      configurationRevision: provider.revision,
      contextTokens: 16384,
      maxOutputTokens: 1024,
    }),
    store: {
      async loadRequest(id) {
        return receipts.get(id);
      },
      async saveRequest(receipt) {
        receipts.set(receipt.id, structuredClone(receipt));
      },
      async saveResult() {},
    },
    now: () => '2026-11-20T00:00:00.000Z',
    id: () => String(++generations),
  });
  try {
    const result = await probe.probe('probe', 'probe', 'fixture-runtime');
    assert.equal(result.status, 'passed');
    assert.equal(bodies.length, 2);
    assert.equal(receipts.get('probe')?.status, 'completed');
  } finally {
    await probe.dispose();
  }
  const oldRevision = createHash('sha256')
    .update(JSON.stringify(['deepseek-chat-v1', 'https://api.deepseek.com/', 'enabled']))
    .digest('hex');
  assert.notEqual(provider.revision, oldRevision);
});
