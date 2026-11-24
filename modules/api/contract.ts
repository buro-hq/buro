import type { Agent } from '../agents/agent.ts';
import type { Notification } from '../events/notifications.ts';
import type {
  ModelConfigurationInput,
  ModelConfigurationView,
  ModelConfigurationResult,
} from '../models/model-configuration.ts';
import type { Project, ProjectResult } from '../projects/project.ts';
import type { Run, RunOptions, RunResult } from '../runs/run.ts';
import type { ResultOutcome } from '../results/result.ts';
import type { Material, MaterialOutcome } from '../materials/material.ts';
import type { Activity } from '../sessions/activity.ts';
import type { Session } from '../sessions/session.ts';
import type { ApplicationSettings } from '../settings/settings.ts';
import type { Task, TaskInput } from '../tasks/task.ts';

/** Browser, CLI and external callers share the same feature commands and results. */
export interface ApiMethods {
  'projects.list': { params: {}; result: Project[] };
  'projects.get': { params: { id: string }; result: Project | undefined };
  'projects.connect': { params: { root: string; name?: string }; result: ProjectResult };
  'projects.disconnect': { params: { id: string }; result: void };
  'tasks.list': { params: { projectId?: string }; result: Task[] };
  'tasks.get': { params: { id: string }; result: Task | undefined };
  'tasks.create': { params: TaskInput; result: Task };
  'tasks.update': { params: TaskInput & { id: string }; result: Task | undefined };
  'tasks.delete': { params: { id: string }; result: void };
  'runs.list': { params: { projectId?: string; taskId?: string }; result: Run[] };
  'runs.get': { params: { id: string }; result: Run | undefined };
  'runs.start': { params: { taskId: string; options?: RunOptions }; result: RunResult };
  'runs.retry': { params: { id: string; options?: RunOptions }; result: RunResult };
  'runs.cancel': { params: { id: string }; result: void };
  'results.inspect': { params: { runId: string }; result: ResultOutcome };
  'results.apply': { params: { runId: string; revision?: string }; result: ResultOutcome };
  'materials.list': { params: { projectId: string; taskId?: string }; result: Material[] };
  'materials.upload': {
    params: { projectId: string; taskId?: string; name: string; contentBase64: string };
    result: MaterialOutcome;
  };
  'materials.read': {
    params: { id: string; line?: number; count?: number };
    result: MaterialOutcome;
  };
  'materials.download': { params: { id: string }; result: MaterialOutcome };
  'materials.delete': { params: { id: string }; result: void };
  'sessions.list': { params: { runId?: string }; result: Session[] };
  'sessions.get': { params: { id: string }; result: Session | undefined };
  'sessions.model': { params: { sessionId: string; modelId: string }; result: boolean };
  'activity.list': { params: { sessionId?: string; runId?: string }; result: Activity[] };
  'agents.list': { params: {}; result: Agent[] };
  'agents.save': { params: Omit<Agent, 'id'> & { id?: string }; result: Agent };
  'agents.delete': { params: { id: string }; result: void };
  'models.list': { params: {}; result: ModelConfigurationView[] };
  'models.save': { params: ModelConfigurationInput; result: ModelConfigurationResult };
  'models.default': { params: { id: string }; result: boolean };
  'models.delete': { params: { id: string }; result: void };
  'settings.get': { params: {}; result: ApplicationSettings };
  'settings.update': { params: { instructions?: string }; result: ApplicationSettings };
}

/** Public messages contain no private transport continuation or API credentials. */
export interface ApiRequest {
  id: string;
  method: string;
  params: unknown;
}

/** Expected application outcomes are returned inside result; transport failures use error. */
export interface ApiResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Notifications announce changes; clients read current feature state after reconnecting. */
export interface ApiNotification {
  type: 'notification';
  notification: Notification;
}

/** Local clients authenticate before reading state or dispatching a command. */
export interface ApiAuthenticated {
  type: 'authenticated';
}
