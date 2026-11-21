import { z } from 'zod';
import { RelativePathSchema } from './projects-paths.ts';

/** Planned paths guide autonomous work; hard protected paths apply in either mode. */
export type WorkScope = {
  mode: 'advisory' | 'strict';
  plannedPaths: string[];
  protectedPaths: string[];
};

export const WorkScopeSchema = z
  .strictObject({
    mode: z.enum(['advisory', 'strict']),
    plannedPaths: z.array(RelativePathSchema),
    protectedPaths: z.array(RelativePathSchema),
  })
  .superRefine((scope, context) => {
    if (scope.mode === 'strict' && !scope.plannedPaths.length)
      context.addIssue({
        code: 'custom',
        path: ['plannedPaths'],
        message: 'Strict work scope requires an explicit nonempty selection of planned paths.',
      });
  }) satisfies z.ZodType<WorkScope>;

/** Service-derived evidence bound to the captured candidate tree, never model-supplied authority. */
export type ScopeObservation = {
  mode: WorkScope['mode'];
  tree: string;
  additionalPaths: string[];
  violations: string[];
};

export const ScopeObservationSchema = z.strictObject({
  mode: z.enum(['advisory', 'strict']),
  tree: z.string().regex(/^[0-9a-f]{40}$/),
  additionalPaths: z.array(RelativePathSchema),
  // Violations may themselves be unsafe paths; preserve the denied evidence verbatim.
  violations: z.array(z.string().min(1).max(4000)),
}) satisfies z.ZodType<ScopeObservation>;
