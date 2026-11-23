import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PiAgentLoopRunner } from '../adapters/agents/pi-loop.ts';
import { FileManagedSessions } from '../adapters/files/managed-sessions.ts';
import { createBuiltinExecutionActions } from '../adapters/workflows/actions.ts';
import { ManagedAgentRuntime } from '../core/managed-runtime.ts';
import type { ManagedRuntimeOptions } from '../core/managed-runtime-options.ts';
import type { ManagedSession } from '../core/model-ports.ts';
import type { ProjectRegistry } from '../core/ports.ts';
import type { ModelProvider } from '../agent/contracts/model.ts';
import {
  contextWorkSegmentPolicy,
  type SegmentEvidence,
  type WorkSegmentPolicy,
} from '../core/work-segments.ts';

const evidence = (): SegmentEvidence => ({
  version: 1,
  baseCommit: 'a'.repeat(40),
  headCommit: 'a'.repeat(40),
  workspaceFingerprint: 'b'.repeat(64),
  files: [],
});
const originalGoal =
  'ORIGINAL_COMPLETE_GOAL: preserve every criterion, protected checks and actual acceptance authority.';
const packet = (index: number) =>
  JSON.stringify({
    currentGoal: originalGoal,
    revision: index,
    currentPlan: [
      'Inspect source',
      'Implement correction',
      'Use actual checks and independent review',
    ],
    currentChecks: { revision: 'tree-' + index, passed: false },
    currentReview: { revision: 'tree-' + index, verdict: 'changes_requested' },
    specialistCatalog: [{ id: 'queue_specialist', version: 1 }],
    currentGrants: [
      { id: 'assignment-1', roleId: 'queue_specialist', task: 'Preserve priority zero' },
    ],
    lastServiceObservation: 'SERVICE_RECEIPT_' + index + ': ' + 'Observed evidence. '.repeat(60),
  });
type Request = Parameters<ModelProvider['complete']>[0];

