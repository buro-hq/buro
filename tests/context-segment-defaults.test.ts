import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareRuntimeHost, type RuntimeHostOptions } from '../adapters/resources/runtime-host.ts';
import { FileManagedSessions } from '../adapters/files/managed-sessions.ts';
import type { ManagedSession } from '../core/model-ports.ts';
import { contextWorkSegmentPolicy } from '../core/work-segments.ts';

test('production runtime host defaults to context rotation and preserves an explicit custom policy', () => {
  const options: RuntimeHostOptions = {
    directory: '/fixture',
    projects: {} as RuntimeHostOptions['projects'],
    executors: { protectPrivatePaths() {} } as unknown as RuntimeHostOptions['executors'],
    segmentEvidence: {
      inspect: async () => {
        throw Error('No inference or workspace reads expected');
      },
    },
  };
  assert.equal(prepareRuntimeHost(options).segmentPolicy, contextWorkSegmentPolicy);
  const custom = {
    ...contextWorkSegmentPolicy,
    revision: 'custom-segment-policy',
    limits: { revision: 'custom-segment-policy', maxSegments: 2 },
  };
  assert.equal(prepareRuntimeHost({ ...options, segmentPolicy: custom }).segmentPolicy, custom);
});

test('File checkpoints retain context limits and forbid rewriting their frozen policy', async (t) => {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-context-segment-limits-')),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sessions = new FileManagedSessions(directory);
  const anchor = {
    turnId: 'T-work',
    instructions: 'Original instructions',
    task: 'Original task',
    scopeRevision: 1,
  };
  const session: ManagedSession = {
    version: 1,
    id: 'M-context',
    runtimeId: 'managed',
    limits: {
      contextTokens: 16000,
      maxOutputTokens: 1024,
      maxRequestsPerTurn: 24,
      maxToolCallsPerTurn: 64,
      maxSessionRequests: 256,
    },
    providerId: 'fixture',
    providerRevision: 'fixture-v1',
    toolRevision: 'fixture-tools-v1',
    requestedModel: 'fixture',
    purpose: 'implementation',
    scope: {
      projectId: 'p',
      runId: 'R',
      sessionId: 'M-context',
      workspace: '/fixture',
      readOnly: false,
      writeScope: { mode: 'advisory', plannedPaths: [], protectedPaths: [] },
      materials: [],
      commands: [],
    },
    messages: [
      { role: 'system', content: anchor.instructions },
      { role: 'user', content: anchor.task },
    ],
    status: 'ready',
    requests: 0,
    usage: { requestsWithUsage: 0, inputTokens: 0, outputTokens: 0 },
    actions: [],
    workSegments: {
      version: 1,
      limits: structuredClone(contextWorkSegmentPolicy.limits),
      baseline: {
        version: 1,
        baseCommit: 'a'.repeat(40),
        headCommit: 'a'.repeat(40),
        workspaceFingerprint: 'b'.repeat(64),
        files: [],
      },
      anchor,
      active: { index: 1, startedAtRequest: 0, toolRounds: 0 },
      archives: [],
    },
  };
  session.scopeRevisions = [
    { revision: 1, scope: structuredClone(session.scope), instructions: anchor.instructions },
  ];
  session.turnAuthorities = [
    { turnId: anchor.turnId, toolPolicy: 'normal', startedAtRequest: 0, scopeRevision: 1 },
  ];
  await sessions.save(session);
  assert.deepEqual(await new FileManagedSessions(directory).load(session.id), session);
  const changed = structuredClone(session);
  changed.workSegments!.limits.maxSegments = 5;
  await assert.rejects(sessions.save(changed), /frozen policy/);
  assert.deepEqual(
    (await sessions.load(session.id))?.workSegments?.limits,
    contextWorkSegmentPolicy.limits,
  );
});
