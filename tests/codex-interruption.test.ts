import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { CodexRuntime } from '../adapters/codex/runtime.ts';
import type { ProjectRegistry, RuntimeEvent } from '../core/ports.ts';

// Separate protocol fixture: the normal fake-codex behavior remains unchanged.
const server = String.raw`
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
const input = readline.createInterface({ input: process.stdin });
const timers = new Set();
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const later = (fn, ms) => {
  const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
  timers.add(timer);
};
input.on('close', () => { for (const timer of timers) clearTimeout(timer); });
input.on('line', (line) => {
  const request = JSON.parse(line);
  appendFileSync(process.argv[2], JSON.stringify(request) + '\n');
  const reply = (result) => send({ id: request.id, result });
  if (request.method === 'initialize') reply({ serverInfo: 'interruption-fixture' });
  else if (request.method === 'thread/start') reply({ thread: { id: 'native-thread' } });
  else if (request.method === 'thread/resume') reply({ thread: { id: request.params.threadId } });
  else if (request.method === 'turn/interrupt') {
    reply({});
    send({ method: 'turn/completed', params: {
      threadId: request.params.threadId,
      turn: { id: request.params.turnId, status: 'interrupted' },
    }});
  } else if (request.method === 'turn/start') {
    const threadId = request.params.threadId;
    const mode = request.params.input[0].text;
    const turn = { id: 'native-turn', status: 'completed' };
    if (mode === 'cancel-before-reply') {
      send({ method: 'fixture/awaitingReply', params: { threadId } });
      later(() => reply({ turn }), 5000);
      return;
    }
    if (mode === 'stale-completion-before-ack') {
      send({ method: 'turn/completed', params: {
        threadId, turn: { id: 'old-turn', status: 'completed' },
      }});
      later(() => {
        reply({ turn });
        send({ method: 'item/completed', params: {
          threadId, turnId: turn.id, item: { id: 'fresh-answer', type: 'agentMessage', text: 'fresh accepted answer' },
        }});
        send({ method: 'turn/completed', params: { threadId, turn }});
      }, 30);
      return;
    }
    if (mode === 'stale-answer-before-ack') {
      send({ method: 'item/completed', params: {
        threadId, turnId: 'old-turn', item: { id: 'old-answer', type: 'agentMessage', text: '{"status":"success"}' },
      }});
      send({ method: 'turn/completed', params: { threadId, turn: { id: 'old-turn', status: 'completed' } }});
      later(() => {
        reply({ turn });
        send({ method: 'turn/completed', params: { threadId, turn }});
      }, 30);
      return;
    }
    reply({ turn });
    send({ method: 'turn/started', params: { threadId, turn } });
    if (mode === 'cancel-known') return;
    send({ method: 'item/completed', params: {
      threadId, turnId: turn.id, item: { id: 'answer', type: 'agentMessage', text: mode === 'partial-exit' ? 'partial visible answer' : 'resumed answer' },
    }});
    if (mode === 'partial-exit') later(() => process.exit(17), 20);
    else send({ method: 'turn/completed', params: { threadId, turn } });
  }
});
`;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, milliseconds = 750): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Error('Operation did not settle within local bound.')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fixture(t: any) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'codex-interruption-')),
  );
  const program = path.join(directory, 'app-server.mjs');
  const log = path.join(directory, 'requests.jsonl');
  await fs.writeFile(program, server);
  await fs.writeFile(log, '');
  const known = deferred(),
    awaitingReply = deferred(),
    visibleAnswer = deferred();
  const events: RuntimeEvent[] = [];
  const runtime = new CodexRuntime({
    id: 'codex',
    projects: {
      get: () => ({ snapshot: () => ({ project: { root: directory } }) }),
    } as unknown as ProjectRegistry,
    executable: process.execPath,
    args: [program, log],
    onEvent(event) {
      if (event.method === 'turn/started') known.resolve();
      if (event.method === 'fixture/awaitingReply') awaitingReply.resolve();
    },
  });
  runtime.subscribe((event) => {
    events.push(event);
    if (event.type === 'message.completed') visibleAnswer.resolve();
  });
  t.after(async () => {
    await bounded(runtime.dispose(), 2000);
    await fs.rm(directory, { recursive: true, force: true });
  });
  const { threadId } = await runtime.start({
    projectId: 'p',
    runId: 'R-native',
    instructions: 'Fixture',
  });
  const requests = async () =>
    (await fs.readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return { directory, runtime, threadId, known, awaitingReply, visibleAnswer, events, requests };
}

