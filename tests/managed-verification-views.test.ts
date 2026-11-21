import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ManagedAgentRuntime } from '../core/managed-runtime.ts';
import type { ProjectRegistry } from '../core/ports.ts';
import type { ToolScope } from '../core/model-ports.ts';
import type { ModelProvider } from '../agent/contracts/model.ts';
import type { ManagedRunBudgetPort } from '../core/run-budget.ts';
import { FileManagedSessions } from '../adapters/files/managed-sessions.ts';
import { ProjectCommandSchema } from '../protocol/projects.ts';
import { VerificationViewSchema, VerificationEvidenceSchema } from '../protocol/verification.ts';
import type { VerificationView } from '../protocol/verification.ts';
import type { Run } from '../protocol/domain.ts';
import { parseSnapshot } from '../protocol/schema.ts';
import { sampleRun } from './fixtures/sample-run.ts';

const base = 'a'.repeat(40),
  tree = 'b'.repeat(40);
const issuedView = (): VerificationView => ({
  version: 1,
  id: 'V-issued',
  projectId: 'p',
  runId: 'R-owner',
  sourceWorkspace: '/writer/run',
  readRoot: '/verification/issued/source',
  outputRoot: '/verification/issued/outputs',
  base,
  tree,
  outputPaths: ['dist'],
});

