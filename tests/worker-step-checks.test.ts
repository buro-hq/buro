import { fixtureCapabilities } from './fixtures/backend-capabilities.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkerStepChecks } from '../adapters/checks/worker-step-checks.ts';
import type { ToolScope } from '../core/model-ports.ts';
import type { WorkerStepCheckPlan } from '../core/worker-step-checks.ts';

function fixture() {
  const resource = {
    capabilities: fixtureCapabilities({ hostToolLifecycle: true }),
    id: 'local',
    client: 'managed',
    providerId: 'ollama',
    model: 'small',
    configurationRevision: 'frozen-model',
    local: true,
  };
  const check = {
    id: 'contract',
    title: 'Contract',
    command: 'trusted-check-command',
    timeoutMs: 1000,
  };
  const profile = { version: 1, revision: 1, checks: [check], environment: { provider: 'native' } };
  const scope: ToolScope = {
    projectId: 'p',
    runId: 'r',
    ownerRunId: 'r',
    sessionId: 's',
    workspace: '/workspace/r',
    baseCommit: 'a'.repeat(40),
    readOnly: false,
    allowedPaths: ['src/'],
    protectedPaths: ['spec/'],
    materials: [],
    commands: [check],
  };
  const run: any = {
    id: 'r',
    status: 'running',
    delegation: 'buro',
    workspace: scope.workspace,
    baseCommit: scope.baseCommit,
    resources: {
      profileId: 'local',
      policy: 'local-only',
      coordinator: resource,
      worker: resource,
      reviewer: resource,
      workerPool: [resource],
    },
    executionPolicySnapshot: { allowedPaths: ['src/'], protectedPaths: ['spec/'], profile },
    roleAssignments: { coder: ['src/'] },
    assignmentResources: { coder: { resource } },
    checkIds: ['contract'],
    agents: [
      {
        status: 'running',
        session: {
          id: 's',
          roleId: 'coder',
          roleVersion: 1,
          runtimeId: 'local',
          providerId: 'ollama',
          model: 'small',
          configurationRevision: 'frozen-model',
        },
        assignment: { paths: ['src/'] },
      },
    ],
  };
  const state: any = {
    project: { id: 'p', root: '/source' },
    profile: { ...profile, checks: [{ ...check, command: 'CURRENT PROFILE MUST NOT RUN' }] },
    runs: [run],
  };
  const fingerprint = 'b'.repeat(64);
  const evidence = {
    version: 1 as const,
    baseCommit: scope.baseCommit!,
    headCommit: scope.baseCommit!,
    workspaceFingerprint: fingerprint,
    files: [],
  };
  let observation = evidence;
  let world: any = {
    workspace: scope.workspace,
    root: state.project.root,
    config: { provider: 'native' },
    privateDataIsolation: true,
  };
  const calls: any[] = [];
  let response: any = {
    passed: 1,
    total: 1,
    results: [
      { name: check.title, command: check.command, passed: true, exitCode: 0, output: 'PASS' },
    ],
  };
  let during: (() => void) | undefined;
  const adapter = new WorkerStepChecks({
    projects: { get: () => ({ snapshot: () => structuredClone(state) }) } as any,
    checks: {
      run: async (...args: any[]) => {
        calls.push(args);
        during?.();
        return structuredClone(response);
      },
    },
    evidence: { inspect: async () => structuredClone(observation) },
    executors: { get: () => world },
  });
  return {
    adapter,
    scope,
    state,
    run,
    check,
    calls,
    fingerprint,
    response,
    setResponse: (value: any) => {
      response = value;
    },
    setWorld: (value: any) => {
      world = value;
    },
    setEvidence: (value: any) => {
      observation = value;
    },
    evidence,
    during: (fn: () => void) => {
      during = fn;
    },
  };
}
const signal = () => new AbortController().signal;

test('worker checks execute only saved ids/profile through the shared service and preserve the supplied signal', async () => {
  const f = fixture(),
    s = signal();
  const plan = f.adapter.plan(f.scope)!;
  const result = await f.adapter.run(f.scope, plan, f.fingerprint, s);
  assert.equal(result.outcome, 'completed');
  assert.equal(result.passed, 1);
  assert.deepEqual(result.results, [
    { id: 'contract', name: 'Contract', status: 'passed', exitCode: 0, diagnostic: '' },
  ]);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].slice(0, 3), ['p', '/workspace/r', ['contract']]);
  assert.equal(f.calls[0][3], s);
  assert.equal(f.calls[0][4].checks[0].command, 'trusted-check-command');
  assert.deepEqual(f.calls[0][5], { requirePreparedIsolation: true });
  assert.doesNotMatch(JSON.stringify(result), /trusted-check-command|CURRENT PROFILE|PASS/);
});

