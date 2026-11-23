import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ManagedSession } from '../core/model-ports.ts';
import { FileManagedSessions } from '../adapters/files/managed-sessions.ts';
import {
  segmentActionReceipts,
  segmentClosingInstruction,
  segmentMessages,
  type SegmentEvidence,
} from '../core/work-segments.ts';
import { testBoundedWorkSegmentPolicy as boundedWorkSegmentPolicy } from './fixtures/work-segment-policy.ts';

const evidence = (): SegmentEvidence => ({
  version: 1,
  baseCommit: 'a'.repeat(40),
  headCommit: 'a'.repeat(40),
  workspaceFingerprint: 'b'.repeat(64),
  files: [{ path: 'src/owned.ts', fingerprint: 'c'.repeat(64) }],
});
function checkpoint(): ManagedSession {
  const scope = {
    projectId: 'p',
    runId: 'R-owner',
    ownerRunId: 'R-owner',
    sessionId: 'S-worker',
    workspace: '/workspace',
    readOnly: false,
    writeScope: { mode: 'strict', plannedPaths: ['src/owned.ts'], protectedPaths: ['checks/'] },
    materials: [],
    commands: [],
    baseCommit: 'a'.repeat(40),
  };
  const call = { id: 'call-1', name: 'read_file', arguments: { path: 'src/owned.ts' } };
  const anchor = {
    turnId: 'T-first',
    instructions: 'Keep every acceptance criterion and edit only the assigned file.',
    task: 'Repair the bounded assignment.',
    scopeRevision: 1,
  };
  return {
    version: 1,
    id: 'M-test',
    runtimeId: 'managed',
    limits: {
      contextTokens: 32768,
      maxOutputTokens: 1024,
      maxRequestsPerTurn: 12,
      maxToolCallsPerTurn: 24,
      maxSessionRequests: 64,
    },
    providerId: 'ollama-rtx',
    providerRevision: 'frozen',
    toolRevision: 'fixture-tools-v1',
    requestedModel: 'small-fixture',
    purpose: 'implementation',
    scope,
    assignment: {
      roleId: 'builder',
      scope: structuredClone(scope.writeScope),
    },
    scopeRevisions: [
      { revision: 1, scope: structuredClone(scope), instructions: anchor.instructions },
    ],
    turnAuthorities: [
      { turnId: anchor.turnId, toolPolicy: 'normal', startedAtRequest: 0, scopeRevision: 1 },
    ],
    messages: [
      { role: 'system', content: anchor.instructions },
      { role: 'user', content: anchor.task },
      {
        role: 'assistant',
        content: '',
        toolCalls: [call],
        continuation: { opaque: 'PRIVATE_TOOL_CONTINUATION' },
      },
      { role: 'tool', content: 'Observed source', toolCallId: call.id, toolName: call.name },
      { role: 'user', content: segmentClosingInstruction },
    ],
    status: 'running',
    requests: 2,
    usage: { requestsWithUsage: 2, inputTokens: 20, outputTokens: 10 },
    actions: [
      {
        id: 'A-once',
        turnId: anchor.turnId,
        call,
        status: 'completed',
        result: { content: 'Observed source' },
      },
    ],
    generation: { requestId: 'T-first:1', outcome: 'completed' },
    workSegments: {
      version: 1,
      limits: structuredClone(boundedWorkSegmentPolicy.limits),
      baseline: evidence(),
      anchor,
      active: { index: 1, startedAtRequest: 0, toolRounds: 1 },
      archives: [],
    },
  };
}
function rotated(previous: ManagedSession): ManagedSession {
  const next = structuredClone(previous),
    state = next.workSegments!;
  const handoff = {
    version: 1 as const,
    nextTask: 'Inspect the remaining edge case.',
    evidence: evidence(),
    completedActions: next.actions.length,
  };
  state.archives.push({
    index: state.active.index,
    anchor: structuredClone(state.anchor),
    startedAtRequest: state.active.startedAtRequest,
    endedAtRequest: next.requests,
    messages: [
      ...next.messages,
      {
        role: 'assistant',
        content: JSON.stringify({ status: 'continue', nextTask: handoff.nextTask }),
        continuation: { opaque: 'PRIVATE_CLOSING_CONTINUATION' },
      },
    ],
    handoff,
  });
  state.active = { index: state.active.index + 1, startedAtRequest: next.requests, toolRounds: 0 };
  next.messages = segmentMessages(state.anchor, next.scope, handoff);
  delete next.intermediateNotes;
  return next;
}
async function fixture(t: any) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-segment-checkpoints-')),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return {
    directory,
    sessions: new FileManagedSessions(directory),
    filename: path.join(directory, 'M-test.json'),
  };
}
const rejects = (action: () => unknown) => assert.rejects(async () => action());

