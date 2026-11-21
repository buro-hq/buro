import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

// Guard against accidental provider access, including during package import.
let networkAttempts = 0;
const denyNetwork = () => { networkAttempts++; throw Error('Network disabled in SDK spike'); };
after(() => assert.equal(networkAttempts, 0, 'SDK spike must not attempt provider networking'));
globalThis.fetch = denyNetwork;
http.request = denyNetwork;
http.get = denyNetwork;
https.request = denyNetwork;
https.get = denyNetwork;
net.connect = denyNetwork;
net.createConnection = denyNetwork;

const { runAgentLoop } = await import('@earendil-works/pi-agent-core');
const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai/utils/event-stream');

const model = {
  id: 'fixture', name: 'Fixture', api: 'openai-completions', provider: 'fixture',
  baseUrl: 'http://unused.invalid', input: ['text'], reasoning: false,
  contextWindow: 16384, maxTokens: 2048,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const message = (content, stopReason = 'stop') => ({
  role: 'assistant', content, api: model.api, provider: model.provider,
  model: model.id, usage, stopReason, timestamp: Date.now(),
});
const call = (id, value = 1) => ({ type: 'toolCall', id, name: 'write', arguments: { value } });
const emitMessage = (response) => {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: 'start', partial: { ...response, content: [] } });
    if (response.content[0]?.type === 'text') {
      stream.push({ type: 'text_start', contentIndex: 0, partial: response });
      stream.push({ type: 'text_delta', contentIndex: 0, delta: response.content[0].text, partial: response });
      stream.push({ type: 'text_end', contentIndex: 0, content: response.content[0].text, partial: response });
    }
    if (['error', 'aborted'].includes(response.stopReason))
      stream.push({ type: 'error', reason: response.stopReason, error: response });
    else stream.push({ type: 'done', reason: response.stopReason, message: response });
    stream.end();
  });
  return stream;
};
const tool = (execute) => ({
  name: 'write', label: 'Fixture write', description: 'Fake host-owned effect',
  parameters: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false },
  execute, replay: 'never', executionMode: 'sequential',
});
const success = () => ({ content: [{ type: 'text', text: 'saved' }], details: {} });
const system = () => ({ role: 'system', content: 'Frozen criteria', timestamp: Date.now() });
const prompt = () => ({ role: 'user', content: 'Fixture goal', timestamp: Date.now() });
const baseConfig = () => ({ model, convertToLlm: (messages) => messages, toolExecution: 'sequential', identity: { attribution: null } });

