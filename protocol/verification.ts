import { z } from 'zod';
import { RelativePathSchema } from './projects-paths.ts';

/** Declared check output directories, never a grant to rewrite the source tree. */
export const CheckOutputPathSchema = RelativePathSchema.transform((value) =>
  value.replace(/\/+$/, ''),
).refine(
  (value) =>
    value.length > 0 &&
    !value
      .split('/')
      .some((part) => ['', '.', '..', '.git', '.buro', '.проект', 'node_modules'].includes(part)),
  'A regular relative output directory outside source-control and service files is required.',
);

export const CheckOutputPathsSchema = z
  .array(CheckOutputPathSchema)
  .refine(
    (paths) => new Set(paths).size === paths.length,
    'Check output directories must be unique.',
  );

const absolute = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value.startsWith('/') &&
      !/[\0\r\n\\]/.test(value) &&
      !value.split('/').some((part, index) => index > 0 && ['.', '..', ''].includes(part)),
    'A canonical absolute verification path is required.',
  );

/** Service-issued handle to an exact source revision and separate writable output area. */
export const VerificationViewSchema = z
  .strictObject({
    version: z.literal(1),
    id: z
      .string()
      .min(1)
      .regex(/^[a-zA-Z0-9_-]+$/),
    projectId: z.string().min(1),
    runId: z.string().min(1),
    sourceWorkspace: absolute,
    readRoot: absolute,
    outputRoot: absolute,
    base: z.string().regex(/^[a-f0-9]{40}$/),
    tree: z.string().regex(/^[a-f0-9]{40}$/),
    outputPaths: CheckOutputPathsSchema,
    environmentFingerprint: z.string().min(1).optional(),
    readonlyDependencies: z.array(z.strictObject({ path: absolute, target: absolute })).optional(),
  })
  .superRefine((view, ctx) => {
    const overlaps = (a: string, b: string) =>
      a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
    if (
      overlaps(view.readRoot, view.sourceWorkspace) ||
      overlaps(view.outputRoot, view.sourceWorkspace) ||
      overlaps(view.readRoot, view.outputRoot)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Verification source and output areas must be separate.',
      });
    const aliases = new Set<string>();
    for (const dependency of view.readonlyDependencies || []) {
      if (
        !dependency.path.startsWith(view.readRoot + '/') ||
        !dependency.path.endsWith('/node_modules') ||
        [view.sourceWorkspace, view.readRoot].includes(dependency.target) ||
        overlaps(view.outputRoot, dependency.target) ||
        aliases.has(dependency.path)
      )
        ctx.addIssue({
          code: 'custom',
          message:
            'A read-only dependency must have one node_modules alias inside the issued view.',
        });
      aliases.add(dependency.path);
    }
  });

export type VerificationView = z.infer<typeof VerificationViewSchema>;

/** Retained observations survive deletion of the temporary active view. */
export const VerificationEvidenceSchema = z
  .strictObject({
    version: z.literal(1),
    viewId: z.string().min(1),
    base: z.string().regex(/^[a-f0-9]{40}$/),
    tree: z.string().regex(/^[a-f0-9]{40}$/),
    checkIds: z.array(z.string().min(1)),
    profileRevision: z.number().int().nonnegative().optional(),
    checkedAt: z
      .string()
      .refine((value) => Number.isFinite(Date.parse(value)), 'An observed check time is required.'),
    reviewedAt: z
      .string()
      .refine((value) => Number.isFinite(Date.parse(value)), 'An observed review time is required.')
      .optional(),
    reviewerSessionId: z.string().min(1).optional(),
  })
  .superRefine((evidence, ctx) => {
    if ((evidence.reviewedAt === undefined) !== (evidence.reviewerSessionId === undefined))
      ctx.addIssue({
        code: 'custom',
        message: 'Review evidence requires both its observation time and session identity.',
      });
    if (new Set(evidence.checkIds).size !== evidence.checkIds.length)
      ctx.addIssue({ code: 'custom', message: 'Observed checks must have unique identities.' });
  });

export type VerificationEvidence = z.infer<typeof VerificationEvidenceSchema>;