async function fixture(t: any, withBudget = false) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'managed-view-')));
  const sessions = new FileManagedSessions(directory),
    scopes: ToolScope[] = [];
  const reservations: Parameters<ManagedRunBudgetPort['reserveGeneration']>[0][] = [];
  const run: Run = {
    ...sampleRun(),
    id: 'R-owner',
    workspace: '/writer/run',
    baseCommit: base,
    verificationView: issuedView(),
    status: 'running',
  };
  const snapshot = {
    project: { id: 'p', name: 'Fixture', root: '/project' },
    runs: [run],
    contextMaterials: [],
  };
  const projects = {
    get: () => ({ snapshot: () => structuredClone(snapshot) }),
  } as unknown as ProjectRegistry;
  let serial = 0,
    requests = 0;
  const provider: ModelProvider = {
    id: 'fixture',
    revision: 'fixture-v1',
    local: true,
    async complete() {
      requests++;
      return {
        model: 'fixture',
        message: { role: 'assistant', content: '{"ok":true}' },
        finish: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  const runtimes: ManagedAgentRuntime[] = [];
  const make = () => {
    const runtime = new ManagedAgentRuntime({
      id: 'managed-view',
      model: 'fixture',
      provider,
      projects,
      sessions,
      idGenerator: () => String(++serial),
      limits: {
        contextTokens: 10000,
        maxOutputTokens: 1000,
        maxRequestsPerTurn: 4,
        maxToolCallsPerTurn: 4,
        maxSessionRequests: 16,
      },
      tools: {
        definitions(scope) {
          scopes.push(structuredClone(scope));
          return [];
        },
        async execute() {
          throw Error('No tool effect expected');
        },
      },
      ...(withBudget
        ? {
            budgets: {
              async reserveGeneration(input) {
                reservations.push(input);
                return {
                  operationId: input.operationId,
                  maxOutputTokens: input.requestedOutputTokens,
                };
              },
              async reserveTools() {},
              async recordUsage() {},
            } as ManagedRunBudgetPort,
          }
        : {}),
    });
    runtimes.push(runtime);
    return runtime;
  };
  t.after(async () => {
    for (const runtime of runtimes) await runtime.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const startInput = () => ({
    projectId: 'p',
    runId: run.id,
    workspace: run.verificationView!.readRoot,
    instructions: 'Review the frozen source',
    purpose: 'review' as const,
    readOnly: true,
  });
  const turn = () => ({ schema: {}, signal: new AbortController().signal, timeoutMs: 1000 });
  return {
    run,
    sessions,
    make,
    scopes,
    reservations,
    startInput,
    turn,
    provider,
    get requests() {
      return requests;
    },
  };
}

test('an issued read-only review view retains its owner and frozen identity through a budgeted turn', async (t) => {
  const f = await fixture(t, true),
    runtime = f.make();
  const { threadId } = await runtime.start(f.startInput());
  const saved = (await f.sessions.load(threadId))!;
  assert.equal(saved.scope.workspace, f.run.verificationView!.readRoot);
  assert.equal(saved.scope.verificationViewId, 'V-issued');
  assert.equal(saved.scope.verificationTree, tree);
  assert.equal(saved.scope.readOnly, true);
  await runtime.turn(threadId, 'Review now', f.turn());
  assert.equal(f.requests, 1);
  assert.equal(f.reservations[0].ownerRunId, f.run.id);
  assert.equal(f.reservations[0].phase, 'review');
  assert.equal(f.scopes[0].workspace, f.run.verificationView!.readRoot);
});

test('view access rejects writable reviewers, workers, arbitrary paths and live-source review', async (t) => {
  const f = await fixture(t),
    runtime = f.make(),
    input = f.startInput();
  for (const candidate of [
    { ...input, readOnly: false },
    { ...input, purpose: 'implementation' as const },
    { ...input, workspace: '/unissued/source' },
    { ...input, workspace: f.run.workspace },
    {
      ...input,
      assignment: {
        sessionId: 'S-fake',
        roleId: 'writer',
        allowedPaths: ['./'],
        protectedPaths: [],
      },
    },
  ])
    await assert.rejects(runtime.start(candidate), { code: 'SESSION_MISMATCH' });
  assert.equal(f.requests, 0);
});

test('a cached reviewer cannot execute after its active view id, tree or grant disappears', async (t) => {
  const f = await fixture(t),
    runtime = f.make();
  const { threadId } = await runtime.start(f.startInput());
  f.run.verificationView = { ...issuedView(), id: 'V-next' };
  await assert.rejects(runtime.turn(threadId, 'Wrong view', f.turn()), {
    code: 'SESSION_MISMATCH',
  });
  f.run.verificationView = { ...issuedView(), tree: 'c'.repeat(40) };
  await assert.rejects(runtime.turn(threadId, 'Wrong tree', f.turn()), {
    code: 'SESSION_MISMATCH',
  });
  delete f.run.verificationView;
  await assert.rejects(runtime.turn(threadId, 'Deleted grant', f.turn()), {
    code: 'SESSION_MISMATCH',
  });
  assert.equal(f.requests, 0);
});

test('revoking a view while a model response is pending prevents its requested tool from running', async (t) => {
  const f = await fixture(t),
    runtime = f.make();
  const { threadId } = await runtime.start(f.startInput());
  f.provider.complete = async () => {
    delete f.run.verificationView;
    return {
      model: 'fixture',
      finish: 'tools',
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'read', name: 'read_file', arguments: { path: 'src/code.ts' } }],
      },
    };
  };
  await assert.rejects(runtime.turn(threadId, 'Review', f.turn()), { code: 'SESSION_MISMATCH' });
  const saved = (await f.sessions.load(threadId))!;
  assert.equal(saved.generation!.outcome, 'completed');
  assert.equal(saved.generation!.response!.message.toolCalls![0].id, 'read');
  assert.equal(saved.actions.length, 0);
});

test('restoring a reviewer requires the original active view and never a new arbitrary workspace', async (t) => {
  const f = await fixture(t),
    original = f.make(),
    input = f.startInput();
  const { threadId } = await original.start(input);
  await original.release(threadId);
  const restored = f.make();
  await assert.rejects(restored.resume({ ...input, threadId, workspace: '/new/source' }), {
    code: 'SESSION_MISMATCH',
  });
  await restored.resume({ ...input, threadId });
  await restored.turn(threadId, 'Restored review', f.turn());
  assert.equal(f.requests, 1);
  await restored.release(threadId);
  delete f.run.verificationView;
  await assert.rejects(f.make().resume({ ...input, threadId }), { code: 'SESSION_MISMATCH' });
});

test('private checkpoints cannot change the frozen view identity through a scope revision', async (t) => {
  const f = await fixture(t),
    runtime = f.make();
  const { threadId } = await runtime.start(f.startInput());
  const saved = (await f.sessions.load(threadId))!;
  saved.scope.verificationTree = 'c'.repeat(40);
  saved.scopeRevisions!.push({
    revision: 2,
    scope: structuredClone(saved.scope),
    instructions: 'Forged view',
  });
  await assert.rejects(f.sessions.save(saved), { code: 'INVALID_CHECKPOINT' });
  const unchanged = (await f.sessions.load(threadId))!;
  assert.equal(unchanged.scope.verificationTree, tree);
});

test('verification paths and outputs reject source overlap and service metadata without arbitrary list caps', () => {
  for (const changed of [
    { readRoot: '/writer/run/view' },
    { outputRoot: '/writer' },
    { readRoot: '/verification' },
    { outputRoot: '/verification/issued/source/outputs' },
    {
      outputRoot: '/cache',
      readonlyDependencies: [
        {
          path: '/verification/issued/source/node_modules',
          target: '/cache/dependencies/node_modules',
        },
      ],
    },
  ])
    assert.equal(VerificationViewSchema.safeParse({ ...issuedView(), ...changed }).success, false);
  for (const output of [
    '.',
    './',
    '../dist',
    '.git/',
    '.buro/cache',
    'node_modules/',
    'nested/../dist',
  ])
    assert.equal(
      ProjectCommandSchema.safeParse({
        id: 'check',
        title: 'Check',
        command: 'fixture',
        timeoutMs: 1000,
        outputPaths: [output],
      }).success,
      false,
    );
  const outputs = Array.from({ length: 100 }, (_, index) => `generated-${index}/`);
  const command = ProjectCommandSchema.parse({
    id: 'check',
    title: 'Check',
    command: 'fixture',
    timeoutMs: 1000,
    outputPaths: outputs,
  });
  assert.equal(command.outputPaths!.length, 100);
  assert.equal(command.outputPaths![0], 'generated-0');
});

test('public snapshots retain exact view/evidence and reject cross-project view handles', () => {
  const run = {
    ...sampleRun(),
    id: 'R-owner',
    workspace: '/writer/run',
    baseCommit: base,
    verificationView: issuedView(),
    verificationEvidence: {
      version: 1,
      viewId: 'V-issued',
      base,
      tree,
      checkIds: ['check'],
      checkedAt: '2026-11-21T12:00:00.000Z',
    },
  };
  const snapshot = {
    version: 1,
    project: { id: 'p', name: 'Fixture', root: '/project' },
    revision: 0,
    sequence: 0,
    roles: [],
    goals: [],
    runs: [run],
    capabilities: [],
  };
  assert.deepEqual(parseSnapshot(snapshot).runs[0].verificationView, issuedView());
  assert.equal(parseSnapshot(snapshot).runs[0].verificationEvidence!.tree, tree);
  assert.throws(() =>
    parseSnapshot({ ...snapshot, project: { ...snapshot.project, id: 'other' } }),
  );
  assert.throws(() =>
    parseSnapshot({
      ...snapshot,
      runs: [{ ...run, verificationView: { ...issuedView(), runId: 'other-run' } }],
    }),
  );
  assert.equal(
    VerificationEvidenceSchema.safeParse({
      ...run.verificationEvidence,
      reviewedAt: '2026-11-21T12:01:00.000Z',
    }).success,
    false,
  );
});
