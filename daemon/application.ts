import path from 'node:path';
import { EnvironmentExecutors } from '../adapters/environments/executors.ts';
import { ProjectEnvironments } from '../adapters/environments/project-environments.ts';
import { GitWorkspaces } from '../adapters/files/git-workspaces.ts';
import { ProjectChecks } from '../adapters/checks/project-commands.ts';
import { NodeChecks } from '../adapters/checks/node-checks.ts';
import { NativeProjectOperations } from '../adapters/processes/project-operations.ts';
import type { ProjectStoreFactory } from '../core/ports.ts';
import type { ExecutionPolicy } from '../core/execution-ports.ts';
import { createHost, type HostOptions } from '../plugins/host.ts';
import { resourcesPlugin } from '../plugins/resources.ts';
import { projectManagementPlugin } from '../plugins/project-management.ts';
import { projectOperationsPlugin } from '../plugins/project-operations.ts';
import { executionPlugin } from '../plugins/execution.ts';
import { findProjectDirectory } from '../adapters/files/project-directory.ts';
import { PROJECT_DIRECTORY } from '../protocol/project-directory.ts';

/** Production composition without sockets, process handlers or implicit demo project state. */
export async function createBuroApplication(options: {
  root: string;
  directory: string;
  demo?: boolean;
  storeFactory?: ProjectStoreFactory;
  fetch?: typeof fetch;
  credentials?: (reference: string) => string | undefined;
  configure?: HostOptions['configure'];
  projectContributions?: HostOptions['projectContributions'];
  toolContributions?: HostOptions['toolContributions'];
  analysisId?: string;
  workflowId?: string;
}) {
  if (path.resolve(options.directory) === path.join(path.resolve(options.root), PROJECT_DIRECTORY))
    await findProjectDirectory(options.root);
  const fixture = options.demo
    ? (await import('./demo.ts')).demoBootstrap(options.root, options.directory)
    : undefined;
  const host = await createHost({
    projects: fixture?.projects,
    storeFactory: options.storeFactory,
    configure: options.configure,
    projectContributions: options.projectContributions,
    toolContributions: options.toolContributions,
  });
  try {
    const policies: Record<string, ExecutionPolicy> = fixture?.policies || {};
    const executors = new EnvironmentExecutors();
    const workspaces = new GitWorkspaces(host.ctx.projects.registry);
    const checks = new ProjectChecks(
      host.ctx.projects.registry,
      new NodeChecks(fixture?.checks || {}),
      executors,
    );
    await host.ctx.plugin(resourcesPlugin, {
      directory: options.directory,
      executors,
      workspaces,
      checks,
      fetch: options.fetch,
      credentials: options.credentials,
    });
    const environments = new ProjectEnvironments(
      host.ctx.projects.registry,
      host.ctx.agentRuntime.adapter,
      executors,
      host.ctx.agentRuntime.selection,
    );
    await host.ctx.plugin(projectManagementPlugin, {
      environments,
      catalogFile: path.join(options.directory, 'linked-projects.json'),
      policies,
      workspaces,
      checks,
    });
    await host.ctx.plugin(projectOperationsPlugin, {
      operations: new NativeProjectOperations(),
      analysisId: options.analysisId,
      workflowId: options.workflowId,
    });
    await host.ctx.plugin(executionPlugin, {
      policies,
      workspaces,
      checks,
      environments,
      workflowId: options.workflowId,
    });
    return host;
  } catch (error) {
    await host.dispose().catch(() => {});
    throw error;
  }
}
