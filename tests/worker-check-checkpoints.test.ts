import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ManagedSession } from '../core/model-ports.ts';
import { FileManagedSessions } from '../adapters/files/managed-sessions.ts';
import {
  segmentActionReceipts,
  segmentMessages,
  type SegmentEvidence,
} from '../core/work-segments.ts';
import { testBoundedWorkSegmentPolicy as boundedWorkSegmentPolicy } from './fixtures/work-segment-policy.ts';
import {
  workerStepFeedback,
  type WorkerStepCheckEntry,
  type WorkerStepCheckPlan,
  type WorkerStepCheckResult,
} from '../core/worker-step-checks.ts';

const observed = (): SegmentEvidence => ({
  version: 1,
  baseCommit: 'a'.repeat(40),
  headCommit: 'a'.repeat(40),
  workspaceFingerprint: 'b'.repeat(64),
  files: [{ path: 'src/owned.ts', fingerprint: 'c'.repeat(64) }],
});
const plan = (): WorkerStepCheckPlan => ({
  version: 1,
  checkIds: ['unit'],
  configurationRevision: 'd'.repeat(64),
});
const failed = (selected = plan()): WorkerStepCheckResult => ({
  version: 1,
  outcome: 'completed',
  workspaceFingerprint: observed().workspaceFingerprint,
  checkIds: [...selected.checkIds],
  passed: 0,
  total: selected.checkIds.length,
  results: selected.checkIds.map((id) => ({
    id,
    name: 'Registered test',
    status: 'failed',
    exitCode: 1,
    diagnostic: 'Expected stable ordering; received reversed items.',
  })),
});
function checkpoint(): ManagedSession {
  const scope = {
    projectId: 'p',
    runId: 'R-owner',
    ownerRunId: 'R-owner',
    sessionId: 'S-builder',
    workspace: '/workspace',
    readOnly: false,
    writeScope: { mode: 'advisory', plannedPaths: ['src/owned.ts'], protectedPaths: ['checks/'] },
    materials: [],
    commands: [],
    baseCommit: 'a'.repeat(40),
  };
  const anchor = {
    turnId: 'T-first',
    instructions: 'Preserve the original assignment and registered checks.',
    task: 'Repair item ordering in the assigned file.',
    scopeRevision: 1,
  };
  const call = { id: 'call-read', name: 'read_file', arguments: { path: 'src/owned.ts' } };
  return {
    version: 1,
    id: 'M-worker',
    runtimeId: 'managed',
    providerId: 'ollama',
    providerRevision: 'frozen',
    toolRevision: 'fixture-tools-v1',
    requestedModel: 'fixture-small',
    purpose: 'implementation',
    limits: {
      contextTokens: 32768,
      maxOutputTokens: 1024,
      maxRequestsPerTurn: 12,
      maxToolCallsPerTurn: 24,
      maxSessionRequests: 64,
    },
    scope,
    assignment: {
      roleId: 'builder',
      scope: structuredClone(scope.writeScope),
    },
    scopeRevisions: [
      { revision: 1, scope: structuredClone(scope), instructions: anchor.instructions },
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
      {
        role: 'assistant',
        content: '{"summary":"The assigned change is ready."}',
        continuation: { opaque: 'PRIVATE_TERMINAL_CONTINUATION' },
      },
    ],
    requests: 2,
    usage: { requestsWithUsage: 2, inputTokens: 20, outputTokens: 10 },
    status: 'running',
    generation: { requestId: 'T-first:1', outcome: 'completed' },
    actions: [
      {
        id: 'A-read',
        turnId: anchor.turnId,
        call,
        status: 'completed',
        result: { content: 'Observed source' },
      },
    ],
    workSegments: {
      version: 1,
      limits: structuredClone(boundedWorkSegmentPolicy.limits),
      baseline: observed(),
      anchor,
      active: { index: 1, startedAtRequest: 0, toolRounds: 1 },
      archives: [],
    },
  };
}
function intent(session: ManagedSession, id = 'C-first', selected = plan()): ManagedSession {
  const next = structuredClone(session),
    anchor = next.workSegments!.anchor;
  next.workerStepChecks ||= {
    version: 1,
    revision: 'worker-step-checks-v1',
    maxFeedbackSteps: 2,
    feedbackSteps: 0,
    entries: [],
  };
  next.workerStepChecks.entries.push({
    id,
    turnId: anchor.turnId,
    scopeRevision: anchor.scopeRevision,
    requestedAtRequest: next.requests,
    plan: selected,
    before: observed(),
    status: 'pending',
  });
  return next;
}
function completed(session: ManagedSession, result?: WorkerStepCheckResult): ManagedSession {
  const next = structuredClone(session),
    entry = next.workerStepChecks!.entries.at(-1)!;
  entry.status = 'completed';
  entry.result = result || failed(entry.plan);
  return next;
}
function feedback(session: ManagedSession): ManagedSession {
  const next = structuredClone(session),
    state = next.workSegments!,
    entry = next.workerStepChecks!.entries.at(-1)!;
  const handoff = {
    version: 1 as const,
    kind: 'check-feedback' as const,
    nextTask: workerStepFeedback(entry),
    evidence: structuredClone(entry.before),
    completedActions: next.actions.length,
    receipts: segmentActionReceipts(next.actions),
    checkFeedback: { receiptId: entry.id, result: structuredClone(entry.result!) },
    availableTools: ['read_file', 'edit_file'],
  };
  state.archives.push({
    index: state.active.index,
    anchor: structuredClone(state.anchor),
    startedAtRequest: state.active.startedAtRequest,
    endedAtRequest: next.requests,
    messages: structuredClone(next.messages),
    handoff,
  });
  state.active = { index: state.active.index + 1, startedAtRequest: next.requests, toolRounds: 0 };
  next.workerStepChecks!.feedbackSteps++;
  next.messages = segmentMessages(state.anchor, next.scope, handoff);
  delete next.intermediateNotes;
  return next;
}
async function fixture(t: any) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-worker-checks-')),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return {
    directory,
    filename: path.join(directory, 'M-worker.json'),
    sessions: new FileManagedSessions(directory),
  };
}
const rejects = (action: () => unknown) => assert.rejects(async () => action());
async function prepare(t: any) {
  const f = await fixture(t),
    original = checkpoint(),
    pending = intent(original),
    checked = completed(pending);
  await f.sessions.save(original);
  await f.sessions.save(pending);
  await f.sessions.save(checked);
  return { ...f, original, pending, checked };
}

