import { z } from 'zod';
import type { ProjectProfile } from '../protocol/domain.ts';
import { ResearchResultSchema } from '../protocol/operations.ts';
import { ResourceConfigSchema, ResourceIdSchema } from '../protocol/resources.ts';
import { DomainError } from './ports.ts';
import { ProjectProfileSchema } from '../protocol/projects.ts';
import type { ProjectResearch } from '../protocol/domain.ts';

/** Host-selected, hash-verified material content. No callback receives a path or resolver. */
export type AuthorizedMaterialText = {
  id: string;
  name: string;
  mimeType: string;
  hash: string;
  textHash?: string;
  representation: 'text' | 'reference';
  text?: string;
  note?: string;
};
export type ProjectAnalysisInput = {
  project: { id: string; name: string };
  sourceHead: string;
  profile: ProjectProfile;
  materials: readonly AuthorizedMaterialText[];
};
export type ProjectAnalysisRequest = {
  instructions: string;
  prompt: string;
  schema: Record<string, unknown>;
};
export type ProjectAnalysisProposal = z.infer<typeof ResearchResultSchema>;
export type ProjectAnalyzer = {
  id: string;
  revision: string;
  purpose: 'project-setup';
  build(input: ProjectAnalysisInput): ProjectAnalysisRequest;
  parse(text: string): unknown;
};
export type ResolvedProjectAnalysis = {
  readonly id: string;
  readonly revision: string;
  readonly purpose: 'project-setup';
  build(input: ProjectAnalysisInput): ProjectAnalysisRequest;
  parse(text: string): ProjectAnalysisProposal;
};
export type AuthorizedMaterialTextReader = (
  projectId: string,
  selected: readonly import('../protocol/context.ts').ContextMaterial[],
  signal: AbortSignal,
) => Promise<AuthorizedMaterialText[]>;
const requestSchema = z.strictObject({
  instructions: z.string().min(1),
  prompt: z.string().min(1),
  schema: ResourceConfigSchema,
});
const proposalSchema = ResearchResultSchema.strict();
const materialSchema = z
  .strictObject({
    id: z.string().min(1),
    name: z.string().min(1),
    mimeType: z.string(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    textHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    representation: z.enum(['text', 'reference']),
    text: z.string().optional(),
    note: z.string().optional(),
  })
  .refine(
    (material) =>
      material.representation === 'text'
        ? material.text !== undefined
        : material.text === undefined,
    'A reference-only material cannot claim text content.',
  );
const inputSchema = z.strictObject({
  project: z.strictObject({ id: z.string().min(1), name: z.string().min(1) }),
  sourceHead: z.string().min(1),
  profile: ProjectProfileSchema,
  materials: z.array(materialSchema),
});
function immutable<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
function failure(code: string, message: string, cause: unknown): DomainError {
  const error = new DomainError(code, message);
  Object.defineProperty(error, 'cause', { value: cause });
  return error;
}
/** Trusted analysis customizes proposals; application services retain sessions, receipts and apply authority. */
export class ProjectAnalysisCatalog {
  #analyses = new Map<string, ResolvedProjectAnalysis>();
  #sealed = false;
  get sealed() {
    return this.#sealed;
  }
  assertSealed() {
    if (!this.#sealed)
      throw new DomainError(
        'PROJECT_ANALYSES_UNSEALED',
        'Seal project analyses before resolving one.',
      );
  }
  register(input: ProjectAnalyzer): void {
    if (this.#sealed)
      throw new DomainError('PROJECT_ANALYSES_SEALED', 'Project analyses are already sealed.');
    if (
      !input ||
      !ResourceIdSchema.safeParse(input.id).success ||
      typeof input.revision !== 'string' ||
      !input.revision.trim() ||
      input.purpose !== 'project-setup' ||
      typeof input.build !== 'function' ||
      typeof input.parse !== 'function'
    )
      throw new DomainError(
        'INVALID_PROJECT_ANALYSIS',
        'An analysis needs an ID, revision, purpose and build/parse callbacks.',
      );
    if (this.#analyses.has(input.id))
      throw new DomainError(
        'PROJECT_ANALYSIS_EXISTS',
        'A project analysis with this ID is already registered.',
      );
    const { id, revision, purpose, build, parse } = input;
    this.#analyses.set(
      id,
      Object.freeze({
        id,
        revision,
        purpose,
        build: (input: ProjectAnalysisInput) => {
          try {
            return immutable(
              requestSchema.parse(
                structuredClone(build(immutable(inputSchema.parse(structuredClone(input))))),
              ),
            );
          } catch (error) {
            throw failure(
              'PROJECT_ANALYSIS_INVALID_REQUEST',
              'The project analysis could not prepare a valid request.',
              error,
            );
          }
        },
        parse: (text: string) => {
          let result: ProjectAnalysisProposal;
          try {
            result = proposalSchema.parse(structuredClone(parse(text)));
          } catch (error) {
            throw failure(
              'PROJECT_ANALYSIS_INVALID_RESULT',
              'The project analysis returned an invalid proposal.',
              error,
            );
          }
          if (
            new Set(result.components.map((component) => component.id)).size !==
              result.components.length ||
            new Set(result.checks.map((check) => check.id)).size !== result.checks.length
          )
            throw new DomainError(
              'PROJECT_ANALYSIS_INVALID_RESULT',
              'The project analysis returned duplicate component or check IDs.',
            );
          return result;
        },
      }),
    );
  }
  seal() {
    this.#sealed = true;
    return this;
  }
  get(id: string): ResolvedProjectAnalysis {
    this.assertSealed();
    const analysis = this.#analyses.get(id);
    if (!analysis)
      throw new DomainError(
        'PROJECT_ANALYSIS_UNAVAILABLE',
        'The configured project analysis is not registered.',
      );
    return analysis;
  }
  list() {
    this.assertSealed();
    return [...this.#analyses.values()].map(({ id, revision, purpose }) => ({
      id,
      revision,
      purpose,
    }));
  }
}

export function validateProjectResearchTransitions(
  previous: ProjectResearch | undefined,
  next: ProjectResearch | undefined,
): void {
  if (!previous) return;
  if (previous.status === 'running' && previous.id !== next?.id)
    throw new DomainError(
      'PROJECT_ANALYSIS_CHANGED',
      'A pending analysis cannot be removed or rebound.',
    );
  if (
    previous.id === next?.id &&
    JSON.stringify([
      previous.analysis,
      previous.sourceHead,
      previous.profileRevision,
      previous.resources,
      previous.contextMaterials,
    ]) !==
      JSON.stringify([
        next.analysis,
        next.sourceHead,
        next.profileRevision,
        next.resources,
        next.contextMaterials,
      ])
  )
    throw new DomainError(
      'PROJECT_ANALYSIS_CHANGED',
      'The admitted analysis identity and source revision cannot be changed.',
    );
}