async function fixture(
  t: any,
  options: {
    policy?: WorkSegmentPolicy;
    omitUsage?: boolean;
    useTool?: boolean;
    separateLongNote?: boolean;
    serviceActionOnClosure?: boolean;
    script?: (input: Request, index: number) => Awaited<ReturnType<ModelProvider['complete']>>;
    onExecute?: (index: number) => { content: string };
    observe?: () => SegmentEvidence;
  } = {},
) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-coordinator-windows-')),
  );
  const files = new FileManagedSessions(directory);
  const requests: Request[] = [];
  const saves: ManagedSession[] = [];
  let serial = 0;
  let failRollover = false;
  let observed = evidence();
  let toolCalls = 0;
  const settings: ManagedRuntimeOptions = {
    id: 'coordinator-window-runtime',
    model: 'controlled-model',
    loopRunner: new PiAgentLoopRunner(),
    idGenerator: () => String(++serial),
    projects: {
      get: () => ({
        snapshot: () => ({
          project: { id: 'p', root: directory },
          profile: {
            scope: { mode: 'strict', plannedPaths: ['src/queue.mjs'], protectedPaths: ['checks/'] },
          },
          runs: [{ id: 'R-coordination', workspace: directory, baseCommit: 'a'.repeat(40) }],
          contextMaterials: [],
        }),
      }),
    } as unknown as ProjectRegistry,
    limits: {
      contextTokens: 16384,
      maxOutputTokens: 2048,
      maxRequestsPerTurn: 8,
      maxToolCallsPerTurn: 8,
      maxSessionRequests: 100,
    },
    segmentPolicy: options.policy || contextWorkSegmentPolicy,
    segmentEvidence: {
      async inspect() {
        return structuredClone(options.observe ? options.observe() : observed);
      },
    },
    sessions: {
      load: (id) => files.load(id),
      async save(next) {
        const prior = await files.load(next.id);
        if (
          failRollover &&
          (next.workSegments?.archives.length || 0) > (prior?.workSegments?.archives.length || 0)
        )
          throw new Error('INJECTED_ARCHIVE_SAVE_FAILURE');
        await files.save(next);
        saves.push(structuredClone(next));
      },
    },
    tools: {
      revision: 'coordinator-window-tools-v1',
      effect: () => 'read',
      definitions: () => [
        {
          name: 'read_file',
          description: 'Read assigned source',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
            additionalProperties: false,
          },
        },
      ],
      async execute() {
        toolCalls++;
        return options.onExecute
          ? options.onExecute(toolCalls)
          : { content: 'ACTUAL_READ_RECEIPT: priorityOf preserves zero.' };
      },
    },
    provider: {
      id: 'coordinator-window-provider',
      revision: 'v1',
      local: true,
      structuredOutputMode: 'schema',
      ...(options.separateLongNote ? { structuredToolMode: 'separate-turn' as const } : {}),
      async complete(input) {
        requests.push(
          structuredClone({
            ...input,
            signal: undefined,
            onProgress: undefined,
            onEvent: undefined,
          }) as unknown as Request,
        );
        if (options.script) return options.script(input, requests.length);
        if (options.useTool && requests.length === 1)
          return {
            model: 'controlled-model',
            finish: 'tools',
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [
                { id: 'actual-read', name: 'read_file', arguments: { path: 'src/queue.mjs' } },
              ],
              continuation: { private: 'OPAQUE_TOOL_CONTINUATION' },
            },
          };
        if (options.separateLongNote && !input.schema)
          return {
            model: 'controlled-model',
            finish: 'stop',
            ...(!options.omitUsage ? { usage: { inputTokens: 15000, outputTokens: 200 } } : {}),
            message: {
              role: 'assistant',
              content: 'LONG_PRIVATE_COMPLETION_NOTE: ' + 'Observed source detail. '.repeat(380),
              continuation: { private: 'OPAQUE_LONG_NOTE' },
            },
          };
        if (options.separateLongNote && (input.schema as any)?.properties?.nextTask)
          return {
            model: 'controlled-model',
            finish: 'stop',
            ...(!options.omitUsage ? { usage: { inputTokens: 15000, outputTokens: 200 } } : {}),
            message: {
              role: 'assistant',
              content: JSON.stringify(
                options.serviceActionOnClosure &&
                  !input.messages.some((message) =>
                    message.content.includes(
                      'ready to choose ANY registered service action, even when the overall goal remains unfinished',
                    ),
                  )
                  ? {
                      status: 'continue',
                      nextTask: 'Request fresh independent review of the current work.',
                    }
                  : { status: 'complete', nextTask: '' },
              ),
            },
          };
        return {
          model: 'controlled-model',
          finish: 'stop',
          ...(!options.omitUsage ? { usage: { inputTokens: 15000, outputTokens: 200 } } : {}),
          message: {
            role: 'assistant',
            content: JSON.stringify({
              decision: options.serviceActionOnClosure
                ? {
                    action: 'review',
                    input: {
                      result: {
                        status: 'success',
                        summary: 'Candidate is ready for actual service review.',
                        artifacts: ['src/queue.mjs'],
                        notesForNextAgent:
                          'The goal still needs independent review and acceptance.',
                      },
                    },
                  }
                : { action: 'plan', input: { summary: 'Observed plan. '.repeat(50), steps: [] } },
            }),
            continuation: { private: 'OPAQUE_RESPONSE_' + requests.length },
          },
        };
      },
    },
  };
  const runtimes: ManagedAgentRuntime[] = [];
  const make = () => {
    const runtime = new ManagedAgentRuntime(settings);
    runtimes.push(runtime);
    return runtime;
  };
  const start = {
    projectId: 'p',
    runId: 'R-coordination',
    purpose: 'coordination' as const,
    workspace: directory,
    instructions:
      'Choose actions from actual evidence and the current complete goal packet. Never change permissions or certify acceptance yourself.',
  };
  const runtime = make();
  const { threadId } = await runtime.start(start);
  const turn = (active: ManagedAgentRuntime, index: number) =>
    active.turn(threadId, packet(index), {
      schema: createBuiltinExecutionActions().outputSchema(),
      signal: new AbortController().signal,
      timeoutMs: 5000,
    });
  t.after(async () => {
    await Promise.all(runtimes.map((item) => item.dispose()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    files,
    runtime,
    make,
    start,
    threadId,
    turn,
    requests,
    saves,
    failRollover(value: boolean) {
      failRollover = value;
    },
    changeEvidence(value: SegmentEvidence) {
      observed = value;
    },
    toolCalls: () => toolCalls,
  };
}

test('action-only coordinator turns rotate by server-reported context, keep all history and current state across more than sixteen windows', async (t) => {
  const f = await fixture(t);
  const turns = 60;
  for (let index = 1; index <= turns; index++) await f.turn(f.runtime, index);
  const saved = (await f.files.load(f.threadId))!;
  assert.equal(
    f.requests.length,
    turns,
    'No extra model closure is needed between settled service turns.',
  );
  assert.equal(f.toolCalls(), 0);
  assert.equal(saved.assignment, undefined);
  assert.equal(saved.workSegments?.limits.maxSegments, undefined);
  assert.ok(saved.workSegments!.archives.length > 16);
  assert.equal(saved.workSegments!.active.toolRounds, 0);
  assert.equal(saved.requests, turns);
  assert.equal(saved.turnAuthorities?.length, turns);
  const allMessages = [
    ...saved.workSegments!.archives.flatMap((archive) => archive.messages),
    ...saved.messages,
  ];
  for (let index = 1; index <= turns; index++)
    assert.ok(
      allMessages.some((message) => message.content === packet(index)),
      'The complete exact packet remains durable: ' + index,
    );
  for (const archive of saved.workSegments!.archives) {
    assert.equal(archive.handoff.kind, 'service-turn');
    assert.equal(archive.messages.at(-1)?.role, 'assistant');
    assert.match(JSON.stringify(archive.messages), /OPAQUE_RESPONSE_/);
  }
  const currentRequest = f.requests.at(-1)!;
  assert.doesNotMatch(currentRequest.messages[0].content, /ORIGINAL_COMPLETE_GOAL/);
  assert.match(JSON.stringify(currentRequest.messages), /ORIGINAL_COMPLETE_GOAL/);
  assert.ok(currentRequest.messages.some((message) => message.content.startsWith(packet(turns))));
  assert.equal(currentRequest.maxOutputTokens, 2048);
  await f.runtime.release(f.threadId);
  const reloaded = f.make();
  await reloaded.resume({ ...f.start, threadId: f.threadId });
  await f.turn(reloaded, turns + 1);
  const afterReload = (await new FileManagedSessions(f.directory).load(f.threadId))!;
  assert.deepEqual(
    afterReload.workSegments!.archives.slice(0, saved.workSegments!.archives.length),
    saved.workSegments!.archives,
  );
  assert.equal(afterReload.requests, turns + 1);
});

test('coordinator windows preserve real tool receipts and private continuation without replaying a tool', async (t) => {
  const f = await fixture(t, { useTool: true });
  for (let index = 1; index <= 6; index++) await f.turn(f.runtime, index);
  const saved = (await f.files.load(f.threadId))!;
  assert.equal(f.toolCalls(), 1);
  assert.ok(saved.workSegments!.archives.length > 0);
  const first = saved.workSegments!.archives[0];
  assert.match(JSON.stringify(first.messages), /OPAQUE_TOOL_CONTINUATION/);
  assert.equal(
    first.handoff.receipts?.[0].output,
    'ACTUAL_READ_RECEIPT: priorityOf preserves zero.',
  );
  assert.equal(saved.actions.length, 1);
  assert.equal(saved.actions[0].status, 'completed');
});

test('the full action grammar can finalize a long tool-phase note through a safe final-format archive at 16K', async (t) => {
  const f = await fixture(t, { useTool: true, separateLongNote: true });
  const result = await f.turn(f.runtime, 1);
  assert.equal(JSON.parse(result.text).decision.action, 'plan');
  const saved = (await f.files.load(f.threadId))!;
  assert.equal(
    f.requests.length,
    4,
    'One real read, a work note, a small closing reply and the formal action.',
  );
  assert.equal(f.toolCalls(), 1);
  assert.equal(saved.workSegments!.archives.length, 1);
  const archive = saved.workSegments!.archives[0];
  assert.equal(archive.handoff.kind, 'final-format');
  assert.match(JSON.stringify(archive.messages), /LONG_PRIVATE_COMPLETION_NOTE/);
  assert.match(JSON.stringify(archive.messages), /OPAQUE_LONG_NOTE/);
  assert.deepEqual(JSON.parse(archive.messages.at(-1)!.content), {
    status: 'complete',
    nextTask: '',
  });
  const finalRequest = f.requests.at(-1)!;
  assert.equal(finalRequest.tools.length, 0);
  assert.equal(finalRequest.maxOutputTokens, 2048);
  assert.ok(
    JSON.stringify(finalRequest.schema).length > 4000,
    'Use the actual complete six-action grammar.',
  );
  assert.match(JSON.stringify(finalRequest.messages), /ACTUAL_READ_RECEIPT/);
  assert.doesNotMatch(JSON.stringify(finalRequest.messages), /LONG_PRIVATE_COMPLETION_NOTE/);
  assert.doesNotMatch(finalRequest.messages[0].content, /ORIGINAL_COMPLETE_GOAL/);
  assert.match(JSON.stringify(finalRequest.messages), /ORIGINAL_COMPLETE_GOAL/);
  assert.ok(finalRequest.messages.some((message) => message.content.startsWith(packet(1))));
  assert.match(f.requests[0].messages.at(-1)!.content, /the overall goal need not be complete/);
  assert.deepEqual(await new FileManagedSessions(f.directory).load(f.threadId), saved);
});

test('a coordinator closes repository work to choose a service action while the overall goal remains unfinished', async (t) => {
  const f = await fixture(t, {
    useTool: true,
    separateLongNote: true,
    serviceActionOnClosure: true,
  });
  const result = JSON.parse((await f.turn(f.runtime, 1)).text);
  assert.equal(result.decision.action, 'review');
  assert.match(
    result.decision.input.result.notesForNextAgent,
    /still needs independent review and acceptance/,
  );
  assert.equal(f.requests.length, 4);
  assert.equal(
    f.toolCalls(),
    1,
    'Closing to choose an action must not restart repository tool work.',
  );
  const closing = f.requests.find((request) => (request.schema as any)?.properties?.nextTask)!;
  assert.ok(closing);
  assert.match(
    JSON.stringify(closing.messages),
    /ready to choose ANY registered service action, even when the overall goal remains unfinished/,
  );
  const saved = (await f.files.load(f.threadId))!;
  const archive = saved.workSegments!.archives[0];
  assert.deepEqual(JSON.parse(archive.messages.at(-1)!.content), {
    status: 'complete',
    nextTask: '',
  });
  assert.equal(archive.handoff.kind, 'final-format');
  assert.ok(saved.messages.some((message) => message.content === packet(1)));
});

test('a failed archive save sends no model request and leaves the settled durable checkpoint unchanged', async (t) => {
  const f = await fixture(t);
  let before: ManagedSession;
  let count = 0;
  f.failRollover(true);
  for (let index = 1; ; index++) {
    before = (await f.files.load(f.threadId))!;
    count = f.requests.length;
    try {
      await f.turn(f.runtime, index);
    } catch (error) {
      assert.match(String(error), /INJECTED_ARCHIVE_SAVE_FAILURE/);
      break;
    }
    assert.ok(index < 20, 'A physical rollover should eventually be needed.');
  }
  assert.equal(f.requests.length, count);
  assert.deepEqual(await f.files.load(f.threadId), before!);
  f.failRollover(false);
  await f.turn(f.runtime, 99);
  assert.equal(f.requests.length, count + 1, 'Cached state was not advanced by the failed save.');
});

test('workspace identity changes and explicit optional segment quotas block a coordinator rollover before inference', async (t) => {
  const bounded = {
    ...contextWorkSegmentPolicy,
    limits: { ...contextWorkSegmentPolicy.limits, maxSegments: 1 },
  };
  const f = await fixture(t, { policy: bounded });
  let count = 0;
  for (let index = 1; ; index++) {
    count = f.requests.length;
    try {
      await f.turn(f.runtime, index);
    } catch (error) {
      assert.equal((error as any).code, 'WORK_SEGMENT_LIMIT');
      break;
    }
    assert.ok(index < 20);
  }
  assert.equal(f.requests.length, count);
  const g = await fixture(t);
  g.changeEvidence({ ...evidence(), headCommit: 'c'.repeat(40) });
  // The first baseline belongs to the original immutable Git identity.
  g.changeEvidence(evidence());
  await g.turn(g.runtime, 1);
  g.changeEvidence({ ...evidence(), headCommit: 'c'.repeat(40) });
  for (let index = 2; ; index++) {
    count = g.requests.length;
    try {
      await g.turn(g.runtime, index);
    } catch (error) {
      assert.equal((error as any).code, 'SEGMENT_SCOPE_CHANGED');
      break;
    }
    assert.ok(index < 20);
  }
  assert.equal(g.requests.length, count);
});

test('File authority rejects forged service-turn archives with dropped history, altered grants or unsettled predecessor state', async (t) => {
  const f = await fixture(t);
  for (let index = 1; index <= 5; index++) await f.turn(f.runtime, index);
  const position = f.saves.findIndex(
    (next, index) =>
      index > 0 &&
      next.workSegments!.archives.length > (f.saves[index - 1].workSegments?.archives.length || 0),
  );
  assert.ok(position > 0);
  const before = f.saves[position - 1];
  const after = f.saves[position];
  for (const mutate of [
    (value: ManagedSession) => {
      value.workSegments!.archives.at(-1)!.messages.splice(1, 1);
    },
    (value: ManagedSession) => {
      value.scope.writeScope.plannedPaths = ['.'];
    },
    (value: ManagedSession) => {
      value.generation!.outcome = 'unknown';
    },
    (value: ManagedSession) => {
      value.cancelRequested = true;
    },
    (value: ManagedSession) => {
      value.workSegments!.anchor.turnId = before.workSegments!.anchor.turnId;
    },
    (value: ManagedSession) => {
      value.messages.at(-1)!.content = 'A forged packet missing the actual goal';
    },
  ]) {
    const directory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'buro-forged-service-window-')),
    );
    try {
      const store = new FileManagedSessions(directory);
      await store.save(before);
      const forged = structuredClone(after);
      mutate(forged);
      await assert.rejects(async () => store.save(forged));
      assert.deepEqual(await store.load(before.id), before);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
  for (const status of ['running', 'failed'] as const) {
    const directory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'buro-unsettled-service-window-')),
    );
    try {
      const store = new FileManagedSessions(directory);
      await store.save({ ...before, status });
      await assert.rejects(store.save(after));
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
});

