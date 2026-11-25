import type { Agents } from '../agents/agent.ts';
import type { Notifications } from '../events/notifications.ts';
import type { ModelConfigurations } from '../models/model-configuration.ts';
import type { Models } from '../models/model.ts';
import type { Materials } from '../materials/material.ts';
import type { Projects } from '../projects/project.ts';
import type { Previews } from '../previews/preview.ts';
import type { Deliveries } from '../deliveries/delivery.ts';
import type { Runs } from '../runs/run.ts';
import type { Results } from '../results/result.ts';
import type { ActivityHistory } from '../sessions/activity.ts';
import type { Sessions } from '../sessions/session.ts';
import type { Settings } from '../settings/settings.ts';
import type { Tasks } from '../tasks/task.ts';
import type { Tools } from '../tools/tool.ts';
import type { StorageEngine } from '../storage/record-store.ts';
import type { ModelTransport } from '../models/model-configuration.ts';
import type { ResultPublisher } from '../deliveries/delivery.ts';
import type { MaterialLoader } from '../materials/material.ts';

/** Replaceable process boundaries with working defaults. */
export interface ApplicationOptions {
  directory: string;
  storage?: StorageEngine;
  transports?: ModelTransport[];
  publishers?: ResultPublisher[];
  materialLoaders?: MaterialLoader[];
  fetch?: typeof fetch;
  report?: (error: unknown) => void;
}

/** The process composes independent feature APIs; it owns no mutable domain snapshot. */
export interface Application {
  agents: Agents;
  events: Notifications;
  models: Models;
  materials: Materials;
  modelConfigurations: ModelConfigurations;
  projects: Projects;
  previews: Previews;
  deliveries: Deliveries;
  runs: Runs;
  results: Results;
  sessions: Sessions;
  activity: ActivityHistory;
  settings: Settings;
  tasks: Tasks;
  tools: Tools;
  /** Stops execution while transport owners drain outstanding API operations. */
  stopWork(): Promise<void>;
  /** Stops work before releasing environment and storage resources. */
  close(): Promise<void>;
}
