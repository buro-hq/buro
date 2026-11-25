import { z } from 'zod';
import type { Application } from '../application/application.ts';
import type { ApiMethods } from './contract.ts';

const id = z.object({ id: z.string() });
const empty = z.object({});
const task = z.object({ projectId: z.string(), title: z.string(), description: z.string() });
const runOptions = z.object({
  modelId: z.string().optional(),
  instructions: z.string().optional(),
  tools: z.array(z.string()).optional(),
  readOnly: z.boolean().optional(),
  base: z.string().optional(),
});
const configuration = z.object({
  id: z.string().optional(),
  name: z.string(),
  transport: z.string(),
  endpoint: z.string().optional(),
  model: z.string(),
  contextTokens: z.number().int().positive().optional(),
  outputTokens: z.number().int().positive().optional(),
  local: z.boolean().optional(),
  thinking: z.boolean().optional(),
  reasoningEffort: z.string().nullable().optional(),
  reasoningBudgetTokens: z.number().int().min(-1).nullable().optional(),
  capacity: z.number().int().positive().nullable().optional(),
  retries: z.number().int().nonnegative().nullable().optional(),
  sampling: z
    .object({
      temperature: z.number().nonnegative().optional(),
      topP: z.number().min(0).max(1).optional(),
      presencePenalty: z.number().optional(),
    })
    .nullable()
    .optional(),
});

function method<P, R>(
  schema: z.ZodType<P>,
  execute: (params: P) => R | Promise<R>,
): (input: unknown) => Promise<R> {
  return async (input) => await execute(schema.parse(input));
}

/** Validates untrusted command input once, at the application transport boundary. */
export function apiMethods(app: Application): {
  [K in keyof ApiMethods]: (params: unknown) => Promise<ApiMethods[K]['result']>;
} {
  return {
    'projects.list': method(empty, () => app.projects.list()),
    'projects.get': method(id, (input) => app.projects.get(input)),
    'projects.connect': method(
      z.object({ root: z.string(), name: z.string().optional() }),
      (input) => app.projects.connect(input),
    ),
    'projects.disconnect': method(id, (input) => app.projects.disconnect(input)),
    'previews.list': method(z.object({ runId: z.string().optional() }), (input) =>
      app.previews.list(input),
    ),
    'previews.get': method(id, (input) => app.previews.get(input)),
    'previews.start': method(
      z.object({
        runId: z.string(),
        command: z.string(),
        port: z.number().int().min(1).max(65535).optional(),
        env: z.record(z.string(), z.string()).optional(),
      }),
      (input) => app.previews.start(input),
    ),
    'previews.stop': method(id, (input) => app.previews.stop(input)),
    'deliveries.list': method(z.object({ runId: z.string().optional() }), (input) =>
      app.deliveries.list(input),
    ),
    'deliveries.publishers': method(empty, () => app.deliveries.publishers()),
    'deliveries.publish': method(
      z.object({
        runId: z.string(),
        publisherId: z.string().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        remote: z.string().optional(),
        branch: z.string().optional(),
        base: z.string().optional(),
        revision: z.string().optional(),
      }),
      (input) => app.deliveries.publish(input),
    ),
    'tasks.list': method(z.object({ projectId: z.string().optional() }), (input) =>
      app.tasks.list(input),
    ),
    'tasks.get': method(id, (input) => app.tasks.get(input)),
    'tasks.create': method(task, (input) => app.tasks.create(input)),
    'tasks.update': method(task.extend({ id: z.string() }), (input) => app.tasks.update(input)),
    'tasks.delete': method(id, (input) => app.tasks.delete(input)),
    'runs.list': method(
      z.object({ projectId: z.string().optional(), taskId: z.string().optional() }),
      (input) => app.runs.list(input),
    ),
    'runs.get': method(id, (input) => app.runs.get(input)),
    'runs.start': method(
      z.object({ taskId: z.string(), options: runOptions.optional() }),
      (input) => app.runs.start(input),
    ),
    'runs.retry': method(z.object({ id: z.string(), options: runOptions.optional() }), (input) =>
      app.runs.retry(input),
    ),
    'runs.cancel': method(id, (input) => app.runs.cancel(input)),
    'results.inspect': method(z.object({ runId: z.string() }), (input) =>
      app.results.inspect(input),
    ),
    'results.apply': method(
      z.object({ runId: z.string(), revision: z.string().optional() }),
      (input) => app.results.apply(input),
    ),
    'materials.list': method(
      z.object({ projectId: z.string(), taskId: z.string().optional() }),
      (input) => app.materials.list(input),
    ),
    'materials.upload': method(
      z.object({
        projectId: z.string(),
        taskId: z.string().optional(),
        name: z.string(),
        contentBase64: z.string(),
      }),
      (input) => app.materials.upload(input),
    ),
    'materials.read': method(
      id.extend({
        line: z.number().int().positive().optional(),
        count: z.number().int().positive().optional(),
      }),
      (input) => app.materials.read(input),
    ),
    'materials.download': method(id, (input) => app.materials.download(input)),
    'materials.delete': method(id, (input) => app.materials.delete(input)),
    'sessions.list': method(z.object({ runId: z.string().optional() }), (input) =>
      app.sessions.list(input),
    ),
    'sessions.get': method(id, (input) => app.sessions.get(input)),
    'sessions.messages': method(
      z
        .object({
          sessionId: z.string(),
          before: z.number().int().nonnegative().optional(),
          after: z.number().int().min(-1).optional(),
          limit: z.number().int().min(1).max(250).optional(),
        })
        .refine((input) => input.before === undefined || input.after === undefined, {
          message: 'Use either the before or after cursor.',
        }),
      (input) => app.sessions.history(input),
    ),
    'sessions.model': method(z.object({ sessionId: z.string(), modelId: z.string() }), (input) =>
      app.sessions.switchModel(input),
    ),
    'activity.list': method(
      z.object({ sessionId: z.string().optional(), runId: z.string().optional() }),
      (input) => app.activity.list(input),
    ),
    'agents.list': method(empty, () => app.agents.list()),
    'agents.save': method(
      z.object({
        id: z.string().optional(),
        name: z.string(),
        description: z.string(),
        instructions: z.string(),
        tools: z.array(z.string()).optional(),
      }),
      (input) => app.agents.save(input),
    ),
    'agents.delete': method(id, (input) => app.agents.delete(input)),
    'models.list': method(empty, () => app.modelConfigurations.list()),
    'models.transports': method(empty, () => app.modelConfigurations.transports()),
    'models.discover': method(
      z.object({
        configuration: configuration.partial().extend({ transport: z.string() }),
        apiKey: z.string().nullable().optional(),
      }),
      (input) => app.modelConfigurations.discover(input),
    ),
    'models.save': method(
      z.object({
        configuration,
        apiKey: z.string().nullable().optional(),
        default: z.boolean().optional(),
      }),
      (input) => app.modelConfigurations.save(input),
    ),
    'models.default': method(id, (input) => app.modelConfigurations.select(input)),
    'models.delete': method(id, (input) => app.modelConfigurations.delete(input)),
    'settings.get': method(empty, () => app.settings.get()),
    'settings.update': method(z.object({ instructions: z.string().optional() }), (input) =>
      app.settings.update(input),
    ),
  };
}
