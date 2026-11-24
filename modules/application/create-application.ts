import path from 'node:path';
import { AgentService } from '../agents/agent-service.ts';
import { sessionTools } from '../agents/session-tools.ts';
import { commandTools } from '../commands/command-tools.ts';
import { SandboxedCommands } from '../commands/sandboxed-commands.ts';
import { EventBus } from '../events/event-bus.ts';
import { fileTools } from '../files/file-tools.ts';
import { ModelCatalog } from '../models/model-catalog.ts';
import { ModelRegistry } from '../models/model-registry.ts';
import { modelTransports } from '../models/transports.ts';
import type { ModelTransport } from '../models/model-configuration.ts';
import { ProjectService } from '../projects/project-service.ts';
import { RunService } from '../runs/run-service.ts';
import { ResultService } from '../results/result-service.ts';
import { GitChanges } from '../results/git-changes.ts';
import { ActivityLog } from '../sessions/activity.ts';
import { SessionService } from '../sessions/session-service.ts';
import { SettingsService } from '../settings/settings-service.ts';
import type { StorageEngine } from '../storage/record-store.ts';
import { SqliteStorage } from '../storage/sqlite-storage.ts';
import { TaskService } from '../tasks/task-service.ts';
import { ToolRegistry } from '../tools/tool-registry.ts';
import { GitWorkspaces } from '../workspaces/git-workspaces.ts';
import type { Application } from './application.ts';

/** Composes one server process with usable defaults and replaceable boundary adapters. */
export async function createApplication(input: {
  directory: string;
  storage?: StorageEngine;
  transports?: ModelTransport[];
  fetch?: typeof fetch;
  report?: (error: unknown) => void;
}): Promise<Application> {
  const privateDirectory = path.resolve(input.directory, 'private');
  const storage =
    input.storage ?? new SqliteStorage({ filename: path.join(privateDirectory, 'state.sqlite') });
  const events = new EventBus({ report: input.report });
  const settings = new SettingsService({ store: storage.records('settings'), events });
  const models = new ModelRegistry({ adapterState: storage.records('model-continuations') });
  const modelConfigurations = new ModelCatalog({
    store: storage.records('model-connections'),
    models,
    settings,
    events,
    transports: input.transports ?? modelTransports({ fetch: input.fetch }),
  });
  const projects = new ProjectService({ store: storage.records('projects'), events });
  const tasks = new TaskService({ store: storage.records('tasks'), events });
  const agents = new AgentService({ store: storage.records('agents'), events });
  const activity = new ActivityLog({ store: storage.records('activity') });
  const tools = new ToolRegistry();
  const sessions = new SessionService({
    store: storage.records('sessions'),
    models,
    tools,
    activity,
    events,
  });
  const workspaces = new GitWorkspaces({ directory: path.join(input.directory, 'workspaces') });
  const commands = new SandboxedCommands({ privatePaths: [privateDirectory] });
  for (const tool of [
    ...fileTools({ commands, projects }),
    ...commandTools({ commands, projects }),
    ...sessionTools({ sessions, models, agents, events }),
  ])
    tools.register(tool);
  const runs = new RunService({
    store: storage.records('runs'),
    tasks,
    projects,
    sessions,
    workspaces,
    settings,
    events,
  });
  const results = new ResultService({ runs, projects, changes: new GitChanges(), events });
  try {
    await modelConfigurations.initialize();
    await sessions.recover();
    await runs.recover();
  } catch (error) {
    await storage.close();
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    agents,
    events,
    models,
    modelConfigurations,
    projects,
    tasks,
    runs,
    results,
    sessions,
    activity,
    settings,
    tools,
    close() {
      return (closing ??= (async () => {
        try {
          await runs.close();
          await sessions.close();
        } finally {
          try {
            await commands.close();
          } finally {
            await storage.close();
          }
        }
      })());
    },
  };
}