const repeatedRead = (index: number) => ({
  model: 'controlled-model',
  finish: 'tools' as const,
  message: {
    role: 'assistant' as const,
    content: '',
    toolCalls: [{ id: 'repeat-' + index, name: 'read_file', arguments: { path: 'src/queue.mjs' } }],
  },
});
const serviceReview = () => ({
  model: 'controlled-model',
  finish: 'stop' as const,
  message: {
    role: 'assistant' as const,
    content: JSON.stringify({
      decision: {
        action: 'review',
        input: {
          result: {
            status: 'success',
            summary: 'Request actual independent review.',
            artifacts: ['src/queue.mjs'],
            notesForNextAgent: 'Acceptance remains unverified.',
          },
        },
      },
    }),
  },
});

test('identical settled coordinator receipts on an unchanged workspace request a service decision without implying acceptance', async (t) => {
  const f = await fixture(t, {
    separateLongNote: true,
    script(input, index) {
      if (!input.schema) return repeatedRead(index);
      assert.equal(index, 4);
      assert.deepEqual(input.tools, []);
      assert.match(input.messages.at(-1)!.content, /same results repeatedly/);
      assert.match(input.messages.at(-1)!.content, /do not certify completion/);
      return serviceReview();
    },
  });
  const result = await f.turn(f.runtime, 1);
  assert.equal(JSON.parse(result.text).decision.action, 'review');
  const saved = (await f.files.load(f.threadId))!;
  assert.equal(f.toolCalls(), 3);
  assert.equal(saved.requests, 4);
  assert.equal(saved.actions.length, 3);
  assert.ok(saved.actions.every((action) => action.status === 'completed' && action.result));
  assert.equal(saved.status, 'ready');
  assert.equal(saved.generation!.outcome, 'completed');
  assert.equal(saved.messages.filter((message) => message.role === 'tool').length, 3);
  // Another service turn gets its own observations rather than inheriting a stalled streak.
  await f.runtime.release(f.threadId);
  const resumed = f.make();
  await resumed.resume({ ...f.start, threadId: f.threadId });
  assert.deepEqual((await f.files.load(f.threadId))!.actions, saved.actions);
});

