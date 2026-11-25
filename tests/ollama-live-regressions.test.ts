import test from 'node:test';
import assert from 'node:assert/strict';
import { OllamaProvider } from '../agent/providers/ollama.ts';
import type { ModelMessage, ModelProvider } from '../agent/contracts/model.ts';

const request = (): Parameters<ModelProvider['complete']>[0] => ({
  requestId: 'native-turn',
  model: 'qwen3:4b',
  messages: [{ role: 'user', content: 'Call diagnostic_echo once with value buro-ready.' }],
  tools: [
    {
      name: 'diagnostic_echo',
      description: 'Read-only readiness diagnostic',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string', enum: ['buro-ready'] } },
        required: ['value'],
        additionalProperties: false,
      },
    },
  ],
  schema: {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
    additionalProperties: false,
  },
  maxOutputTokens: 1024,
  contextTokens: 16384,
  signal: new AbortController().signal,
  onProgress() {},
});

const nativeCall = (index: number) => ({
  id: 'ollama-call-' + index,
  function: { index, name: 'diagnostic_echo', arguments: { value: 'buro-ready' } },
});
const toolFrame = (index: number) => ({
  message: { role: 'assistant', content: '', tool_calls: [nativeCall(index)] },
  done: false,
});
const terminal = {
  message: { role: 'assistant', content: '' },
  done: true,
  done_reason: 'stop',
};

const fixture = (responses: unknown[][], options: { think?: boolean | string } = { think: false }) => {
  const bodies: any[] = [];
  const provider = new OllamaProvider({
    ...{ revision: 'fixture', local: true, fetch: globalThis.fetch },
    id: 'ollama',
    endpoint: 'http://127.0.0.1:11434',
    think: options.think,
    fetch: async (url, init) => {
      const route = new URL(String(url)).pathname;
      if (route === '/api/show')
        return Response.json({
          capabilities: ['completion', 'tools', 'thinking'],
          model_info: { 'qwen3.context_length': 32768 },
        });

      assert.equal(route, '/api/chat');
      bodies.push(JSON.parse(String(init?.body)));
      const frames = responses.shift();
      assert.ok(frames, 'No unexpected additional generation is allowed.');
      const bytes = new TextEncoder().encode(
        frames.map((frame) => JSON.stringify(frame)).join('\n') + '\n',
      );
      return new Response(
        new ReadableStream({
          start(controller) {
            for (let index = 0; index < bytes.length; index += 7)
              controller.enqueue(bytes.slice(index, index + 7));
            controller.close();
          },
        }),
      );
    },
  });
  return { provider, bodies };
};

test('native Ollama function.index identifies one complete tool call without a duplicate from terminal frames', async () => {
  const { provider, bodies } = fixture([
    [
      { message: { role: 'assistant', content: 'Checking readiness. ' }, done: false },
      toolFrame(0),
      terminal,
    ],
  ]);
  const response = await provider.complete(request());
  assert.equal(response.finish, 'tools');
  assert.equal(response.message.content, 'Checking readiness. ');
  assert.deepEqual(response.message.toolCalls, [
    {
      id: 'native-turn:call:0',
      name: 'diagnostic_echo',
      arguments: { value: 'buro-ready' },
    },
  ]);
  assert.equal(bodies.length, 1);
});

test('two native identical calls remain two distinct actions; the decoder must not silently deduplicate model requests', async () => {
  const { provider } = fixture([[toolFrame(0), toolFrame(1), terminal]]);
  const response = await provider.complete(request());
  assert.equal(response.finish, 'tools');
  assert.deepEqual(
    response.message.toolCalls?.map((call) => call.id),
    ['native-turn:call:0', 'native-turn:call:1'],
  );
  assert.deepEqual(
    response.message.toolCalls?.map(({ name, arguments: args }) => ({ name, args })),
    [
      { name: 'diagnostic_echo', args: { value: 'buro-ready' } },
      { name: 'diagnostic_echo', args: { value: 'buro-ready' } },
    ],
  );
});

