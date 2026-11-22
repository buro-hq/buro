import path from 'node:path';
import type { ExecutionPolicy } from '../core/execution-ports.ts';
import type { ProjectStoreOpenSpec } from '../core/ports.ts';
import type { TrustedCheck } from '../adapters/checks/node-checks.ts';
import {
  createBuiltinRoleTemplates,
  createBuiltinWorkflowRoles,
} from '../adapters/workflows/builtins.ts';
import { instantiateWorkflowRole } from '../core/workflow-roles.ts';

/** Explicit development fixture. Ordinary application startup never loads these projects. */
export function demoBootstrap(root: string, directory: string) {
  const checks: TrustedCheck[] = [
    {
      id: 'session_list',
      title: 'Session list',
      script: path.join(root, 'checks/session-list.mjs'),
      sourceRoot: root,
    },
    {
      id: 'session_select',
      title: 'Session selection',
      script: path.join(root, 'checks/session-select.mjs'),
      sourceRoot: root,
    },
  ];
  const templates = createBuiltinRoleTemplates(),
    workflow = createBuiltinWorkflowRoles().workflow,
    now = new Date().toISOString();
  const projects: ProjectStoreOpenSpec[] = ['demo-buro', 'demo-goals'].map((id, index) => ({
    storageAddress: path.join(directory, 'demo', id),
    project: { id, name: index ? 'Goal workflow · Demo' : 'Buro · Demo', root },
    roles: ['coordinator', 'reviewer'].map((id) =>
      instantiateWorkflowRole(templates.get(id), workflow, id, now),
    ),
  }));
  const policy: ExecutionPolicy = {
    scope: { mode: 'advisory', plannedPaths: ['experiments/goals/'], protectedPaths: [] },
    checks: checks.map(({ id, title }) => ({ id, title })),
    defaultCheckIds: ['session_list'],
    maxWorkers: 2,
    maxRepairs: 2,
    turnTimeoutMs: 360000,
  };
  return {
    projects,
    checks: Object.fromEntries(projects.map(({ project }) => [project.id, checks])),
    policies: Object.fromEntries(
      projects.map(({ project }) => [project.id, structuredClone(policy)]),
    ),
  };
}