test(
  'native Codex cancellation interrupts a known turn once and explicit resume keeps the thread',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const controller = new AbortController();
    const turn = f.runtime.turn(f.threadId, 'cancel-known', {
      schema: {},
      signal: controller.signal,
      timeoutMs: 10000,
    });
    const rejected = assert.rejects(turn, { name: 'AbortError' });
    await bounded(f.known.promise);
    await immediate();
    controller.abort();
    await bounded(rejected);
    await bounded(f.runtime.release(f.threadId), 1500);
    const cancelled = await f.requests();
    assert.equal(cancelled.filter((request) => request.method === 'turn/start').length, 1);
    assert.deepEqual(cancelled.find((request) => request.method === 'turn/interrupt')?.params, {
      threadId: f.threadId,
      turnId: 'native-turn',
    });
    assert.equal(
      f.events.some((event) => event.type === 'turn.completed' && event.status === 'completed'),
      false,
    );

    const resumed = await f.runtime.resume({
      projectId: 'p',
      threadId: f.threadId,
      workspace: f.directory,
      runId: 'R-native',
      instructions: 'Continue saved work',
    });
    assert.equal(resumed.threadId, f.threadId);
    const result = await bounded(
      f.runtime.turn(resumed.threadId, 'resume-success', {
        schema: {},
        signal: new AbortController().signal,
        timeoutMs: 10000,
      }),
    );
    assert.equal(result.text, 'resumed answer');
    const requests = await f.requests();
    assert.deepEqual(
      requests.find((request) => request.method === 'thread/resume')?.params.threadId,
      f.threadId,
    );
    assert.equal(requests.filter((request) => request.method === 'turn/start').length, 2);
  },
);

test(
  'native Codex cancellation before turn/start reply settles without awaiting the RPC timeout',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const controller = new AbortController();
    const turn = f.runtime.turn(f.threadId, 'cancel-before-reply', {
      schema: {},
      signal: controller.signal,
      timeoutMs: 10000,
    });
    // Attach a rejection handler before abort/cleanup so the deliberately delayed RPC cannot leak a rejection.
    const outcome = turn.then(
      () => 'completed',
      (error) => error.code,
    );
    await bounded(f.awaitingReply.promise);
    controller.abort();
    assert.equal(await bounded(outcome), 'SESSION_RECONCILIATION_REQUIRED');
    assert.equal(f.runtime.get(f.threadId).pending.size, 0);
    await assert.rejects(f.runtime.submit(f.threadId, 'no blind retry'), /closed/);
    await bounded(f.runtime.release(f.threadId), 1500);
    const requests = await f.requests();
    assert.equal(requests.filter((request) => request.method === 'turn/start').length, 1);
    assert.equal(requests.filter((request) => request.method === 'turn/interrupt').length, 0);
    assert.equal(
      f.events.some((event) => event.type === 'turn.completed' && event.status === 'completed'),
      false,
    );
    const resumed = await f.runtime.resume({
      projectId: 'p',
      threadId: f.threadId,
      workspace: f.directory,
      runId: 'R-native',
      instructions: 'Explicitly continue saved work',
    });
    assert.equal(resumed.threadId, f.threadId);
    const result = await bounded(
      f.runtime.turn(resumed.threadId, 'resume-success', {
        schema: {},
        signal: new AbortController().signal,
        timeoutMs: 10000,
      }),
    );
    assert.equal(result.text, 'resumed answer');
    assert.equal(
      (await f.requests()).filter((request) => request.method === 'turn/start').length,
      2,
    );
  },
);

test('a stale native completion before the start acknowledgement cannot complete the new turn', async (t) => {
  const f = await fixture(t);
  const result = await f.runtime.turn(f.threadId, 'stale-completion-before-ack', {
    schema: {},
    signal: new AbortController().signal,
    timeoutMs: 1000,
  });
  assert.equal(result.turnId, 'native-turn');
  assert.equal(result.text, 'fresh accepted answer');
});

test('a stale native answer cannot become the result of a new turn without its own answer', async (t) => {
  const f = await fixture(t);
  const result = await f.runtime.turn(f.threadId, 'stale-answer-before-ack', {
    schema: {},
    signal: new AbortController().signal,
    timeoutMs: 1000,
  });
  assert.equal(result.turnId, 'native-turn');
  assert.equal(result.text, '');
});

test(
  'native Codex already-aborted signals never submit a turn request',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      f.runtime.turn(f.threadId, 'cancel-known', {
        schema: {},
        signal: controller.signal,
        timeoutMs: 10000,
      }),
      { name: 'AbortError' },
    );
    assert.equal(f.runtime.get(f.threadId).pending.size, 0);
    await bounded(f.runtime.release(f.threadId), 1500);
    assert.equal(
      (await f.requests()).filter((request) => request.method === 'turn/start').length,
      0,
    );
  },
);

test(
  'native Codex child exit after a visible answer rejects the turn without retry or success',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const turn = f.runtime.turn(f.threadId, 'partial-exit', {
      schema: {},
      signal: new AbortController().signal,
      timeoutMs: 10000,
    });
    const rejected = assert.rejects(turn, { code: 'SESSION_RECONCILIATION_REQUIRED' });
    await bounded(f.visibleAnswer.promise);
    await bounded(rejected);
    assert.ok(
      f.events.some(
        (event) => event.type === 'message.completed' && event.text === 'partial visible answer',
      ),
    );
    assert.equal(
      f.events.some((event) => event.type === 'turn.completed' && event.status === 'completed'),
      false,
    );
    assert.equal(
      (await f.requests()).filter((request) => request.method === 'turn/start').length,
      1,
    );
    await bounded(f.runtime.release(f.threadId), 1500);
  },
);
