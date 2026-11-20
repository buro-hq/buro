import { z } from 'zod';

/** A coordinator proposal for one assignment; it never expands the worker's tool authority. */
export const WorkerTaskSchema = z.strictObject({
  objective: z.string().trim().min(1).max(2000),
  inputs: z.array(z.string().min(1).max(512)).max(16),
  expectedResult: z.string().trim().min(1).max(2000),
  criteria: z.array(z.string().trim().min(1).max(1000)).min(1).max(8),
});
export type WorkerTask = z.infer<typeof WorkerTaskSchema>;
export const WorkerRefinementSchema = WorkerTaskSchema.pick({ objective: true, inputs: true });
export const workerRefinementOutputSchema = z.toJSONSchema(WorkerRefinementSchema);

export const WorkerKnownFailureSchema = z.strictObject({
  code: z.enum(['MODEL_INCOMPLETE', 'MODEL_CONTEXT_EXHAUSTED']),
  scopeVerified: z.literal(true),
});

const replan = z.strictObject({
  roleId: z.string().min(1),
  failedSessionId: z.string().min(1),
  failureCode: WorkerKnownFailureSchema.shape.code,
  requestedAt: z.string().min(1),
});
/** The requested intent already consumes the single automatic replan opportunity. */
export const WorkerReplanSchema = z.discriminatedUnion('status', [
  replan.extend({ status: z.literal('requested'), task: WorkerTaskSchema.optional() }),
  replan.extend({ status: z.literal('ready'), task: WorkerTaskSchema }),
  replan.extend({ status: z.literal('completed'), task: WorkerTaskSchema }),
]);
export type WorkerReplan = z.infer<typeof WorkerReplanSchema>;

const legacyTask = z.strictObject({
  source: z.literal('legacy-goal'),
  // Existing goals remain complete; only coordinator proposals have the tighter task limits.
  objective: z.string(),
  inputs: z.array(z.string()),
  expectedResult: z.string(),
  criteria: z.array(z.string()),
});
export const WorkerEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  runId: z.string().min(1),
  role: z.strictObject({ id: z.string().min(1), version: z.number().int().nonnegative() }),
  goal: z.strictObject({ id: z.string().optional(), title: z.string() }),
  task: z.discriminatedUnion('source', [
    WorkerTaskSchema.extend({ source: z.literal('coordinator') }),
    legacyTask,
  ]),
  scope: z.strictObject({
    allowedPaths: z.array(z.string()).min(1),
    protectedPaths: z.array(z.string()),
  }),
  steps: z.array(z.string()),
  checks: z.strictObject({
    collection: z.enum(['baseline', 'acceptance']),
    passed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    results: z.array(
      z.strictObject({
        index: z.number().int().nonnegative(),
        name: z.string(),
        passed: z.boolean(),
        command: z.string().optional(),
        exitCode: z.number().nullable().optional(),
        diagnostic: z.string().max(2048).optional(),
      }),
    ),
  }),
  materials: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      mimeType: z.string(),
      hash: z.string().regex(/^[a-f0-9]{64}$/),
      path: z.string(),
      note: z.string().optional(),
    }),
  ),
  clarification: z.string().optional(),
});
export type WorkerEnvelopeV1 = z.infer<typeof WorkerEnvelopeSchema>;