test('private check intent, actual failure and fresh feedback window survive an atomic checkpoint and reopening', async (t) => {
  const f = await prepare(t),
    next = feedback(f.checked);
  await f.sessions.save(next);
  const restored = (await new FileManagedSessions(f.directory).load(next.id))!;
  assert.deepEqual(restored, next);
  assert.equal(restored.workerStepChecks!.feedbackSteps, 1);
  assert.match(restored.messages.at(-1)!.content, /Expected stable ordering/);
  assert.match(restored.messages.at(-1)!.content, /edit_file/);
  assert.doesNotMatch(JSON.stringify(restored.messages), /PRIVATE_/);
  assert.deepEqual(restored.workSegments!.archives[0].messages.at(-1)!.continuation, {
    opaque: 'PRIVATE_TERMINAL_CONTINUATION',
  });
  assert.deepEqual(restored.actions, f.original.actions);
  assert.equal(restored.requests, f.original.requests);
  assert.deepEqual(await fs.readdir(f.directory), ['M-worker.json']);
});

test('a focused repair cannot fabricate check evidence, reuse another receipt or detach it from the workspace', async (t) => {
  const f = await prepare(t);
  const mutations: ((value: ManagedSession) => void)[] = [
    (value) => {
      value.workSegments!.archives[0].handoff.checkFeedback!.receiptId = 'C-invented';
    },
    (value) => {
      value.workSegments!.archives[0].handoff.checkFeedback!.result.results[0].diagnostic =
        'invented diagnostic';
    },
    (value) => {
      value.workSegments!.archives[0].handoff.evidence.workspaceFingerprint = 'e'.repeat(64);
    },
    (value) => {
      value.workSegments!.archives[0].handoff.nextTask = 'Model claims all checks passed.';
    },
    (value) => {
      value.workSegments!.archives[0].anchor.turnId = 'T-another';
    },
    (value) => {
      value.workSegments!.archives[0].handoff.checkFeedback!.result.checkIds = ['unregistered'];
    },
    (value) => {
      delete value.workSegments!.archives[0].handoff.kind;
    },
    (value) => {
      delete value.workSegments!.archives[0].handoff.checkFeedback;
    },
    (value) => {
      value.workerStepChecks!.feedbackSteps = 0;
    },
    (value) => {
      value.workSegments!.archives[0].handoff.availableTools = ['edit_file', 'edit_file'];
    },
    (value) => {
      value.generation!.outcome = 'pending';
    },
    (value) => {
      value.actions[0].status = 'unknown';
    },
  ];
  for (const mutate of mutations) {
    const candidate = feedback(f.checked);
    mutate(candidate);
    await rejects(() => f.sessions.save(candidate));
    assert.deepEqual(await f.sessions.load(f.checked.id), f.checked);
  }
});