for (const progress of ['output', 'workspace', 'arguments'] as const)
  test('coordinator repeated tools retain useful progress in ' + progress, async (t) => {
    let executed = 0;
    const f = await fixture(t, {
      separateLongNote: true,
      script(input, index) {
        if (!input.schema && index <= 5) {
          const response = repeatedRead(index);
          if (progress === 'arguments')
            response.message.toolCalls[0].arguments.path = 'src/' + index + '.mjs';
          return response;
        }
        if (!input.schema)
          return {
            ...serviceReview(),
            message: { role: 'assistant', content: 'Ready for the next action.' },
          };
        assert.equal(index, 7, 'Five useful rounds and a completion note precede serialization.');
        return serviceReview();
      },
      onExecute(index) {
        executed = index;
        return { content: progress === 'output' ? 'OBSERVATION_' + index : 'same output' };
      },
      observe() {
        return {
          ...evidence(),
          workspaceFingerprint:
            progress === 'workspace' ? String(executed).padStart(64, '0') : 'b'.repeat(64),
        };
      },
    });
    await f.turn(f.runtime, 1);
    assert.equal(f.toolCalls(), 5);
    assert.equal(f.requests.length, 7);
  });

test('large coordinator text without server usage does not trigger invented context rotation', async (t) => {
  const f = await fixture(t, { omitUsage: true });
  for (let index = 1; index <= 6; index++) await f.turn(f.runtime, index);
  const saved = (await f.files.load(f.threadId))!;
  assert.equal(saved.workSegments!.archives.length, 0);
  assert.equal(f.requests.length, 6);
  assert.ok(f.requests.every((request) => request.maxOutputTokens === 2048));
});
