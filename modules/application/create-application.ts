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
import { MaterialService } from '../materials/material-service.ts';
import { materialTools } from '../materials/material-tools.ts';
import { ProjectService } from '../projects/project-service.ts';
import { PreviewService } from '../previews/preview-service.ts';
import { DeliveryService } from '../deliveries/delivery-service.ts';
import { GitHubPublisher } from '../deliveries/github-publisher.ts';
import { previewTools } from '../previews/preview-tools.ts';
import { RunService } from '../runs/run-service.ts';
import { ResultService } from '../results/result-service.ts';
import { GitChanges } from '../results/git-changes.ts';
import { ActivityLog } from '../sessions/activity-log.ts';
import { SessionService } from '../sessions/session-service.ts';
import { SettingsService } from '../settings/settings-service.ts';
import type { StorageEngine } from '../storage/record-store.ts';
import { SqliteStorage } from '../storage/sqlite-storage.ts';
import { TaskService } from '../tasks/task-service.ts';
import { ToolRegistry } from '../tools/tool-registry.ts';
import { GitWorkspaces } from '../workspaces/git-workspaces.ts';
import type { Application, ApplicationOptions } from './application.ts';
import { closeResources } from './close-resources.ts';
import { ownApplication, type ApplicationOwnership } from './ownership.ts';

/** Composes one server process with usable defaults and replaceable boundary adapters. */
export async function createApplication(input: ApplicationOptions): Promise<Application> {
  const ownership = ownApplication({ directory: input.directory });
  let storage: StorageEngine | undefined;
  try {
    storage =
      input.storage ??
      new SqliteStorage({ filename: path.resolve(input.directory, 'private/state.sqlite') });
    return await composeApplication({ options: input, storage, ownership });
  } catch (error) {
    try {
      await closeResources({ steps: [() => storage?.close(), () => ownership.close()] });
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Application initialization failed.');
    }
    throw error;
  }
}

async function composeApplication(scope: {
  options: ApplicationOptions;
  storage: StorageEngine;
  ownership: ApplicationOwnership;
}): Promise<Application> {
  const { options: input, storage, ownership } = scope;
  const privateDirectory = path.resolve(input.directory, 'private');
  const events = new EventBus({ report: input.report });
  const settings = new SettingsService({ store: storage.records('settings'), events });
  const models = new ModelRegistry({ adapterState: storage.records('model-continuations') });
  const modelConfigurations = new ModelCatalog({
    store: storage.records('model-connections'),
    models,
    settings,
    events,
    transports:
      input.transports ?? modelTransports({ fetch: input.fetch, privatePaths: [privateDirectory] }),
  });
  const projects = new ProjectService({ store: storage.records('projects'), events });
  const tasks = new TaskService({ store: storage.records('tasks'), events });
  const agents = new AgentService({ store: storage.records('agents'), events });
  const materials = new MaterialService({
    store: storage.records('materials'),
    events,
    loaders: input.materialLoaders,
  });
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
    materials,
    events,
  });
  const results = new ResultService({ runs, projects, changes: new GitChanges(), events });
  const previews = new PreviewService({
    store: storage.records('previews'),
    runs,
    projects,
    commands,
    events,
  });
  for (const tool of previewTools({ previews })) tools.register(tool);
  const deliveries = new DeliveryService({
    store: storage.records('deliveries'),
    runs,
    projects,
    tasks,
    results,
    events,
    publishers: input.publishers ?? [
      new GitHubPublisher({ directory: path.join(input.directory, 'publications') }),
    ],
  });
  for (const tool of materialTools({ materials, runs })) tools.register(tool);
  try {
    await modelConfigurations.initialize();
    await sessions.recover();
    await runs.recover();
    await previews.recover();
    await deliveries.recover();
  } catch (error) {
    await commands.close();
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    agents,
    events,
    models,
    materials,
    modelConfigurations,
    projects,
    previews,
    deliveries,
    tasks,
    runs,
    results,
    sessions,
    activity,
    settings,
    tools,
    close() {
      return (closing ??= closeResources({
        steps: [
          () => runs.close(),
          () => sessions.close(),
          () => deliveries.close(),
          () => previews.close(),
          () => commands.close(),
          () => storage.close(),
          () => ownership.close(),
        ],
      }));
    },
  };
}