test('multiple specialists skip goal-wide feedback and missing admission data never gains host fallback', () => {
  const f = fixture();
  f.run.roleAssignments.other = ['other/'];
  assert.equal(f.adapter.plan(f.scope), undefined);
  delete f.run.roleAssignments.other;
  f.setWorld(undefined);
  assert.throws(() => f.adapter.plan(f.scope), { code: 'STEP_CHECK_UNAVAILABLE' });
  f.setWorld({
    workspace: f.scope.workspace,
    root: '/source',
    config: { provider: 'native' },
    privateDataIsolation: false,
  });
  assert.throws(() => f.adapter.plan(f.scope), { code: 'STEP_CHECK_UNAVAILABLE' });
  assert.equal(f.calls.length, 0);
});

test('checkpoint normalization of command display fields does not change the frozen check plan', async () => {
  const f = fixture();
  // Initial live scope retains ProjectCommand.title; the private checkpoint schema strips it.
  const initial = f.adapter.plan(f.scope)!;
  f.scope.commands = f.scope.commands.map(({ id, command, timeoutMs }) => ({
    id,
    command,
    timeoutMs,
  }));
  f.run.resources.worker.capabilities = Object.fromEntries(
    Object.entries(f.run.resources.worker.capabilities).reverse(),
  );
  assert.deepEqual(f.adapter.plan(f.scope), initial);
  const result = await f.adapter.run(f.scope, initial, f.fingerprint, signal());
  assert.equal(result.outcome, 'completed');
  assert.equal(f.calls.length, 1);
});

test('worker feedback requires host tool lifecycle, independently of the client label', () => {
  const capable = fixture();
  capable.run.resources.worker.client = 'codex';
  assert.ok(capable.adapter.plan(capable.scope));
  const incapable = fixture();
  incapable.run.resources.worker.capabilities.hostToolLifecycle = false;
  assert.throws(() => incapable.adapter.plan(incapable.scope), { code: 'STEP_CHECK_UNAVAILABLE' });
  assert.equal(incapable.calls.length, 0);
});

test('forged owner, assignment, protected paths, check commands and resource revisions are rejected before effects', () => {
  for (const change of [
    (f: any) => {
      f.scope.ownerRunId = 'another';
    },
    (f: any) => {
      f.scope.allowedPaths = ['.'];
    },
    (f: any) => {
      f.scope.protectedPaths = [];
    },
    (f: any) => {
      f.scope.commands = [];
    },
    (f: any) => {
      f.run.agents[0].session.configurationRevision = 'different';
    },
    (f: any) => {
      delete f.run.executionPolicySnapshot.profile;
    },
    (f: any) => {
      f.run.cancelRequested = true;
    },
    (f: any) => {
      f.run.checkIds = ['missing'];
    },
  ]) {
    const f = fixture();
    change(f);
    assert.throws(() => f.adapter.plan(f.scope), { code: 'STEP_CHECK_UNAVAILABLE' });
    assert.equal(f.calls.length, 0);
  }
});

test('a stale selection or workspace fingerprint dispatches no check', async () => {
  const f = fixture(),
    plan = f.adapter.plan(f.scope)!;
  await assert.rejects(f.adapter.run(f.scope, plan, 'c'.repeat(64), signal()), {
    code: 'STEP_CHECK_UNAVAILABLE',
  });
  f.run.executionPolicySnapshot.profile.checks[0].timeoutMs = 2000;
  await assert.rejects(f.adapter.run(f.scope, plan, f.fingerprint, signal()), {
    code: 'STEP_CHECK_UNAVAILABLE',
  });
  assert.equal(f.calls.length, 0);
});

test('check-side workspace edits and concurrent policy changes invalidate evidence after effect settlement', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) =>
      f.setEvidence({ ...f.evidence, workspaceFingerprint: 'c'.repeat(64) }),
    (f: ReturnType<typeof fixture>) => {
      f.run.checkIds = [];
    },
    (f: ReturnType<typeof fixture>) => {
      f.run.cancelRequested = true;
    },
  ]) {
    const f = fixture(),
      plan = f.adapter.plan(f.scope)!;
    f.during(() => mutate(f));
    await assert.rejects(f.adapter.run(f.scope, plan, f.fingerprint, signal()), {
      code: 'STEP_CHECK_UNAVAILABLE',
    });
    assert.equal(f.calls.length, 1);
  }
});

