import { z } from 'zod';
import { RelativePathSchema } from './projects-paths.ts';
const command = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  title: z.string().min(1).max(120),
  command: z.string().min(1).max(4000),
  timeoutMs: z.number().int().min(1000).max(900000),
});
/** A project recipe describes effects; it does not select or widen its executor's authority. */
export const EnvironmentRecipeSchema = z.strictObject({
  summary: z.string().min(1).max(2000),
  inputs: z.array(RelativePathSchema).min(1).max(40),
  variables: z
    .record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().max(4000))
    .refine(
      (values) =>
        Object.keys(values).length <= 40 &&
        !Object.keys(values).some((key) =>
          ['HOME', 'CODEX_HOME', 'TMPDIR', 'PROJECT_ROOT', 'GOAL_WORKSPACE'].includes(key),
        ),
      'Reserved environment roots cannot be replaced.',
    )
    .optional(),
  setup: z.array(command).max(8),
  ready: z.array(command).min(1).max(8),
});
export type EnvironmentRecipe = z.infer<typeof EnvironmentRecipeSchema>;

/** Model output must use closed objects with every property required, including empty variables. */
export const EnvironmentRecipeOutputSchema = EnvironmentRecipeSchema.omit({
  variables: true,
}).extend({
  variables: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
        value: z.string().max(4000),
      }),
    )
    .max(40),
});
export const environmentRecipeOutputSchema = z.toJSONSchema(EnvironmentRecipeOutputSchema);

export function parseEnvironmentRecipeOutput(value: unknown): EnvironmentRecipe {
  const output = EnvironmentRecipeOutputSchema.parse(value);
  const names = output.variables.map((variable) => variable.name);
  if (new Set(names).size !== names.length)
    throw Error('Environment variable names must be unique.');
  return EnvironmentRecipeSchema.parse({
    ...output,
    variables: Object.fromEntries(output.variables.map(({ name, value }) => [name, value])),
  });
}
export const EnvironmentConfigSchema = z
  .strictObject({
    provider: z.enum(['native', 'docker']),
    image: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/)
      .max(300)
      .optional(),
    recipe: EnvironmentRecipeSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.provider === 'docker' && !value.image)
      ctx.addIssue({
        code: 'custom',
        message: 'A Docker environment needs an agent image.',
        path: ['image'],
      });
  });
export type EnvironmentConfig = z.infer<typeof EnvironmentConfigSchema>;
