import test from 'node:test';
import assert from 'node:assert/strict';
import type { Agent, Role } from '../protocol/domain.ts';
import { roleViewForAgent, roleViewsForRun } from '../src/model.ts';
import { parseSnapshot } from '../protocol/schema.ts';
import { sampleRun } from './fixtures/sample-run.ts';

test('result-only sessions remain discoverable and show their frozen role version after user edits', () => {
  const run = sampleRun();
  const original: Role = {
    id: 'api_delivery',
    version: 1,
    title: 'Original delivery specialist',
    description: 'Prepared the accepted commit.',
    instructions: 'Original instructions.',
    kind: 'general',
    provenance: {
      origin: 'workflow',
      workflow: { id: 'code', revision: 'code-v1' },
      template: { id: 'environment-delivery', revision: 'template-v1' },
    },
    createdAt: run.createdAt,
    updatedAt: run.createdAt,
  };
  const current: Role = {
    ...original,
    version: 2,
    title: 'Edited for future delivery',
    instructions: 'New instructions.',
    provenance: { origin: 'user' },
  };
  const agent: Agent = {
    threadId: 'delivery-session-1',
    name: original.id,
    agentPath: '/result/delivery',
    startedAt: run.createdAt,
    completedAt: run.completedAt!,
    status: 'completed',
    messages: ['Prepared delivery.'],
    commands: 0,
    session: {
      id: 'delivery-session-1',
      roleId: original.id,
      roleVersion: 1,
      runtimeId: 'fixture',
    },
  };
  run.roleSnapshots = [original];
  run.resultAgents = [agent];
  const roundTripped = parseSnapshot({
    version: 1,
    project: { id: 'p', name: 'Fixture', root: '/synthetic' },
    revision: 1,
    sequence: 1,
    roles: [current],
    goals: [],
    runs: [run],
    capabilities: [],
  }).runs[0];
  assert.deepEqual(roundTripped.resultAgents?.[0].session, agent.session);
  const views = roleViewsForRun([], run);
  assert.equal(views.api_delivery.title, original.title);
  const opened = roleViewForAgent(
    run,
    agent,
    roleViewsForRun([current], { ...run, roleSnapshots: [] }).api_delivery,
  );
  assert.equal(opened.title, original.title);
  assert.equal(opened.definition?.version, 1);
  assert.equal(opened.definition?.instructions, original.instructions);
  assert.equal(opened.definition?.provenance.origin, 'workflow');

  run.roleSnapshots = [];
  const missingEvidence = roleViewForAgent(
    run,
    agent,
    roleViewsForRun([current], run).api_delivery,
  );
  assert.equal(missingEvidence.definition, undefined);
  assert.equal(missingEvidence.title, agent.name);
});
