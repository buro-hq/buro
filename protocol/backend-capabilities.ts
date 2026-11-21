import { z } from 'zod';
import type { BackendCapabilities, BackendRequirements } from '../agent/contracts/capabilities.ts';

export const BackendCapabilitiesSchema = z
  .strictObject({
    version: z.literal(1),
    revision: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[^\s\0]+$/),
    structuredTurns: z.boolean(),
    toolsFreeTurns: z.boolean(),
    readOnlySessions: z.boolean(),
    immutableReview: z.boolean(),
    strictPlannedWrites: z.boolean(),
    hostToolLifecycle: z.boolean(),
    usage: z.enum(['reported', 'unknown']),
    resumeSessions: z.boolean(),
    cancellation: z.enum(['settled-or-unknown', 'unsupported']),
  })
  .superRefine((capabilities, context) => {
    if (capabilities.toolsFreeTurns && !capabilities.structuredTurns)
      context.addIssue({ code: 'custom', message: 'Tools-free turns require structured turns.' });
    if (capabilities.immutableReview && !capabilities.readOnlySessions)
      context.addIssue({
        code: 'custom',
        message: 'Immutable review requires read-only sessions.',
      });
  }) satisfies z.ZodType<BackendCapabilities>;

export const BackendRequirementsSchema = z.strictObject({
  structuredTurns: z.literal(true).optional(),
  toolsFreeTurns: z.literal(true).optional(),
  readOnlySessions: z.literal(true).optional(),
  immutableReview: z.literal(true).optional(),
  strictPlannedWrites: z.literal(true).optional(),
  hostToolLifecycle: z.literal(true).optional(),
  usage: z.literal('reported').optional(),
  resumeSessions: z.literal(true).optional(),
  cancellation: z.literal('settled-or-unknown').optional(),
}) satisfies z.ZodType<BackendRequirements>;
