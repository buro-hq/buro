import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAICompatibleProvider } from '../../agent/providers/openai-compatible.ts';
import type { ModelMessage, ModelProvider } from '../../agent/contracts/model.ts';

interface WireRequest {
  messages: ModelMessage[];
  response_format?: { type: string; json_schema?: { schema: unknown } };
  tools?: unknown[];
}

test('structured contracts reach instruction and native-schema transports without changing history', async () => {
  const schema = {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message'],
        },
      },
    },
    required: ['findings'],
  };
  const messages: ModelMessage[] = [{ role: 'user', content: 'Review the changed code.' }];
  const original = structuredClone(messages);
  for (const responseFormat of ['json_object', 'instruction', 'json_schema'] as const) {
    let wire: WireRequest | undefined;
    const provider = new OpenAICompatibleProvider({
      id: 'schema-contract',
      revision: 'test',
      local: true,
      endpoint: 'http://127.0.0.1:1/v1',
      responseFormat,
      fetch: async (_url, options) => {
        wire = JSON.parse(String(options?.body));
        return new Response('data: {"choices":[{"index":0,"delta":{"content":"{\\"findings\\":[]}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      },
    });
    const input: Parameters<ModelProvider['complete']>[0] = {
      requestId: responseFormat,
      model: 'fixture',
      messages,
      schema,
      tools: [],
      contextTokens: 4096,
      maxOutputTokens: 128,
      signal: new AbortController().signal,
      onProgress() {},
    };
    const result = await provider.complete(input);
    assert.deepEqual(JSON.parse(result.message.content), {
      findings: [],
    });
    assert.deepEqual(messages, original);
    assert.equal(wire?.tools, undefined);

    if (responseFormat === 'json_schema') {
      assert.deepEqual(wire?.response_format?.json_schema?.schema, schema);
      assert.deepEqual(wire?.messages, original);
    } else {
      const guidance = wire?.messages.at(-1)?.content ?? '';
      assert.ok(guidance.includes(JSON.stringify(schema)));
      assert.equal(wire?.response_format?.type, responseFormat === 'json_object' ? 'json_object' : undefined);
    }

    await provider.complete({
      ...input,
      schema: null,
    });
    assert.deepEqual(wire?.messages, original);
    assert.equal(wire?.response_format, undefined);
  }
});