test('Ollama native tool definitions and replayed assistant/tool history retain their documented shapes', async () => {
  const { provider, bodies } = fixture([
    [toolFrame(0), terminal],
    [{ ...terminal, message: { role: 'assistant', content: '{"ok":true}' } }],
  ]);
  const input = request();
  const first = await provider.complete(input);
  const second = await provider.complete({
    ...input,
    requestId: 'native-final',
    tools: [],
    messages: [
      ...input.messages,
      first.message,
      {
        role: 'tool',
        toolCallId: first.message.toolCalls![0].id,
        toolName: 'diagnostic_echo',
        content: '{"value":"buro-ready"}',
      },
    ],
  });
  assert.deepEqual(bodies[0].tools, [{ type: 'function', function: input.tools[0] }]);
  assert.equal(bodies[0].format, undefined);
  assert.equal(bodies[0].think, false);
  assert.deepEqual(bodies[1].messages[1].tool_calls, [
    {
      function: { index: 0, name: 'diagnostic_echo', arguments: { value: 'buro-ready' } },
    },
  ]);
  assert.deepEqual(bodies[1].messages[2], {
    role: 'tool',
    content: '{"value":"buro-ready"}',
    tool_name: 'diagnostic_echo',
  });
  assert.deepEqual(bodies[1].tools, []);
  assert.deepEqual(bodies[1].format, input.schema);
  assert.equal(second.message.content, '{"ok":true}');
  assert.equal(bodies.length, 2);
});

const evidenceHistory = (): ModelMessage[] => [
  { role: 'system', content: 'Keep the assignment boundaries.' },
  { role: 'user', content: 'Inspect both files before proposing a change.' },
  {
    role: 'assistant',
    content: 'Long visible tool commentary. '.repeat(400),
    toolCalls: [
      { id: 'first', name: 'read_file', arguments: { path: 'src/first.ts' } },
      { id: 'second', name: 'read_file', arguments: { path: 'src/second.ts' } },
    ],
    continuation: { thinking: 'Retain the full private continuation.', native: { value: 1 } },
  },
  {
    role: 'tool',
    toolCallId: 'first',
    toolName: 'read_file',
    content: 'Full first file result.',
  },
  {
    role: 'tool',
    toolCallId: 'second',
    toolName: 'read_file',
    content: 'Full second file result.',
  },
  { role: 'assistant', content: 'The final visible answer is preserved.' },
];

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value))
      deepFreeze(child);
  }

  return value;
}

test('every thinking setting retains complete assistant text, native tools, results and private continuation', async () => {
  for (const think of [undefined, false, true, 'low']) {
    const { provider, bodies } = fixture([
      [{ ...terminal, message: { role: 'assistant', content: 'Done.' } }],
    ], {
      think,
    });
    const messages = deepFreeze(evidenceHistory());
    const original = structuredClone(messages);
    await provider.complete({
      ...request(),
      messages,
    });
    assert.equal(bodies[0].think, think);
    assert.equal(bodies[0].messages[2].content, messages[2].content);
    assert.equal(bodies[0].messages[2].thinking, 'Retain the full private continuation.');
    assert.deepEqual(
      bodies[0].messages[2].tool_calls.map((call: any) => call.function.arguments),
      [{ path: 'src/first.ts' }, { path: 'src/second.ts' }],
    );
    assert.equal(bodies[0].messages[3].content, messages[3].content);
    assert.equal(bodies[0].messages[4].content, messages[4].content);
    assert.equal(bodies[0].messages[5].content, messages[5].content);
    assert.deepEqual(messages, original);
  }
});

test('JSON and call-like tags in ordinary model text never become executable tool calls', async () => {
  for (const content of [
    '{"name":"diagnostic_echo","arguments":{"value":"buro-ready"}}',
    '<tool_call>{"name":"diagnostic_echo","arguments":{"value":"buro-ready"}}</tool_call>',
    'I edited the files and ran the tests successfully.',
  ]) {
    const { provider } = fixture([
      [{ ...terminal, message: { role: 'assistant', content } }],
    ]);
    const response = await provider.complete(request());
    assert.equal(response.finish, 'stop');
    assert.equal(response.message.content, content);
    assert.equal(response.message.toolCalls, undefined);
  }
});