test('service checks require a persisted pending intent and cannot rewrite completed plans, outcomes or counters', async (t) => {
  const f = await fixture(t),
    original = checkpoint();
  await f.sessions.save(original);
  const pending = intent(original),
    checked = completed(pending);
  await rejects(() => f.sessions.save(checked));
  await f.sessions.save(pending);
  const changedPlan = structuredClone(checked);
  changedPlan.workerStepChecks!.entries[0].plan.checkIds = ['replacement'];
  changedPlan.workerStepChecks!.entries[0].result = failed(
    changedPlan.workerStepChecks!.entries[0].plan,
  );
  await rejects(() => f.sessions.save(changedPlan));
  await f.sessions.save(checked);
  const mutations: ((value: ManagedSession) => void)[] = [
    (value) => {
      delete value.workerStepChecks;
    },
    (value) => {
      value.workerStepChecks!.entries = [];
    },
    (value) => {
      value.workerStepChecks!.entries[0].result!.results[0].diagnostic = 'rewrite observed result';
    },
    (value) => {
      value.workerStepChecks!.entries[0].status = 'unknown';
      delete value.workerStepChecks!.entries[0].result;
    },
    (value) => {
      value.workerStepChecks!.entries[0].before.workspaceFingerprint = 'e'.repeat(64);
      value.workerStepChecks!.entries[0].result!.workspaceFingerprint = 'e'.repeat(64);
    },
    (value) => {
      value.workerStepChecks!.maxFeedbackSteps = 3 as 2;
    },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(checked);
    mutate(candidate);
    await rejects(() => f.sessions.save(candidate));
    assert.deepEqual(await f.sessions.load(checked.id), checked);
  }
});

test('unknown check outcomes remain stopped after reopening and cannot be erased, completed or replayed', async (t) => {
  const f = await fixture(t),
    original = checkpoint(),
    pending = intent(original);
  await f.sessions.save(original);
  await f.sessions.save(pending);
  const unknown = structuredClone(pending);
  unknown.workerStepChecks!.entries[0].status = 'unknown';
  unknown.status = 'failed';
  await f.sessions.save(unknown);
  const reopened = new FileManagedSessions(f.directory);
  for (const candidate of [
    completed(unknown),
    intent(unknown, 'C-replay'),
    { ...unknown, workerStepChecks: undefined },
  ])
    await rejects(() => reopened.save(candidate));
  const withResult = structuredClone(unknown);
  withResult.workerStepChecks!.entries[0].result = failed();
  await rejects(() => reopened.save(withResult));
  assert.deepEqual(await reopened.load(unknown.id), unknown);
});

test('failed or unavailable evidence cannot be presented as a passed check and unavailable checks do not create feedback', async (t) => {
  const f = await fixture(t),
    original = checkpoint(),
    pending = intent(original);
  await f.sessions.save(original);
  await f.sessions.save(pending);
  const malformed = completed(pending);
  malformed.workerStepChecks!.entries[0].result!.passed = 1;
  await rejects(() => f.sessions.save(malformed));
  const unavailable = failed();
  unavailable.outcome = 'unavailable';
  unavailable.results[0].status = 'unavailable';
  unavailable.results[0].exitCode = null;
  const checked = completed(pending, unavailable);
  await f.sessions.save(checked);
  const candidate = feedback(completed(pending));
  candidate.workerStepChecks = structuredClone(checked.workerStepChecks);
  candidate.workerStepChecks!.feedbackSteps = 1;
  candidate.workSegments!.archives[0].handoff.checkFeedback!.result = unavailable;
  await rejects(() => f.sessions.save(candidate));
  assert.deepEqual(await f.sessions.load(checked.id), checked);
});

