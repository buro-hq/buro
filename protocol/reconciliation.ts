import { z } from 'zod';

export const ReconciliationCodeSchema = z.enum([
  'SESSION_RECONCILIATION_REQUIRED',
  'GENERATION_RECONCILIATION_REQUIRED',
  'ACTION_RECONCILIATION_REQUIRED',
  'WORKER_CHECK_RECONCILIATION_REQUIRED',
  'WORKSPACE_CHECKPOINT_RECONCILIATION_REQUIRED',
]);
export type ReconciliationCode = z.infer<typeof ReconciliationCodeSchema>;

/** Public references only. Raw requests, commands and provider continuation stay private. */
export const RunReconciliationSchema = z.strictObject({
  version: z.literal(1),
  status: z.literal('required'),
  code: ReconciliationCodeSchema,
  detectedAt: z.string().min(1),
  threadId: z.string().min(1).optional(),
  backendSessionId: z.string().min(1).optional(),
  runtimeId: z.string().min(1).optional(),
  operationId: z.string().min(1).optional(),
});
export type RunReconciliation = z.infer<typeof RunReconciliationSchema>;

/** Persisted before entering a backend turn, settled only after its outcome is observed. */
export const PendingRunTurnSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().min(1),
  threadId: z.string().min(1),
  runtimeId: z.string().min(1),
  startedAt: z.string().min(1),
});
export type PendingRunTurn = z.infer<typeof PendingRunTurnSchema>;
