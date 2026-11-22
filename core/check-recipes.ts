import { z } from 'zod';
import type { ProjectCommand, ProjectProfile } from '../protocol/domain.ts';
import type { CheckRecipeSource } from '../protocol/check-recipes.ts';
import { ProjectCommandSchema } from '../protocol/projects.ts';
import { EnvironmentRecipeSchema, type EnvironmentRecipe } from '../protocol/environment.ts';
import { DomainError } from './ports.ts';

export type CheckRecipeInput = { path: string; kind: 'text' | 'file' | 'directory' };
export type ManifestFact =
  | { path: string; kind: 'text'; exists: true; content: string; digest: string }
  | { path: string; kind: 'text'; exists: false }
  | { path: string; kind: 'file' | 'directory'; exists: boolean };
export type CheckRecipeFacts = { head: string; entries: readonly ManifestFact[] };
export type CheckRecipeProposal = {
  checks: ProjectCommand[];
  defaultCheckIds: string[];
  setup: ProjectCommand[];
  environmentRecipe?: EnvironmentRecipe;
  dependencies?: ProjectProfile['dependencies'];
  projectName?: string;
  warnings: string[];
};
export type CheckRecipeContribution = {
  id: string;
  revision: string;
  label: string;
  inputs: readonly CheckRecipeInput[];
  /** Receives only detached, bounded snapshots of this contribution's declared inputs. */
  propose(facts: CheckRecipeFacts): CheckRecipeProposal | undefined;
};
export type CheckRecipeDiscovery = CheckRecipeProposal & { sources: CheckRecipeSource[] };

