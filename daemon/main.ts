import { EnvironmentExecutors } from '../adapters/environments/executors.ts';
import { ProjectEnvironments } from '../adapters/environments/project-environments.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHost } from '../plugins/host.ts';
import { websocketPlugin } from './websocket.ts';
import { resourcesPlugin } from '../plugins/resources.ts';
import { executionPlugin } from '../plugins/execution.ts';
import { GitWorkspaces } from '../adapters/files/git-workspaces.ts';
import { ProjectChecks } from '../adapters/checks/project-commands.ts';
import { projectManagementPlugin } from '../plugins/project-management.ts';
import type { ExecutionPolicy } from '../core/execution-ports.ts';
import { NodeChecks } from '../adapters/checks/node-checks.ts';
import { defaultRoles } from '../core/defaults.ts';
import { projectOperationsPlugin } from '../plugins/project-operations.ts';
import { NativeProjectOperations } from '../adapters/processes/project-operations.ts';

import { migrateProjectDirectory } from '../adapters/files/project-directory.ts';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PROJECT_DAEMON_PORT || 4341);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Invalid daemon port.');
if (!process.env.PROJECT_DATA_DIR) await migrateProjectDirectory(root);
const directory = process.env.PROJECT_DATA_DIR || path.join(root, '.buro');
const host = await createHost({
  projects: [
    { directory, project: { id: 'codex-panel', name: 'Buro', root } },
    {
      directory: path.join(directory, 'goal-poc'),
      project: { id: 'goal-poc', name: 'Goal workflow · PoC', root },
      roles: defaultRoles.filter((r) => ['coordinator', 'reviewer'].includes(r.id)),
    },
  ],
});
const checks = [
  { id: 'session_list', title: 'Session list', script: path.join(root, 'checks/session-list.mjs') },
  {
    id: 'session_select',
    title: 'Session selection',
    script: path.join(root, 'checks/session-select.mjs'),
  },
];
const policy = {
  allowedPaths: ['experiments/goals/'],
  checks: checks.map(({ id, title }) => ({ id, title })),
  defaultCheckIds: ['session_list'],
  maxWorkers: 2,
  maxRepairs: 2,
  turnTimeoutMs: 360000,
};
const policies: Record<string, ExecutionPolicy> = { 'codex-panel': policy, 'goal-poc': policy };
const executors = new EnvironmentExecutors();
const workspaces = new GitWorkspaces(host.ctx.projects.registry),
  checkAdapter = new ProjectChecks(
    host.ctx.projects.registry,
    new NodeChecks({ 'codex-panel': checks, 'goal-poc': checks }),
    executors,
  );
try {
  await host.ctx.plugin(resourcesPlugin, { directory, executors, workspaces });
  const environments = new ProjectEnvironments(
    host.ctx.projects.registry,
    host.ctx.agentRuntime.adapter,
    executors,
    host.ctx.agentRuntime.selection,
  );
  await host.ctx.plugin(projectManagementPlugin, {
    environments,
    catalogFile: path.join(directory, 'linked-projects.json'),
    policies,
    workspaces,
    checks: checkAdapter,
  });
  await host.ctx.plugin(projectOperationsPlugin, { operations: new NativeProjectOperations() });
  await host.ctx.plugin(executionPlugin, {
    policies,
    workspaces,
    checks: checkAdapter,
    environments,
  });
  await host.ctx.plugin(websocketPlugin, {
    port,
    onListen: (p) => console.log(`Buro daemon: ws://127.0.0.1:${p} · data: ${directory}`),
  });
} catch (e) {
  await host.dispose();
  throw e;
}
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await host.dispose();
}
process.on('SIGINT', () => void stop().then(() => process.exit(0)));
process.on('SIGTERM', () => void stop().then(() => process.exit(0)));
