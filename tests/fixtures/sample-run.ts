import type { Run } from '../../protocol/domain.ts';

/** Synthetic data for storage and browser checks; contains no captured sessions. */
export function sampleRun(): Run {
  const createdAt = '2026-01-01T00:00:00.000Z';
  const completedAt = '2026-01-01T00:01:00.000Z';
  const agents = ['implementer', 'test_author', 'reviewer'].map((name) => ({
    threadId: 'fixture-' + name,
    name,
    agentPath: '/root/' + name,
    startedAt: createdAt,
    completedAt,
    messages: ['Fixture work completed.'],
    commands: 0,
    status: 'completed',
    assignment: { paths: [] },
  }));
  return {
    id: 'R-example',
    key: 'GOAL-001',
    goalId: 'G-example',
    title: 'Improve CLI feedback',
    summary: 'Readable status and a stable JSON mode.',
    createdAt,
    completedAt,
    threadId: 'fixture-coordinator',
    status: 'completed',
    phase: 'done',
    agents,
    events: [
      { at: createdAt, type: 'thread.started', threadId: 'fixture-coordinator' },
      ...agents.map((agent) => ({
        at: createdAt,
        type: 'agent.started',
        threadId: agent.threadId,
        text: agent.agentPath,
      })),
      { at: completedAt, type: 'goal.completed', text: 'Fixture checks passed.' },
    ],
    commands: [],
    plan: [{ step: 'Improve CLI feedback', owner: 'implementer' }],
    changedFiles: [],
    baseline: { passed: 1, total: 1, results: [{ name: 'Tests', passed: true }] },
    acceptance: { passed: 1, total: 1, results: [{ name: 'Tests', passed: true }] },
    specsUnchanged: true,
    scopePreserved: true,
    independentReviewer: true,
    goalText: 'Improve CLI feedback and preserve the JSON output contract.',
    result: 'Implementation verified with tests and independent review.',
    sourceHash: '',
  };
}
