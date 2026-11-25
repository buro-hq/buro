import type { Agent } from '../agents/agent.ts';
import type { Notification } from '../events/notifications.ts';
import type {
  ModelConfigurationInput,
  ModelConfigurationView,
  ModelConfigurationResult,
  ModelDiscoveryInput,
  ModelDiscoveryResult,
} from '../models/model-configuration.ts';
import type { Project, ProjectResult } from '../projects/project.ts';
import type { Preview, PreviewOutcome } from '../previews/preview.ts';
import type { Delivery, DeliveryOutcome, Deliveries } from '../deliveries/delivery.ts';
import type { Run, RunOptions, RunResult } from '../runs/run.ts';
import type { ResultOutcome } from '../results/result.ts';
import type { Material, MaterialOutcome } from '../materials/material.ts';
import type { Activity } from '../sessions/activity.ts';
import type { Session, SessionHistory, SessionHistoryQuery } from '../sessions/session.ts';
import type { ApplicationSettings } from '../settings/settings.ts';
import type { Task, TaskInput } from '../tasks/task.ts';

/** Read operations are safe to refresh after notifications or reconnecting. */
export interface ApiQueries {
  'projects.list': { params: {}; result: Project[] };
  'projects.get': { params: { id: string }; result: Project | undefined };
  'previews.list': { params: { runId?: string }; result: Preview[] };
  'previews.get': { params: { id: string }; result: Preview | undefined };
  'deliveries.list': { params: { runId?: string }; result: Delivery[] };
  'deliveries.publishers': { params: {}; result: { id: string; name: string }[] };
  'tasks.list': { params: { projectId?: string }; result: Task[] };
  'tasks.get': { params: { id: string }; result: Task | undefined };
  'runs.list': { params: { projectId?: string; taskId?: string }; result: Run[] };
  'runs.get': { params: { id: string }; result: Run | undefined };
  'results.inspect': { params: { runId: string }; result: ResultOutcome };
  'materials.list': { params: { projectId: string; taskId?: string }; result: Material[] };
  'materials.read': {
    params: { id: string; line?: number; count?: number };
    result: MaterialOutcome;
  };
  'materials.download': { params: { id: string }; result: MaterialOutcome };
  'sessions.list': { params: { runId?: string }; result: Session[] };
  'sessions.get': { params: { id: string }; result: Session | undefined };
  'sessions.messages': { params: SessionHistoryQuery; result: SessionHistory };
  'activity.list': { params: { sessionId?: string; runId?: string }; result: Activity[] };
  'agents.list': { params: {}; result: Agent[] };
  'models.list': { params: {}; result: ModelConfigurationView[] };
  'models.transports': { params: {}; result: { id: string; name: string }[] };
  'models.discover': { params: ModelDiscoveryInput; result: ModelDiscoveryResult };
  'settings.get': { params: {}; result: ApplicationSettings };
}

/** Commands execute once; losing a connection never causes automatic mutation replay. */
export interface ApiCommands {
  'projects.connect': { params: { root: string; name?: string }; result: ProjectResult };
  'projects.disconnect': { params: { id: string }; result: void };
  'previews.start': {
    params: { runId: string; command: string; env?: Record<string, string>; port?: number };
    result: PreviewOutcome;
  };
  'previews.stop': { params: { id: string }; result: void };
  'deliveries.publish': { params: Parameters<Deliveries['publish']>[0]; result: DeliveryOutcome };
  'tasks.create': { params: TaskInput; result: Task };
  'tasks.update': { params: TaskInput & { id: string }; result: Task | undefined };
  'tasks.delete': { params: { id: string }; result: void };
  'runs.start': { params: { taskId: string; options?: RunOptions }; result: RunResult };
  'runs.retry': { params: { id: string; options?: RunOptions }; result: RunResult };
  'runs.cancel': { params: { id: string }; result: void };
  'results.apply': { params: { runId: string; revision?: string }; result: ResultOutcome };
  'materials.upload': {
    params: { projectId: string; taskId?: string; name: string; contentBase64: string };
    result: MaterialOutcome;
  };
  'materials.delete': { params: { id: string }; result: void };
  'sessions.model': { params: { sessionId: string; modelId: string }; result: boolean };
  'agents.save': { params: Omit<Agent, 'id'> & { id?: string }; result: Agent };
  'agents.delete': { params: { id: string }; result: void };
  'models.save': { params: ModelConfigurationInput; result: ModelConfigurationResult };
  'models.default': { params: { id: string }; result: boolean };
  'models.delete': { params: { id: string }; result: void };
  'settings.update': { params: { instructions?: string }; result: ApplicationSettings };
}

/** Browser, CLI and external callers share one transport for feature APIs. */
export interface ApiMethods extends ApiQueries, ApiCommands {}

/** Validated dispatch entry points with the result type of each public operation. */
export type ApiHandlers = {
  [K in keyof ApiMethods]: (params: unknown) => Promise<ApiMethods[K]['result']>;
};

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
