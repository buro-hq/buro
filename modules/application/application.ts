import type { Agents } from '../agents/agent.ts';
import type { Notifications } from '../events/notifications.ts';
import type { ModelConfigurations } from '../models/model-configuration.ts';
import type { Models } from '../models/model.ts';
import type { Materials } from '../materials/material.ts';
import type { Projects } from '../projects/project.ts';
import type { Runs } from '../runs/run.ts';
import type { Results } from '../results/result.ts';
import type { ActivityHistory } from '../sessions/activity.ts';
import type { Sessions } from '../sessions/session.ts';
import type { Settings } from '../settings/settings.ts';
import type { Tasks } from '../tasks/task.ts';
import type { Tools } from '../tools/tool.ts';

/** The process composes independent feature APIs; it owns no mutable domain snapshot. */
export interface Application {
  agents: Agents;
  events: Notifications;
  models: Models;
  materials: Materials;
  modelConfigurations: ModelConfigurations;
  projects: Projects;
  runs: Runs;
  results: Results;
  sessions: Sessions;
  activity: ActivityHistory;
  settings: Settings;
  tasks: Tasks;
  tools: Tools;
  /** Stops work before releasing environment and storage resources. */
  close(): Promise<void>;
}