test('failed feedback persistence preserves the completed check and never consumes a partial repair step', async (t) => {
  const f = await prepare(t),
    next = feedback(f.checked),
    rename = fs.rename.bind(fs);
  const mock = t.mock.method(
    fs,
    'rename',
    async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => {
      if (String(to) === f.filename) throw Error('feedback checkpoint unavailable');
      return rename(from, to);
    },
  );
  await assert.rejects(f.sessions.save(next), /feedback checkpoint unavailable/);
  mock.mock.restore();
  assert.deepEqual(await f.sessions.load(next.id), f.checked);
  assert.equal((await f.sessions.load(next.id))!.workerStepChecks!.feedbackSteps, 0);
  assert.deepEqual(await fs.readdir(f.directory), ['M-worker.json']);
  await f.sessions.save(next);
  assert.deepEqual(await new FileManagedSessions(f.directory).load(next.id), next);
});

async function anotherCompletedGeneration(sessions: FileManagedSessions, previous: ManagedSession) {
  const pending = structuredClone(previous);
  pending.requests++;
  pending.generation = { requestId: 'T-next:' + pending.requests, outcome: 'pending' };
  await sessions.save(pending);
  const done = structuredClone(pending);
  done.generation!.outcome = 'completed';
  done.messages.push({
    role: 'assistant',
    content: 'The focused change is ready for service checks.',
  });
  await sessions.save(done);
  return done;
}

test('manual scope revisions can add a new frozen check selection while preserving old evidence and the two-step lifetime allowance', async (t) => {
  const f = await prepare(t),
    first = feedback(f.checked);
  await f.sessions.save(first);
  const resumed = structuredClone(first);
  resumed.scope.commands = [{ id: 'api', command: 'node check-api', timeoutMs: 1000 }];
  resumed.scopeRevisions!.push({
    revision: 2,
    scope: structuredClone(resumed.scope),
    instructions: 'Continue the same assignment with revised registered checks.',
  });
  resumed.messages.push({
    role: 'system',
    content: 'Continue the same assignment with revised registered checks.',
  });
  await f.sessions.save(resumed);
  const active = structuredClone(resumed);
  active.workSegments!.anchor = {
    turnId: 'T-second',
    instructions: resumed.scopeRevisions!.at(-1)!.instructions,
    task: 'Finish the original assignment.',
    scopeRevision: 2,
  };
  active.workSegments!.active.toolRounds = 0;
  await f.sessions.save(active);
  const generated = await anotherCompletedGeneration(f.sessions, active);
  const pending = intent(generated, 'C-second', {
    version: 1,
    checkIds: ['api'],
    configurationRevision: 'e'.repeat(64),
  });
  await f.sessions.save(pending);
  const checked = completed(pending);
  await f.sessions.save(checked);
  const second = feedback(checked);
  await f.sessions.save(second);
  assert.equal(second.workerStepChecks!.feedbackSteps, 2);
  assert.deepEqual(second.workerStepChecks!.entries[0], f.checked.workerStepChecks!.entries[0]);
  const generatedAgain = await anotherCompletedGeneration(f.sessions, second);
  const thirdIntent = intent(generatedAgain, 'C-third');
  await f.sessions.save(thirdIntent);
  const thirdResult = completed(thirdIntent);
  await f.sessions.save(thirdResult);
  await rejects(() => f.sessions.save(feedback(thirdResult)));
  const reset = structuredClone(thirdResult);
  reset.workerStepChecks!.feedbackSteps = 0;
  await rejects(() => f.sessions.save(reset));
  assert.deepEqual(await new FileManagedSessions(f.directory).load(second.id), thirdResult);
});
