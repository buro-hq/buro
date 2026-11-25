import test from 'node:test';
import assert from 'node:assert/strict';
import { OllamaProvider } from '../agent/providers/ollama.ts';
import { DeepSeekProvider } from '../agent/providers/deepseek.ts';
import { endpointURL, lines } from '../agent/providers/http.ts';
import type { ModelProvider } from '../agent/contracts/model.ts';

const input = (): Parameters<ModelProvider['complete']>[0] => ({
  requestId: 'r',
  model: 'fixture-model',
  messages: [{ role: 'user', content: 'Return JSON.' }],
  tools: [],
  schema: { type: 'object' },
  maxOutputTokens: 100,
  contextTokens: 2000,
  signal: new AbortController().signal,
  onProgress() {},
});
const deepseek = (fetch: typeof globalThis.fetch) =>
  new DeepSeekProvider({
    ...{ revision: 'fixture', local: false, fetch: globalThis.fetch },
    id: 'fixture',
    endpoint: 'https://provider.invalid',
    apiKey: () => 'fixture-key',
    fetch,
  });
const ollama = (chat: () => Response) =>
  new OllamaProvider({
    ...{ revision: 'fixture', local: true, fetch: globalThis.fetch },
    id: 'fixture',
    endpoint: 'http://127.0.0.1:11434',
    fetch: async (url) =>
      String(url).endsWith('/api/show')
        ? Response.json({
            capabilities: ['tools'],
            model_info: { 'fixture.context_length': 4000 },
          })
        : chat(),
  });

test('terminal empty responses and unexpected choice indexes never look like completed answers', async () => {
  await assert.rejects(
    ollama(() =>
      Response.json({
        done: true,
        done_reason: 'stop',
        message: { role: 'assistant', content: '' },
      })).complete(input()),
    {
      code: 'MODEL_INVALID_RESPONSE',
    },
  );
  await assert.rejects(
    deepseek(
      async () =>
        new Response(
          'data: {"choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        ),
    ).complete(input()),
    {
      code: 'MODEL_INVALID_RESPONSE',
    },
  );
  await assert.rejects(
    deepseek(
      async () =>
        new Response(
          'data: {"choices":[{"index":1,"delta":{"content":"{}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        ),
    ).complete(input()),
    {
      code: 'MODEL_STREAM_INTERRUPTED',
    },
  );
});

test('invalid UTF-8 is rejected instead of changing streamed tool arguments', async () => {
  const malformed = new Uint8Array([123, 34, 112, 97, 116, 104, 34, 58, 34, 0xff, 34, 125]);
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(malformed);
        controller.close();
      },
    }),
  );
  await assert.rejects(
    async () => {
      for await (const _line of lines(response, () => {})) {
        // Consume until the malformed response is rejected.
      }
    },
    {
      code: 'MODEL_INVALID_RESPONSE',
    },
  );
});

test('terminal completion cancels a still-open response and response bounds release its reader', async () => {
  let cancelled = false;
  const p = deepseek(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"index":0,"delta":{"content":"{}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
              ),
            );
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  assert.equal((await p.complete(input())).finish, 'stop');
  assert.equal(cancelled, true);
  let oversizedCancelled = false;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
      },
      cancel() {
        oversizedCancelled = true;
      },
    }),
  );
  await assert.rejects(
    async () => {
      for await (const _line of lines(response, () => {})) {
        // Consume until the malformed response is rejected.
      }
    },
    {
      code: 'MODEL_RESPONSE_LIMIT',
    },
  );
  assert.equal(oversizedCancelled, true);
});

test('malformed credential-bearing endpoints are replaced by a sanitized typed error', () => {
  assert.throws(
    () => endpointURL('https://user:PRIVATE_KEY@%invalid'),
    (error: any) => {
      assert.equal(error.code, 'INVALID_ENDPOINT');
      assert.doesNotMatch(JSON.stringify(error) + String(error), /PRIVATE_KEY/);
      return true;
    },
  );
});
