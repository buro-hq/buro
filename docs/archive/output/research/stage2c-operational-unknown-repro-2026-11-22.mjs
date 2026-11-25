// Offline review reproduction: fake read-only preparation fails with an unknown generation.
// No provider, Git, source-project or delivery effect is invoked.
import assert from 'node:assert/strict';
import { ResultService } from '../../core/results.ts';
import { UnresolvedEffectError } from '../../core/run-reconciliation.ts';
import {
  fixtureExecutionSelection,
  fixtureExecutionCapabilities,
} from '../../tests/fixtures/execution-resources.ts';

const role = {
  id: 'delivery_pr',
  version: 1,
  title: 'PR preparation',
  description: 'Prepare read-only',
  instructions: 'Inspect only',
  kind: 'general',
  createdAt: 'now',
  updatedAt: 'now',
};
const resources = fixtureExecutionSelection(
  'review-fake',
  fixtureExecutionCapabilities(),
).forProject('p');
const config = { pullRequests: true, environments: [] };
const state = {
  project: { id: 'p', root: '/unopened-source' },
  profile: { delivery: config },
  roleVersions: [role],
  goals: [{ id: 'G' }],
  runs: [
    {
      id: 'R',
      goalId: 'G',
      status: 'completed',
      commit: 'a'.repeat(40),
      workspace: '/unopened-workspace',
      goalText: 'Review fake input',
      result: 'Accepted',
      acceptance: { passed: 1, total: 1, results: [] },
      resources,
      agents: [],
      events: [],
      outcome: { kind: 'pull-request' },
    },
  ],
};
const store = {
  snapshot: () => ({ ...structuredClone(state), roles: structuredClone(state.roleVersions) }),
  async transact(_id, _fingerprint, apply) {
    const draft = structuredClone(state);
    const change = apply(draft);
    Object.assign(state, draft);
    return change.result;
  },
};
let starts = 0,
  turns = 0,
  deliveries = 0,
  releases = 0;
const runtime = {
  id: 'review-fake',
  async start(input) {
    assert.equal(input.readOnly, true);
    return { threadId: 'fake-preparation-' + ++starts };
  },
  async turn() {
    turns++;
    throw new UnresolvedEffectError('GENERATION_RECONCILIATION_REQUIRED', {
      runtimeId: 'review-fake',
      operationId: 'unknown-generation-' + turns,
    });
  },
  async release() {
    releases++;
  },
};
const service = new ResultService({
  projects: { get: () => store },
  runtime,
  operations: {
    async pullRequest() {
      deliveries++;
      return {};
    },
  },
});
for (let attempt = 0; attempt < 2; attempt++) {
  await service.deliver('p', 'R', 'a'.repeat(40));
  await service.jobs.get('delivery:R')?.promise;
}
assert.equal(starts, 2);
assert.equal(turns, 2);
assert.equal(deliveries, 0);
assert.equal(releases, 2);
assert.equal(state.runs[0].reconciliation, undefined);
assert.equal(state.runs[0].delivery.status, 'failed');
process.stdout.write(
  JSON.stringify(
    {
      offline: true,
      fakeReadOnlyPreparations: starts,
      unknownTurns: turns,
      externalDeliveries: deliveries,
      releasedSessions: releases,
      owningRunMarker: state.runs[0].reconciliation || null,
      deliveryStatus: state.runs[0].delivery.status,
      result:
        'Unknown read-only preparation can be attempted in a new session; no delivery executes.',
    },
    null,
    2,
  ) + '\n',
);
