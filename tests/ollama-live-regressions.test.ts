import test from 'node:test';
import assert from 'node:assert/strict';
import { OllamaProvider } from '../agent/providers/ollama.ts';
import { DeepSeekProvider } from '../agent/providers/deepseek.ts';
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

function fixture(responses: unknown[][]) {
  const bodies: any[] = [];
  const provider = new OllamaProvider({
    ...{ revision: 'fixture', local: true, fetch: globalThis.fetch },
    id: 'ollama',
    endpoint: 'http://127.0.0.1:11434',
    think: false,
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
}

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

function evidenceHistory(): ModelMessage[] {
  return [
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
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

test('explicit non-thinking projection removes only completed batch commentary without mutating full frozen evidence', () => {
  const { provider } = fixture([]);
  const messages = deepFreeze(evidenceHistory());
  const original = structuredClone(messages);
  const projected = provider.contextMessages(messages);
  const expected = structuredClone(messages);
  expected[2].content = '';
  assert.deepEqual(projected, expected);
  assert.deepEqual(messages, original);
  assert.equal(projected.length, messages.length);
  assert.deepEqual(projected[2].continuation, messages[2].continuation);
  assert.deepEqual(projected[2].toolCalls, messages[2].toolCalls);
  assert.deepEqual(projected[3], messages[3]);
  assert.deepEqual(projected[4], messages[4]);
  (projected[2].toolCalls![0].arguments as { path: string }).path = 'changed';
  (projected[2].continuation as { native: { value: number } }).native.value = 2;
  assert.deepEqual(messages, original);
});

test('partial and pending tool batches and boundaries preserve assistant content', () => {
  const { provider } = fixture([]);
  const complete = evidenceHistory();
  const cases: ModelMessage[][] = [
    complete.slice(0, 3),
    complete.slice(0, 4),
    [...complete.slice(0, 4), { role: 'user', content: 'A new request.' }, complete[4]],
    [
      ...complete.slice(0, 4),
      { role: 'assistant', content: 'Another assistant turn.' },
      complete[4],
    ],
    [{ role: 'assistant', content: 'An ordinary answer without tool calls.' }],
    [{ role: 'assistant', content: 'An ordinary answer with an empty tool list.', toolCalls: [] }],
  ];
  for (const messages of cases)
    assert.deepEqual(provider.contextMessages(deepFreeze(messages)), messages);
});

test('ambiguous duplicate or missing call/result identities preserve the entire batch', () => {
  const { provider } = fixture([]);
  const duplicateCalls = evidenceHistory();
  duplicateCalls[2].toolCalls![1].id = 'first';
  const missingCallId = evidenceHistory();
  missingCallId[2].toolCalls![1].id = '';
  const duplicateResults = evidenceHistory();
  duplicateResults.splice(5, 0, structuredClone(duplicateResults[3]));
  const unknownResult = evidenceHistory();
  unknownResult.splice(5, 0, { role: 'tool', toolCallId: 'foreign', content: 'Unknown result.' });
  const duplicateAcrossBatches = evidenceHistory();
  duplicateAcrossBatches.push(
    {
      role: 'assistant',
      content: 'Reused call identity.',
      toolCalls: [structuredClone(duplicateAcrossBatches[2].toolCalls![0])],
    },
    structuredClone(duplicateAcrossBatches[3]),
  );
  for (const messages of [
    duplicateCalls,
    missingCallId,
    duplicateResults,
    unknownResult,
    duplicateAcrossBatches,
  ])
    assert.deepEqual(provider.contextMessages(deepFreeze(messages)), messages);
});

test('thinking/default Ollama histories remain complete and DeepSeek has no commentary projection', () => {
  const messages = deepFreeze(evidenceHistory());
  for (const think of [undefined, true, 'low']) {
    const provider = new OllamaProvider({
      ...{ revision: 'fixture', local: true, fetch: globalThis.fetch },
      id: 'local',
      endpoint: 'http://127.0.0.1:11434',
      think,
    });
    assert.deepEqual(provider.contextMessages(messages), messages);
  }
  const deepseek: ModelProvider = new DeepSeekProvider({
    ...{ revision: 'fixture', local: false, fetch: globalThis.fetch },
    id: 'remote',
    endpoint: 'https://api.deepseek.com',
    apiKey: () => 'unused-fixture-key',
  });
  assert.equal(deepseek.contextMessages, undefined);
});

test('final projection omits only the explicit current intermediate content and retains its continuation and historical answers', () => {
  const { provider } = fixture([]);
  const original = evidenceHistory();
  original.push(
    { role: 'user', content: 'The current task.' },
    {
      role: 'assistant',
      content: 'PRIVATE_CURRENT_INTERMEDIATE '.repeat(1000),
      continuation: { thinking: 'Full private candidate continuation.' },
    },
    {
      role: 'user',
      content: 'Reconstruct the final JSON from original task and recorded tool results.',
    },
  );
  const messages = deepFreeze(original);
  const intermediateMessageIndex = messages.length - 2;
  const projected = provider.contextMessages(messages, {
    phase: 'final',
    intermediateMessageIndexes: [intermediateMessageIndex],
  });
  const expected = structuredClone(messages);
  expected[2].content = '';
  expected[intermediateMessageIndex].content = '';
  assert.deepEqual(projected, expected);
  assert.equal(messages[intermediateMessageIndex].content.length > 10000, true);
  assert.equal(projected[5].content, 'The final visible answer is preserved.');
  assert.deepEqual(
    projected[intermediateMessageIndex].continuation,
    messages[intermediateMessageIndex].continuation,
  );
  assert.equal(projected[3].content, messages[3].content);
  assert.equal(projected[4].content, messages[4].content);
});

test('unmarked or invalid intermediate provenance cannot omit an ordinary assistant answer', () => {
  const { provider } = fixture([]);
  const messages: ModelMessage[] = [
    { role: 'assistant', content: 'A prior final answer.' },
    { role: 'user', content: 'The current task.' },
    {
      role: 'assistant',
      content: 'The current completion note.',
      continuation: { thinking: 'Preserved.' },
    },
    { role: 'user', content: 'Final output request.' },
  ];
  for (const context of [
    undefined,
    { phase: 'final' as const },
    { phase: 'work' as const },
    { phase: 'work' as const, intermediateMessageIndexes: [2, 2] },
    { phase: 'work' as const, intermediateMessageIndexes: [2, 0] },
    ...[-1, 0, 1, 3, 100, 1.5, Number.NaN].map((intermediateMessageIndex) => ({
      phase: 'final' as const,
      intermediateMessageIndexes: [intermediateMessageIndex],
    })),
  ])
    assert.deepEqual(provider.contextMessages(deepFreeze(messages), context), messages);
  for (const think of [undefined, true, 'low']) {
    const thinking = new OllamaProvider({
      ...{ revision: 'fixture', local: true, fetch: globalThis.fetch },
      id: 'local',
      endpoint: 'http://127.0.0.1:11434',
      think,
    });
    assert.deepEqual(
      thinking.contextMessages(messages, { phase: 'final', intermediateMessageIndexes: [2] }),
      messages,
    );
  }
  const historical = provider.contextMessages(messages, {
    phase: 'work',
    intermediateMessageIndexes: [2],
  });
  assert.equal(historical[0].content, 'A prior final answer.');
  assert.equal(historical[2].content, '');
  assert.equal(messages[2].content, 'The current completion note.');
  const toolCandidate = structuredClone(messages);
  toolCandidate[2].toolCalls = [
    { id: 'pending', name: 'read_file', arguments: { path: 'src/value.mjs' } },
  ];
  assert.deepEqual(
    provider.contextMessages(toolCandidate, { phase: 'final', intermediateMessageIndexes: [2] }),
    toolCandidate,
  );
  const noFinalUser = structuredClone(messages);
  noFinalUser[3] = { role: 'assistant', content: 'A real final answer.' };
  assert.deepEqual(
    provider.contextMessages(noFinalUser, { phase: 'final', intermediateMessageIndexes: [2] }),
    noFinalUser,
  );
});

test('projected non-thinking evidence is serialized with complete native calls/results/continuation without changing saved evidence', async () => {
  const { provider, bodies } = fixture([
    [{ ...terminal, message: { role: 'assistant', content: '{"ok":true}' } }],
  ]);
  const messages = deepFreeze(evidenceHistory());
  await provider.complete({
    ...request(),
    tools: [],
    messages: provider.contextMessages(messages),
  });
  assert.equal(bodies[0].messages[2].content, '');
  assert.equal(bodies[0].messages[2].thinking, 'Retain the full private continuation.');
  assert.deepEqual(
    bodies[0].messages[2].tool_calls.map((call: any) => call.function.arguments),
    [{ path: 'src/first.ts' }, { path: 'src/second.ts' }],
  );
  assert.equal(bodies[0].messages[3].content, messages[3].content);
  assert.equal(bodies[0].messages[4].content, messages[4].content);
  assert.equal(messages[2].content.length > 10000, true);
});