test('stream deltas and sequential tool execution preserve committed host ordering', async () => {
  const events = [], order = [];
  let requests = 0, active = 0, maximum = 0;
  const execute = async (id, args, signal) => {
    signal?.throwIfAborted();
    order.push(`grant:${id}`);
    maximum = Math.max(maximum, ++active);
    await new Promise((resolve) => setImmediate(resolve));
    order.push(`effect:${id}:${args.value}`);
    order.push(`receipt:${id}`);
    active--;
    return success();
  };
  await runAgentLoop([prompt()], { messages: [system()], tools: [tool(execute)] }, baseConfig(),
    (event) => events.push(event), undefined, () => {
      requests++;
      return emitMessage(requests === 1 ? message([call('a'), call('b', 2)], 'toolUse') : message([{ type: 'text', text: 'done' }]));
    });
  assert.equal(requests, 2);
  assert.equal(maximum, 1);
  assert.deepEqual(order, ['grant:a', 'effect:a:1', 'receipt:a', 'grant:b', 'effect:b:2', 'receipt:b']);
  assert.ok(events.some((event) => event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta'));
  assert.equal(events.at(-1).type, 'agent_end');
});

test('raw execute failure becomes a model-visible tool error and does not stop another request', async () => {
  let requests = 0;
  await runAgentLoop([prompt()], { messages: [system()], tools: [tool(async () => { throw Error('Journal unavailable'); })] },
    baseConfig(), () => {}, undefined, () => {
      requests++;
      return emitMessage(requests === 1 ? message([call('a')], 'toolUse') : message([{ type: 'text', text: 'next' }]));
    });
  assert.equal(requests, 2);
});

test('host fatal grant failure aborts a tool batch before any effect and prevents model continuation', async () => {
  const controller = new AbortController(), events = [];
  let fatal, requests = 0, effects = 0;
  const execute = async () => {
    try { throw Error('Admission not committed'); }
    catch (error) { fatal = error; controller.abort(error); throw error; }
    effects++; // unreachable: the grant was never committed
  };
  await runAgentLoop([prompt()], { messages: [system()], tools: [tool(execute)] },
    { ...baseConfig(), finishTurn: () => fatal ? { action: 'end' } : undefined },
    (event) => events.push(event), controller.signal, () => {
      requests++;
      return emitMessage(message([call('a'), call('b')], 'toolUse'));
    });
  assert.equal(requests, 1);
  assert.equal(effects, 0);
  assert.ok(events.some((event) => event.type === 'tool_execution_start'));
  assert.equal(events.at(-1).type, 'agent_end');
});

test('failed receipt after an effect remains unknown and stops the next effect/request', async () => {
  const controller = new AbortController();
  const journal = new Map();
  let fatal, requests = 0, effects = 0;
  const execute = async (id, args, signal) => {
    signal?.throwIfAborted();
    journal.set(id, 'dispatched');
    effects++;
    try { throw Error('Receipt persistence failed'); }
    catch (error) { fatal = error; journal.set(id, 'unknown'); controller.abort(error); throw error; }
  };
  await runAgentLoop([prompt()], { messages: [system()], tools: [tool(execute)] },
    { ...baseConfig(), finishTurn: () => fatal ? { action: 'end' } : undefined },
    () => {}, controller.signal, () => {
      requests++;
      return emitMessage(message([call('a'), call('b')], 'toolUse'));
    });
  assert.equal(effects, 1);
  assert.equal(requests, 1);
  assert.equal(journal.get('a'), 'unknown');
  assert.equal(journal.has('b'), false);
});

test('canonical context can be projected without sending an omitted application message', async () => {
  let observed;
  const context = { messages: [system(), { role: 'user', content: 'omitted-app-message', timestamp: 1 }], tools: [] };
  await runAgentLoop([prompt()], context, {
    ...baseConfig(),
    transformContext: async (messages) => messages.filter((item) => item.content !== 'omitted-app-message'),
  }, () => {}, undefined, (selectedModel, packet) => {
    observed = packet;
    return emitMessage(message([{ type: 'text', text: 'done' }]));
  });
  assert.equal(JSON.stringify(observed).includes('omitted-app-message'), false);
  assert.equal(observed.messages[0].content, 'Frozen criteria');
  assert.ok(context.messages.some((item) => item.content === 'omitted-app-message'));
});

test('prepareRequest failure prevents provider dispatch and requires an outer error boundary', async () => {
  let requests = 0;
  const events = [];
  await assert.rejects(runAgentLoop([prompt()], { messages: [system()], tools: [] }, {
    ...baseConfig(), prepareRequest: () => { throw Error('Canonical context unavailable'); },
  }, (event) => events.push(event), undefined, () => {
    requests++;
    return emitMessage(message([{ type: 'text', text: 'impossible' }]));
  }), /Canonical context unavailable/);
  assert.equal(requests, 0);
  assert.equal(events.some((event) => event.type === 'agent_end'), false);
});

test('aborted stream reaches an aborted terminal message without dispatching a tool', async () => {
  const controller = new AbortController(), events = [];
  let effects = 0;
  const streamFn = (_model, _context, options) => {
    assert.equal(options.signal, controller.signal);
    const response = { ...message([], 'aborted'), errorMessage: 'Fixture cancelled' };
    controller.abort();
    return emitMessage(response);
  };
  const messages = await runAgentLoop([prompt()], { messages: [system()], tools: [tool(async () => { effects++; return success(); })] },
    baseConfig(), (event) => events.push(event), controller.signal, streamFn);
  assert.equal(messages.at(-1).stopReason, 'aborted');
  assert.equal(effects, 0);
  assert.equal(events.at(-1).type, 'agent_end');
});

test('the injected loop continues beyond twenty requests without an implicit step ceiling', async () => {
  let requests = 0, effects = 0;
  await runAgentLoop([prompt()], { messages: [system()], tools: [tool(async () => { effects++; return success(); })] },
    baseConfig(), () => {}, undefined, () => {
      requests++;
      return emitMessage(requests < 25 ? message([call(`call-${requests}`)], 'toolUse') : message([{ type: 'text', text: 'done' }]));
    });
  assert.equal(requests, 25);
  assert.equal(effects, 24);
});