test('current nonsegmented checkpoints retain provider continuation without opting into segmentation', async (t) => {
  const f = await fixture(t),
    current = checkpoint();
  delete current.workSegments;
  delete current.generation;
  await f.sessions.save(current);
  const restored = await new FileManagedSessions(f.directory).load(current.id);
  assert.deepEqual(restored, current);
  assert.equal(restored?.workSegments, undefined);
});

test('one atomic checkpoint retains archived tool results, opaque continuation and the fresh active window', async (t) => {
  const f = await fixture(t),
    original = checkpoint();
  await f.sessions.save(original);
  const next = rotated(original);
  await f.sessions.save(next);
  const restored = (await new FileManagedSessions(f.directory).load(next.id))!;
  assert.deepEqual(restored, next);
  assert.deepEqual(restored.actions, original.actions);
  assert.equal(restored.requests, original.requests);
  assert.deepEqual(restored.usage, original.usage);
  assert.deepEqual(restored.workSegments?.archives[0].messages[2].continuation, {
    opaque: 'PRIVATE_TOOL_CONTINUATION',
  });
  assert.deepEqual(restored.workSegments?.archives[0].messages.at(-1)?.continuation, {
    opaque: 'PRIVATE_CLOSING_CONTINUATION',
  });
  assert.doesNotMatch(JSON.stringify(restored.messages), /PRIVATE_/);
  assert.deepEqual(await fs.readdir(f.directory), ['M-test.json']);
  assert.equal((await fs.stat(f.filename)).mode & 0o777, 0o600);
});

test('a failed rollover journal write leaves the old context intact and permits an explicit retry', async (t) => {
  const f = await fixture(t),
    original = checkpoint();
  await f.sessions.save(original);
  const next = rotated(original);
  const handle = await fs.open(f.filename, 'r');
  const prototype = Object.getPrototypeOf(handle);
  await handle.close();
  const mock = t.mock.method(prototype, 'sync', async () => {
    throw Error('simulated journal sync failure');
  });
  await assert.rejects(f.sessions.save(next), /simulated journal sync failure/);
  mock.mock.restore();
  assert.deepEqual(await f.sessions.load(original.id), original);
  assert.deepEqual(await fs.readdir(f.directory), ['M-test.json']);
  await f.sessions.save(next);
  assert.deepEqual(await new FileManagedSessions(f.directory).load(next.id), next);
});

test('malformed archives cannot replace a valid private checkpoint or split required tool-result chains', async (t) => {
  const f = await fixture(t),
    original = checkpoint();
  await f.sessions.save(original);
  const mutations: ((value: ManagedSession) => void)[] = [
    (value) => {
      value.workSegments!.active.index = 5;
    },
    (value) => {
      value.workSegments!.archives[0].endedAtRequest = value.requests + 1;
    },
    (value) => {
      value.workSegments!.archives[0].anchor.instructions = 'replace frozen criteria';
    },
    (value) => {
      value.workSegments!.archives[0].messages.splice(3, 1);
    },
    (value) => {
      value.workSegments!.archives[0].messages[3].content = 'invented result';
    },
    (value) => {
      value.workSegments!.archives[0].messages.at(-1)!.content =
        '{"status":"complete","nextTask":""}';
    },
    (value) => {
      value.workSegments!.archives[0].handoff.nextTask = 'x'.repeat(1001);
    },
    (value) => {
      value.workSegments!.archives[0].handoff.evidence.files.push({
        path: '../escape',
        fingerprint: 'd'.repeat(64),
      });
    },
    (value) => {
      value.workSegments!.archives[0].handoff.completedActions = 0;
    },
    (value) => {
      value.actions[0].status = 'unknown';
    },
    (value) => {
      value.generation!.outcome = 'pending';
    },
    (value) => {
      value.cancelRequested = true;
    },
  ];
  for (const mutate of mutations) {
    const candidate = rotated(original);
    mutate(candidate);
    await rejects(() => f.sessions.save(candidate));
    assert.deepEqual(await f.sessions.load(original.id), original);
  }
});

