import type { Role } from '../protocol/domain.ts';
const createdAt = '2026-11-09T00:00:00.000Z';
export const defaultRoles: Role[] = [
  {
    id: 'implementer',
    kind: 'implementation',
    title: 'Developer',
    description: 'Implements agreed changes.',
    instructions:
      'Implement the assigned task within your owned files. Verify the result and report actual limitations.',
  },
  {
    id: 'test_author',
    kind: 'testing',
    title: 'Test author',
    description: 'Independently verifies task requirements.',
    instructions:
      'Write checks from task requirements. Stay independent of the implementation, run the checks and report actual results.',
  },
  {
    id: 'reviewer',
    kind: 'review',
    title: 'Reviewer',
    description: 'Checks result correctness.',
    instructions:
      'Review the changes and actual checks. Return approved or changes_requested with concrete blocking findings. Do not edit sources.',
  },
  {
    id: 'coordinator',
    kind: 'coordination',
    title: 'Coordinator',
    description: 'Plans and integrates team work.',
    instructions:
      'Create a plan, assign suitable roles, integrate results and obtain independent acceptance.',
  },
].map((r) => ({ ...r, version: 1, createdAt, updatedAt: createdAt })) as Role[];
export const capabilities = ['history.read', 'goals.write', 'roles.write', 'events.subscribe'];