test('known positive exit is feedback, while timeout/null/missing process exits are unavailable', async () => {
  for (const exitCode of [2, -1, null, undefined]) {
    const f = fixture();
    f.setResponse({
      passed: 0,
      total: 1,
      results: [
        {
          name: f.check.title,
          command: f.check.command,
          passed: false,
          exitCode,
          error: 'actual failure',
        },
      ],
    });
    const result = await f.adapter.run(f.scope, f.adapter.plan(f.scope)!, f.fingerprint, signal());
    assert.equal(result.outcome, exitCode === 2 ? 'completed' : 'unavailable');
    assert.equal(result.results[0].status, exitCode === 2 ? 'failed' : 'unavailable');
    assert.equal(result.results[0].diagnostic, 'actual failure');
  }
});

test('partial, mismatched or inconsistent check reports fail closed rather than becoming actionable failures', async () => {
  for (const response of [
    { passed: 0, total: 1, results: [] },
    {
      passed: 1,
      total: 1,
      results: [{ name: 'Contract', command: 'trusted-check-command', passed: false, exitCode: 2 }],
    },
    {
      passed: 0,
      total: 1,
      results: [{ name: 'Contract', command: 'trusted-check-command', passed: false, exitCode: 0 }],
    },
    {
      passed: 0,
      total: 1,
      results: [{ name: 'Contract', command: 'unregistered-command', passed: false, exitCode: 2 }],
    },
  ]) {
    const f = fixture();
    f.setResponse(response);
    await assert.rejects(
      f.adapter.run(f.scope, f.adapter.plan(f.scope)!, f.fingerprint, signal()),
      { code: 'STEP_CHECK_UNAVAILABLE' },
    );
  }
});

test('failure evidence strips terminal escapes, commands and absolute paths and stays within the shared bound', async () => {
  const f = fixture();
  f.run.executionPolicySnapshot.profile.checks = Array.from({ length: 8 }, (_, index) => ({
    ...f.check,
    id: 'c' + index,
    title: 'Check ' + index,
  }));
  f.scope.commands = structuredClone(f.run.executionPolicySnapshot.profile.checks);
  f.run.checkIds = f.scope.commands.map((command) => command.id);
  f.setResponse({
    passed: 0,
    total: 8,
    results: f.run.executionPolicySnapshot.profile.checks.map((check: any) => ({
      name: check.title,
      command: check.command,
      passed: false,
      exitCode: 1,
      error:
        '\x1b[31m/workspace/r/src/file /source/src/file /private/tmp/oracle/hidden.cjs trusted-check-command actual mismatch\n' +
        'x'.repeat(1000),
    })),
  });
  const result = await f.adapter.run(f.scope, f.adapter.plan(f.scope)!, f.fingerprint, signal());
  assert.ok(result.results.every((check) => check.diagnostic.length <= 512));
  assert.equal(
    result.results.reduce((total, check) => total + check.diagnostic.length, 0),
    2048,
  );
  assert.doesNotMatch(
    result.results.map((check) => check.diagnostic).join('\n'),
    /workspace|source|hidden\.cjs|trusted-check-command|\\u001b/,
  );
});

test('absolute diagnostic paths are redacted at token boundaries while relative paths and fractions survive', async () => {
  const f = fixture();
  f.setResponse({
    passed: 0,
    total: 1,
    results: [
      {
        name: f.check.title,
        command: f.check.command,
        passed: false,
        exitCode: 1,
        error:
          'expected 2 got 1; /mnt/oracle/internal.cjs /srv/checks/private.mjs file:///custom/oracle.cjs:42 "C:\\custom\\oracle.cjs" src/file.ts fraction 1/2',
      },
    ],
  });
  const result = await f.adapter.run(f.scope, f.adapter.plan(f.scope)!, f.fingerprint, signal());
  const diagnostic = result.results[0].diagnostic;
  assert.doesNotMatch(diagnostic, /internal\.cjs|private\.mjs|oracle\.cjs|mnt|srv|custom/);
  assert.match(diagnostic, /expected 2 got 1/);
  assert.match(diagnostic, /src\/file\.ts/);
  assert.match(diagnostic, /fraction 1\/2/);
  assert.match(diagnostic, /\[path\]:42/);
});

test('abort is propagated without dispatch or without presenting a late result as evidence', async () => {
  const f = fixture(),
    controller = new AbortController(),
    plan = f.adapter.plan(f.scope)!;
  controller.abort();
  await assert.rejects(f.adapter.run(f.scope, plan, f.fingerprint, controller.signal), {
    name: 'AbortError',
  });
  assert.equal(f.calls.length, 0);
  const next = new AbortController();
  f.during(() => next.abort());
  await assert.rejects(f.adapter.run(f.scope, plan, f.fingerprint, next.signal), {
    name: 'AbortError',
  });
  assert.equal(f.calls.length, 1);
});
