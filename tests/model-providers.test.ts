import test from 'node:test';
import assert from 'node:assert/strict';
import { OllamaProvider } from '../adapters/models/ollama.ts';
import { DeepSeekProvider } from '../adapters/models/deepseek.ts';
import { RequestGate } from '../adapters/models/http.ts';
import type { ModelProvider, ModelMessage } from '../agent/contracts/model.ts';

function streamed(text: string) {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    }),
  );
}
const sse = (chunks: unknown[], done = true) =>
  streamed(
    chunks.map((chunk) => 'data: ' + JSON.stringify(chunk) + '\r\n\r\n').join('') +
      (done ? 'data: [DONE]\r\n\r\n' : ''),
  );
const input = (
  messages: ModelMessage[] = [{ role: 'user', content: 'Return JSON; call read_file if needed.' }],
): Parameters<ModelProvider['complete']>[0] => ({
  requestId: 'request',
  model: 'fixture-model',
  messages,
  tools: [
    {
      name: 'read_file',
      description: 'Read a file',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    },
  ],
  schema: { type: 'object' },
  maxOutputTokens: 1024,
  contextTokens: 16000,
  signal: new AbortController().signal,
  onProgress() {},
});

test('DeepSeek reconstructs streamed calls and retains private thinking across tool rounds', async () => {
  const bodies: any[] = [];
  const p = new DeepSeekProvider({
    id: 'deepseek',
    endpoint: 'https://api.deepseek.com',
    apiKey: () => 'fixture-key',
    thinking: 'enabled',
    fetch: async (url, init) => {
      assert.equal(String(url), 'https://api.deepseek.com/chat/completions');
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fixture-key');
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      assert.equal(body.stream, true);
      assert.deepEqual(body.response_format, { type: 'json_object' });
      assert.equal(body.thinking.type, 'enabled');
      if (bodies.length === 1)
        return sse([
          {
            model: 'reported-alias',
            choices: [{ index: 0, delta: { reasoning_content: 'private ' } }],
          },
          {
            choices: [
              {
                index: 0,
                delta: {
                  reasoning_content: 'reasoning',
                  tool_calls: [
                    { index: 0, id: 'call-1', function: { name: 'read_', arguments: '{"pa' } },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 0, function: { name: 'file', arguments: 'th":"src/a.ts"}' } },
                    {
                      index: 1,
                      id: 'call-2',
                      function: { name: 'read_file', arguments: '{"path":"src/b.ts"}' },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          },
          { choices: [], usage: { prompt_tokens: 40, completion_tokens: 20 } },
        ]);
      return sse([
        {
          model: 'reported-alias',
          choices: [{ index: 0, delta: { content: '{"готово":true}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 80, completion_tokens: 10 },
        },
      ]);
    },
  });
  const first = await p.complete(input());
  assert.equal(first.finish, 'tools');
  assert.equal(first.model, 'reported-alias');
  assert.deepEqual(first.usage, { inputTokens: 40, outputTokens: 20 });
  assert.deepEqual(first.message.toolCalls, [
    { id: 'call-1', name: 'read_file', arguments: { path: 'src/a.ts' } },
    { id: 'call-2', name: 'read_file', arguments: { path: 'src/b.ts' } },
  ]);
  const second = await p.complete(
    input([
      ...input().messages,
      first.message,
      { role: 'tool', content: 'a', toolCallId: 'call-1', toolName: 'read_file' },
      { role: 'tool', content: 'b', toolCallId: 'call-2', toolName: 'read_file' },
    ]),
  );
  assert.equal(bodies[1].messages[1].reasoning_content, 'private reasoning');
  assert.equal(bodies[1].messages[2].tool_call_id, 'call-1');
  assert.equal(bodies[1].messages[1].tool_calls[0].function.arguments, '{"path":"src/a.ts"}');
  assert.equal(second.message.content, '{"готово":true}');
  assert.equal(second.finish, 'stop');
});

test('Ollama discovers installed models and preserves native tools/thinking without cloud fallback', async () => {
  const bodies: any[] = [];
  const p = new OllamaProvider({
    id: 'local',
    endpoint: 'http://127.0.0.1:11434',
    think: true,
    fetch: async (url, init) => {
      const route = new URL(String(url)).pathname;
      if (route === '/api/tags')
        return Response.json({ models: [{ name: 'fixture-model', digest: 'digest' }] });
      if (route === '/api/show')
        return Response.json({
          capabilities: ['completion', 'tools', 'thinking'],
          model_info: { 'fixture.context_length': 32768 },
        });
      assert.equal(route, '/api/chat');
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      assert.equal(body.options.num_ctx, 16000);
      assert.equal(body.options.num_predict, 1024);
      assert.equal(body.think, true);
      assert.deepEqual(body.format, body.tools?.length ? undefined : { type: 'object' });
      return bodies.length === 1
        ? streamed(
            [
              {
                model: 'fixture-model',
                message: {
                  role: 'assistant',
                  thinking: 'private local thinking',
                  tool_calls: [
                    { function: { index: 0, name: 'read_file', arguments: { path: 'src/a.ts' } } },
                  ],
                },
                done: false,
              },
              {
                model: 'fixture-model',
                message: { role: 'assistant', content: '' },
                done: true,
                done_reason: 'stop',
                prompt_eval_count: 10,
                eval_count: 5,
              },
            ]
              .map((chunk) => JSON.stringify(chunk))
              .join('\n') + '\n',
          )
        : streamed(
            JSON.stringify({
              message: { role: 'assistant', content: '{"ok":"да"}' },
              done: true,
              done_reason: 'stop',
            }),
          );
    },
  });
  assert.equal(p.local, true);
  assert.equal(p.structuredOutputMode, 'schema');
  assert.deepEqual(await p.listModels(new AbortController().signal), [
    { id: 'fixture-model', digest: 'digest' },
  ]);
  const first = await p.complete(input());
  assert.equal(first.finish, 'tools');
  assert.deepEqual(first.message.toolCalls?.[0].arguments, { path: 'src/a.ts' });
  const second = await p.complete(
    input([
      ...input().messages,
      first.message,
      {
        role: 'tool',
        content: 'file',
        toolCallId: first.message.toolCalls![0].id,
        toolName: 'read_file',
      },
    ]),
  );
  assert.equal(bodies[1].messages[1].thinking, 'private local thinking');
  assert.equal(bodies[1].messages[2].tool_name, 'read_file');
  assert.deepEqual(bodies[1].messages[1].tool_calls[0].function.arguments, { path: 'src/a.ts' });
  assert.equal(second.message.content, '{"ok":"да"}');
  assert.equal(second.usage, undefined);
  await p.complete({ ...input(), tools: [] });
  assert.deepEqual(bodies[2].format, { type: 'object' });
});

test('unfinished streams, invalid arguments and provider errors never become success or expose credentials', async () => {
  const incomplete = new DeepSeekProvider({
    id: 'd',
    endpoint: 'https://api.deepseek.com',
    apiKey: () => 'SECRET_KEY',
    fetch: async () =>
      sse([{ choices: [{ index: 0, delta: { content: '{}' }, finish_reason: 'stop' }] }], false),
  });
  await assert.rejects(incomplete.complete(input()), { code: 'MODEL_STREAM_INTERRUPTED' });
  const invalid = new DeepSeekProvider({
    id: 'd',
    endpoint: 'https://api.deepseek.com',
    apiKey: () => 'SECRET_KEY',
    fetch: async () =>
      sse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: 'c', function: { name: 'edit_file', arguments: '{bad}' } },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
      ]),
  });
  await assert.rejects(invalid.complete(input()), { code: 'MODEL_INVALID_RESPONSE' });
  const rateLimited = new DeepSeekProvider({
    id: 'd',
    endpoint: 'https://api.deepseek.com',
    apiKey: () => 'SECRET_KEY',
    fetch: async () => new Response('SECRET_KEY PRIVATE_REASONING', { status: 429 }),
  });
  await assert.rejects(
    rateLimited.complete(input()),
    (error: any) => error.code === 'MODEL_RATE_LIMITED' && !/SECRET|PRIVATE/.test(error.message),
  );
  let requested = false;
  const noKey = new DeepSeekProvider({
    id: 'd',
    endpoint: 'https://api.deepseek.com',
    apiKey: () => undefined,
    fetch: async () => {
      requested = true;
      throw Error('Unexpected');
    },
  });
  await assert.rejects(noKey.complete(input()), { code: 'MODEL_AUTH_REQUIRED' });
  assert.equal(requested, false);
  assert.throws(
    () =>
      new DeepSeekProvider({
        id: 'd',
        endpoint: 'https://user:SECRET@example.com',
        apiKey: () => '',
      }),
    { code: 'INVALID_ENDPOINT' },
  );
  assert.throws(
    () =>
      new DeepSeekProvider({ id: 'd', endpoint: 'http://remote.invalid', apiKey: () => 'secret' }),
    { code: 'INVALID_ENDPOINT' },
  );
});

test('Ollama rejects remote-backed and unsupported models before generation', async () => {
  for (const info of [
    { remote_host: 'cloud.invalid', capabilities: ['tools'] },
    { capabilities: ['completion'] },
    { capabilities: ['tools'], model_info: { 'fixture.context_length': 1000 } },
  ]) {
    let generations = 0;
    const p = new OllamaProvider({
      id: 'o',
      endpoint: 'http://127.0.0.1:11434',
      fetch: async (url) => {
        if (String(url).endsWith('/api/show')) return Response.json(info);
        generations++;
        throw Error('Unexpected generation');
      },
    });
    await assert.rejects(p.complete(input()));
    assert.equal(generations, 0);
  }
});

test('endpoint capacity queues requests and cancellation removes only the waiting request', async () => {
  const gate = new RequestGate(1);
  const order: string[] = [];
  let release!: () => void;
  const first = gate.run(new AbortController().signal, async () => {
    order.push('first');
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  while (!release) await Promise.resolve();
  const stopped = new AbortController();
  const second = gate.run(stopped.signal, async () => {
    order.push('cancelled');
  });
  const rejected = assert.rejects(second, { name: 'AbortError' });
  const third = gate.run(new AbortController().signal, async () => {
    order.push('third');
  });
  stopped.abort();
  await rejected;
  assert.deepEqual(order, ['first']);
  release();
  await Promise.all([first, third]);
  assert.deepEqual(order, ['first', 'third']);
});
