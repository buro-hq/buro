import assert from 'node:assert/strict';
import test from 'node:test';
import { phase } from '../src/model.ts';
import type { Run } from '../protocol/domain.ts';

test('the history phase follows actual service events instead of assuming an initial planning stage', () => {
  const run = {
    status: 'completed',
    createdAt: '2026-11-23T00:00:00Z',
    updatedAt: '2026-11-23T00:01:40Z',
    completedAt: '2026-11-23T00:01:40Z',
    agents: [],
    commands: [],
    events: [
      { at: '2026-11-23T00:00:01Z', type: 'phase.implementation', text: 'Direct implementation' },
      { at: '2026-11-23T00:00:10Z', type: 'phase.checking', text: 'Checks requested' },
      { at: '2026-11-23T00:00:20Z', type: 'phase.review', text: 'Independent review' },
      {
        at: '2026-11-23T00:00:30Z',
        type: 'phase.implementation',
        text: 'Repair selected by coordinator',
      },
    ],
  } as unknown as Run;
  assert.equal(phase(run, 0), 'Preparing');
  assert.equal(phase(run, 5), 'Implementation');
  assert.equal(phase(run, 15), 'Checks');
  assert.equal(phase(run, 25), 'Review');
  assert.equal(phase(run, 35), 'Implementation');
  assert.equal(phase(run, 100), 'Accepted');
});