const proposalSchema = z.strictObject({
  checks: z.array(ProjectCommandSchema).max(8),
  defaultCheckIds: z.array(z.string()).max(8),
  setup: z.array(ProjectCommandSchema).max(4),
  environmentRecipe: EnvironmentRecipeSchema.optional(),
  dependencies: z.enum(['none', 'link-node-modules']).optional(),
  projectName: z.string().trim().min(1).max(120).optional(),
  warnings: z.array(z.string().min(1).max(2000)).max(16),
});
const factSchema = z.union([
  z.strictObject({
    path: z.string(),
    kind: z.literal('text'),
    exists: z.literal(true),
    content: z.string(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.strictObject({ path: z.string(), kind: z.literal('text'), exists: z.literal(false) }),
  z.strictObject({ path: z.string(), kind: z.enum(['file', 'directory']), exists: z.boolean() }),
]);
const factsSchema = z.strictObject({
  head: z.string().min(1).max(128),
  entries: z.array(factSchema).max(16),
});
const privateNames = new Set([
  '.git',
  '.buro',
  '.atelier',
  '.codex',
  '.claude',
  '.ssh',
  '.aws',
  '.npm',
  '.cache',
]);
const generatedNames = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.venv',
  'vendor',
  'target',
]);

/** Validate declarations before the adapter performs even metadata I/O. */
export function validateCheckRecipeInput(input: CheckRecipeInput): CheckRecipeInput {
  if (
    !input ||
    !['text', 'file', 'directory'].includes(input.kind) ||
    typeof input.path !== 'string' ||
    !input.path ||
    input.path.length > 300 ||
    input.path.startsWith('/') ||
    /^[A-Za-z]:/.test(input.path) ||
    /[\\\0\r\n*?\[\]{}]/.test(input.path)
  )
    throw new DomainError(
      'INVALID_RECIPE_INPUT',
      'Recipe inputs must name exact relative repository paths.',
    );
  const parts = input.path.split('/');
  if (
    parts.some(
      (part, index) =>
        !part ||
        part === '.' ||
        part === '..' ||
        privateNames.has(part.toLowerCase()) ||
        (generatedNames.has(part.toLowerCase()) &&
          !(input.kind === 'directory' && index === parts.length - 1)) ||
        (part.toLowerCase().startsWith('.env') && part.toLowerCase() !== '.env.example') ||
        ['.npmrc', '.netrc', 'id_rsa', 'id_ed25519'].includes(part.toLowerCase()) ||
        /\.(pem|key|p12|pfx|keystore)$/i.test(part),
    )
  )
    throw new DomainError(
      'INVALID_RECIPE_INPUT',
      'Recipe inputs cannot read private or generated repository data.',
    );
  return { path: input.path, kind: input.kind };
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function invalidOutput(): never {
  throw new DomainError('INVALID_CHECK_RECIPE', 'A check recipe returned an invalid proposal.');
}
function validateProposal(value: unknown): CheckRecipeProposal {
  const parsed = proposalSchema.safeParse(value);
  if (!parsed.success) invalidOutput();
  const proposal = parsed.data;
  for (const commands of [proposal.checks, proposal.setup])
    if (new Set(commands.map((command) => command.id)).size !== commands.length) invalidOutput();
  if (
    new Set(proposal.defaultCheckIds).size !== proposal.defaultCheckIds.length ||
    proposal.defaultCheckIds.some((id) => !proposal.checks.some((command) => command.id === id))
  )
    invalidOutput();
  return proposal;
}

/** Startup-fixed proposal factories, never an execution or profile mutation authority. */
export class CheckRecipeCatalog {
  #recipes = new Map<string, CheckRecipeContribution>();
  #sealed = false;
  register(contribution: CheckRecipeContribution) {
    if (this.#sealed)
      throw new DomainError('CHECK_RECIPES_SEALED', 'Check recipe registration is already sealed.');
    if (
      typeof contribution?.id !== 'string' ||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(contribution.id) ||
      typeof contribution.revision !== 'string' ||
      !contribution.revision.trim() ||
      contribution.revision.length > 128 ||
      typeof contribution.label !== 'string' ||
      !contribution.label.trim() ||
      contribution.label.length > 120 ||
      typeof contribution.propose !== 'function' ||
      !Array.isArray(contribution.inputs) ||
      contribution.inputs.length > 16
    )
      throw new DomainError(
        'INVALID_CHECK_RECIPE',
        'A check recipe needs an ID, revision, label and bounded inputs.',
      );
    if (this.#recipes.has(contribution.id))
      throw new DomainError(
        'CHECK_RECIPE_EXISTS',
        'A check recipe with this ID is already registered.',
      );
    const inputs = contribution.inputs.map(validateCheckRecipeInput);
    if (new Set(inputs.map((input) => input.path)).size !== inputs.length)
      throw new DomainError(
        'INVALID_RECIPE_INPUT',
        'Recipe input paths must be unique within a contribution.',
      );
    this.#recipes.set(
      contribution.id,
      Object.freeze({
        id: contribution.id,
        revision: contribution.revision,
        label: contribution.label,
        inputs: freeze(inputs),
        propose: contribution.propose,
      }),
    );
  }
  seal() {
    this.#sealed = true;
    return this;
  }
  assertSealed() {
    if (!this.#sealed)
      throw new DomainError(
        'CHECK_RECIPES_UNSEALED',
        'Seal check recipes before project inspection.',
      );
  }
  declaredInputs(): ReadonlyMap<string, readonly CheckRecipeInput[]> {
    this.assertSealed();
    return new Map(
      [...this.#recipes.values()].map((recipe) => [recipe.id, structuredClone(recipe.inputs)]),
    );
  }
  discover(captured: ReadonlyMap<string, CheckRecipeFacts>): CheckRecipeDiscovery {
    this.assertSealed();
    const discovery: CheckRecipeDiscovery = {
      checks: [],
      defaultCheckIds: [],
      setup: [],
      warnings: [],
      sources: [],
    };
    const checkIds = new Set<string>(),
      setupIds = new Set<string>();
    let sourceHead: string | undefined;
    for (const recipe of [...this.#recipes.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    )) {
      const parsed = factsSchema.safeParse(captured.get(recipe.id));
      if (!parsed.success || parsed.data.entries.length !== recipe.inputs.length)
        throw new DomainError(
          'INVALID_RECIPE_FACTS',
          'Recipe facts do not match the declared inputs.',
        );
      const facts = parsed.data;
      if (sourceHead !== undefined && sourceHead !== facts.head)
        throw new DomainError(
          'INVALID_RECIPE_FACTS',
          'Recipe facts refer to different repository revisions.',
        );
      sourceHead = facts.head;
      const seen = new Set<string>();
      let bytes = 0;
      for (const fact of facts.entries) {
        const input = recipe.inputs.find(
          (input) => input.path === fact.path && input.kind === fact.kind,
        );
        if (!input || seen.has(fact.path))
          throw new DomainError(
            'INVALID_RECIPE_FACTS',
            'Recipe facts do not match the declared inputs.',
          );
        seen.add(fact.path);
        if (fact.kind === 'text' && fact.exists) {
          const length = new TextEncoder().encode(fact.content).length;
          bytes += length;
          if (length > 262144)
            throw new DomainError(
              'RECIPE_INPUT_LIMIT',
              'A recipe manifest exceeds its text limit.',
            );
        }
      }
      if (bytes > 1048576)
        throw new DomainError(
          'RECIPE_INPUT_LIMIT',
          'Recipe manifests exceed their total text limit.',
        );
      // Do not hand the full capture map to a plugin: only its own declared facts cross this boundary.
      const returned = recipe.propose(freeze(structuredClone(facts)));
      if (returned === undefined) continue;
      const proposal = validateProposal(returned);
      for (const [commands, ids] of [
        [proposal.checks, checkIds],
        [proposal.setup, setupIds],
      ] as const)
        for (const command of commands) {
          if (ids.has(command.id))
            throw new DomainError(
              'CHECK_RECIPE_CONFLICT',
              'Check recipes propose duplicate command IDs. Configure the commands explicitly.',
            );
          ids.add(command.id);
        }
      for (const key of ['projectName', 'dependencies', 'environmentRecipe'] as const)
        if (proposal[key] !== undefined) {
          if (
            discovery[key] !== undefined &&
            JSON.stringify(discovery[key]) !== JSON.stringify(proposal[key])
          )
            throw new DomainError(
              'CHECK_RECIPE_CONFLICT',
              'Check recipes propose conflicting project settings. Configure them explicitly.',
            );
          Object.assign(discovery, { [key]: structuredClone(proposal[key]) });
        }
      discovery.checks.push(...proposal.checks);
      discovery.defaultCheckIds.push(...proposal.defaultCheckIds);
      discovery.setup.push(...proposal.setup);
      discovery.warnings.push(...proposal.warnings);
      discovery.sources.push({
        contributionId: recipe.id,
        revision: recipe.revision,
        label: recipe.label,
        head: facts.head,
        inputs: facts.entries.map(({ path, kind, exists, ...rest }) => ({
          path,
          kind,
          exists,
          ...('digest' in rest ? { digest: rest.digest } : {}),
        })),
      });
    }
    // Validate aggregate limits without accepting a contribution-authored source field.
    const { sources, ...proposal } = discovery;
    return { ...validateProposal(proposal), sources };
  }
}