test('lifetime accounting, action receipts, frozen provider settings and completed archives cannot be rewound', async (t) => {
  const f = await fixture(t),
    original = checkpoint(),
    next = rotated(original);
  await f.sessions.save(original);
  await f.sessions.save(next);
  const mutations: ((value: ManagedSession) => void)[] = [
    (value) => {
      value.requests = 0;
    },
    (value) => {
      value.usage.inputTokens = 0;
    },
    (value) => {
      value.usage.outputTokens = 0;
    },
    (value) => {
      value.usage.requestsWithUsage = 0;
    },
    (value) => {
      value.limits.maxSessionRequests++;
    },
    (value) => {
      value.providerRevision = 'replacement';
    },
    (value) => {
      value.requestedModel = 'replacement';
    },
    (value) => {
      value.purpose = 'review';
      value.scope.readOnly = true;
      delete value.assignment;
    },
    (value) => {
      value.actions = [];
    },
    (value) => {
      value.actions[0].result!.content = 'rewritten result';
    },
    (value) => {
      value.workSegments!.limits.maxSegments = value.workSegments!.limits.maxSegments! + 1;
    },
    (value) => {
      value.workSegments!.baseline.workspaceFingerprint = 'd'.repeat(64);
    },
    (value) => {
      value.workSegments!.archives[0].messages[0].content = 'rewritten history';
    },
    (value) => {
      value.workSegments!.archives[0].handoff.evidence.workspaceFingerprint = 'd'.repeat(64);
    },
    (value) => {
      delete value.workSegments;
    },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(next);
    mutate(candidate);
    await rejects(() => f.sessions.save(candidate));
    assert.deepEqual(await f.sessions.load(next.id), next);
  }
  await rejects(() => f.sessions.save(original));
});

test('unknown generation outcomes survive reopening and cannot be erased, replaced or marked completed', async (t) => {
  const f = await fixture(t),
    pending = checkpoint();
  pending.generation!.outcome = 'pending';
  await f.sessions.save(pending);
  const unknown = structuredClone(pending);
  unknown.generation!.outcome = 'unknown';
  unknown.status = 'failed';
  await f.sessions.save(unknown);
  const reopened = new FileManagedSessions(f.directory);
  for (const mutate of [
    (value: ManagedSession) => {
      delete value.generation;
    },
    (value: ManagedSession) => {
      value.generation!.outcome = 'completed';
    },
    (value: ManagedSession) => {
      value.requests++;
      value.generation = { requestId: 'another', outcome: 'pending' };
    },
  ]) {
    const candidate = structuredClone(unknown);
    mutate(candidate);
    await rejects(() => reopened.save(candidate));
  }
  assert.deepEqual(await reopened.load(unknown.id), unknown);
});

test('same-generation stale saves cannot erase a completed response, continuation or intermediate provenance', async (t) => {
  const f = await fixture(t),
    original = checkpoint();
  await f.sessions.save(original);
  const completed = structuredClone(original);
  completed.messages.push(
    {
      role: 'assistant',
      content: 'Intermediate completion',
      continuation: { opaque: 'COMPLETED_RESPONSE' },
    },
    { role: 'user', content: 'Serialize the final result.' },
  );
  completed.intermediateNotes = [completed.messages.length - 2];
  await f.sessions.save(completed);
  await rejects(() => f.sessions.save(original));
  const withoutContinuation = structuredClone(completed);
  delete withoutContinuation.messages.at(-2)!.continuation;
  await rejects(() => f.sessions.save(withoutContinuation));
  const withoutProvenance = structuredClone(completed);
  delete withoutProvenance.intermediateNotes;
  await rejects(() => f.sessions.save(withoutProvenance));
  assert.deepEqual(await new FileManagedSessions(f.directory).load(original.id), completed);
});

