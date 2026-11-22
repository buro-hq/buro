import { z } from 'zod';
import { WorkScopeSchema } from './work-scope.ts';

/** One policy shape is used by snapshots, configuration events and saved run policies. */
export const ExecutionPolicySchema = z.strictObject({
  scope: WorkScopeSchema,
  checks: z.array(z.object({ id: z.string(), title: z.string() })),
  defaultCheckIds: z.array(z.string()),
  maxWorkers: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});