test('bounded handoff receipts survive reopening and cannot fabricate actual tool evidence', async (t) => {
  const f = await fixture(t),
    original = checkpoint(),
    next = rotated(original);
  await f.sessions.save(original);
  const handoff = next.workSegments!.archives[0].handoff;
  handoff.receipts = segmentActionReceipts(next.actions);
  next.messages = segmentMessages(next.workSegments!.anchor, next.scope, handoff);
  assert.equal(handoff.receipts.length, 1);
  const mutations: ((value: ManagedSession) => void)[] = [
    (value) => {
      value.workSegments!.archives[0].handoff.receipts![0].output = 'invented successful check';
    },
    (value) => {
      value.workSegments!.archives[0].handoff.receipts![0].actionId = 'A-fabricated';
    },
    (value) => {
      value.workSegments!.archives[0].handoff.receipts![0].toolName = 'run_command';
    },
    (value) => {
      value.workSegments!.archives[0].handoff.receipts![0].target = 'src/unobserved.ts';
    },
    (value) => {
      value.workSegments!.archives[0].handoff.receipts![0].isError = true;
    },
    (value) => {
      value.workSegments!.archives[0].handoff.receipts![0].output = 'x'.repeat(513);
    },
    (value) => {
      value.workSegments!.archives[0].handoff.receipts = Array(7).fill(handoff.receipts![0]);
    },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(next);
    mutate(candidate);
    await rejects(() => f.sessions.save(candidate));
    assert.deepEqual(await f.sessions.load(original.id), original);
  }
  await f.sessions.save(next);
  assert.deepEqual(
    (await new FileManagedSessions(f.directory).load(original.id))!.workSegments!.archives[0]
      .handoff.receipts,
    handoff.receipts,
  );
});

test('queued stale saves cannot remove a just-committed rollover', async (t) => {
  const f = await fixture(t),
    original = checkpoint(),
    next = rotated(original);
  await f.sessions.save(original);
  const results = await Promise.allSettled([f.sessions.save(next), f.sessions.save(original)]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.deepEqual(await f.sessions.load(next.id), next);
});

test('reopening rejects malformed on-disk archive metadata before returning continuation', async (t) => {
  const f = await fixture(t),
    original = checkpoint(),
    next = rotated(original);
  await f.sessions.save(original);
  await f.sessions.save(next);
  const corrupt = structuredClone(next);
  corrupt.workSegments!.archives[0].intermediateNotes = [2];
  const bytes = JSON.stringify(corrupt);
  await fs.writeFile(f.filename, bytes);
  await assert.rejects(new FileManagedSessions(f.directory).load(next.id), /provenance/);
  assert.equal(await fs.readFile(f.filename, 'utf8'), bytes);
});

test('explicit manual turns and scope revisions preserve the lifetime archive and original evidence', async (t) => {
  const f = await fixture(t),
    original = checkpoint(),
    next = rotated(original);
  await f.sessions.save(original);
  await f.sessions.save(next);
  const continuation = structuredClone(next);
  continuation.scope.writeScope = {
    ...continuation.scope.writeScope,
    mode: 'advisory',
    plannedPaths: [],
  };
  continuation.scopeRevisions!.push({
    revision: 2,
    scope: structuredClone(continuation.scope),
    instructions: 'Continue read-only investigation in the original assignment.',
  });
  continuation.messages.push({
    role: 'system',
    content:
      'Updated instructions for continuing saved work:\nContinue read-only investigation in the original assignment.',
  });
  await f.sessions.save(continuation);
  const active = structuredClone(continuation);
  active.workSegments!.anchor = {
    turnId: 'T-second',
    scopeRevision: 2,
    instructions: continuation.scopeRevisions![1].instructions,
    task: 'Finish the same assignment.',
  };
  active.workSegments!.active.toolRounds = 0;
  active.messages.push({ role: 'user', content: 'Finish the same assignment.' });
  await f.sessions.save(active);
  assert.deepEqual(
    (await f.sessions.load(active.id))!.workSegments!.archives,
    next.workSegments!.archives,
  );
  assert.deepEqual(
    (await f.sessions.load(active.id))!.workSegments!.baseline,
    original.workSegments!.baseline,
  );
  assert.deepEqual((await f.sessions.load(active.id))!.actions, original.actions);
});
