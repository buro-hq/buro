import type { ContextMaterial, DomainEvent } from '../protocol/domain.ts';
import { ContextMaterialSchema } from '../protocol/context.ts';
import { DomainError } from './ports.ts';

export type ProjectMaterialChange = Extract<
  DomainEvent['change'],
  { type: 'context.materials.added' | 'context.material.removed' }
>;
export type MaterialCommand = { id: string; fingerprint: string };
export interface MaterialTransaction {
  material(id: string): ContextMaterial | undefined;
  attach(prepared: ContextMaterial[]): ContextMaterial[];
  remove(id: string): { id: string };
}
export interface ProjectMaterials {
  readonly projectId: string;
  /** Uses the authority's shared command receipts and event transaction. */
  transaction<T>(command: MaterialCommand, apply: (tx: MaterialTransaction) => T): Promise<T>;
  /** A found void result is distinct from an absent command receipt. */
  receipt(command: MaterialCommand): Promise<{ result: unknown } | undefined>;
  material(id: string): Promise<ContextMaterial | undefined>;
}
/** Trusted adapter-only indexed rows inside the owning open transaction. */
export interface MaterialTransactionStorage {
  material(id: string): ContextMaterial | undefined;
  byIdentity(candidate: ContextMaterial): ContextMaterial | undefined;
  count(): number;
  activeProjectCount(): number;
  insert(material: ContextMaterial): void;
  replace(previous: ContextMaterial, next: ContextMaterial): void;
  appendChange(change: ProjectMaterialChange): void;
}
const invalid = () =>
  new DomainError('INVALID_PROJECT_MATERIAL', 'The project material is invalid.');
const conflict = () =>
  new DomainError(
    'CONTEXT_CONFLICT',
    'This material identity has different saved content or metadata.',
  );

/** Metadata only: actual immutable bytes must be prepared and verified by the file adapter. */
export function validateProjectMaterial(
  value: unknown,
  options: { prepared?: boolean } = {},
): ContextMaterial {
  const parsed = ContextMaterialSchema.strict().safeParse(value);
  if (!parsed.success) throw invalid();
  const material = parsed.data;
  if (
    material.relativePath.slice('local/context/'.length, 'local/context/'.length + 64) !==
      material.hash ||
    (material.textPath !== undefined) !== (material.textHash !== undefined) ||
    (material.textPath !== undefined &&
      material.textPath.slice('local/context/'.length, 'local/context/'.length + 64) !==
        material.textHash) ||
    (options.prepared && (!material.active || !material.loader || !material.representation))
  )
    throw invalid();
  // Normalize only schema-validated optional metadata, never arbitrary command results.
  return JSON.parse(JSON.stringify(material)) as ContextMaterial;
}

/** Loader identity is part of deduplication; a new extractor revision creates a new material. */
export function projectMaterialIdentity(value: ContextMaterial): string {
  const material = validateProjectMaterial(value);
  return JSON.stringify([
    material.scope,
    material.name,
    material.hash,
    material.loader?.id ?? null,
    material.loader?.revision ?? null,
  ]);
}
function immutablePayload(value: ContextMaterial): string {
  const {
    id: _id,
    createdAt: _createdAt,
    active: _active,
    ...payload
  } = validateProjectMaterial(value);
  return JSON.stringify(payload);
}
export function validateProjectMaterialChange(value: unknown): ProjectMaterialChange {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const change = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(change);
  if (
    change.type === 'context.materials.added' &&
    keys.length === 2 &&
    Object.hasOwn(change, 'materials') &&
    Array.isArray(change.materials)
  )
    return {
      type: 'context.materials.added',
      materials: change.materials.map((material) => validateProjectMaterial(material)),
    };
  if (
    change.type === 'context.material.removed' &&
    keys.length === 2 &&
    Object.hasOwn(change, 'id') &&
    ContextMaterialSchema.shape.id.safeParse(change.id).success
  )
    return { type: 'context.material.removed', id: change.id as string };
  throw invalid();
}

export function createMaterialTransaction(options: {
  projectId: string;
  storage: MaterialTransactionStorage;
  assertActive(): void;
}): MaterialTransaction {
  const { projectId, storage, assertActive } = options;
  if (typeof projectId !== 'string' || !projectId.length)
    throw new DomainError('INVALID_PROJECT_ID', 'The project identity is invalid.');
  const material = (id: string) => {
    assertActive();
    if (!ContextMaterialSchema.shape.id.safeParse(id).success) throw invalid();
    const value = storage.material(id);
    const parsed = value === undefined ? undefined : validateProjectMaterial(value);
    if (parsed && parsed.id !== id) throw invalid();
    return parsed;
  };
  return Object.freeze({
    material,
    attach(input: ContextMaterial[]) {
      assertActive();
      if (!Array.isArray(input)) throw invalid();
      const prepared = input.map((value) => validateProjectMaterial(value, { prepared: true }));
      const candidateIds = new Map<string, string>();
      for (const candidate of prepared) {
        const key = projectMaterialIdentity(candidate);
        if (candidateIds.has(candidate.id) && candidateIds.get(candidate.id) !== key)
          throw conflict();
        candidateIds.set(candidate.id, key);
      }
      const staged = new Map<string, ContextMaterial>();
      const changes: { previous?: ContextMaterial; next: ContextMaterial }[] = [];
      const results: ContextMaterial[] = [];
      const count = storage.count(),
        active = storage.activeProjectCount();
      if (
        !Number.isSafeInteger(count) ||
        count < 0 ||
        !Number.isSafeInteger(active) ||
        active < 0 ||
        active > count
      )
        throw invalid();
      let added = 0,
        activated = 0;
      // Resolve every identity before the first write, including repeated inputs in this batch.
      for (const candidate of prepared) {
        const key = projectMaterialIdentity(candidate);
        const byId = material(candidate.id);
        if (byId && projectMaterialIdentity(byId) !== key) throw conflict();
        const saved = staged.get(key) ?? storage.byIdentity(candidate);
        const existing = saved === undefined ? undefined : validateProjectMaterial(saved);
        if (
          existing &&
          (projectMaterialIdentity(existing) !== key || (byId && existing.id !== byId.id))
        )
          throw conflict();
        if (!existing && byId) throw conflict();
        if (existing) {
          if (immutablePayload(existing) !== immutablePayload(candidate)) throw conflict();
          if (existing.active) {
            results.push(existing);
            staged.set(key, existing);
            continue;
          }
          const reactivated = { ...existing, active: true };
          if (reactivated.scope === 'project') activated++;
          changes.push({ previous: existing, next: reactivated });
          staged.set(key, reactivated);
          results.push(reactivated);
        } else {
          added++;
          if (candidate.scope === 'project') activated++;
          changes.push({ next: candidate });
          staged.set(key, candidate);
          results.push(candidate);
        }
      }
      if (!Number.isSafeInteger(count + added) || !Number.isSafeInteger(active + activated))
        throw invalid();
      for (const change of changes) {
        if (change.previous)
          storage.replace(structuredClone(change.previous), structuredClone(change.next));
        else storage.insert(structuredClone(change.next));
      }
      if (changes.length)
        storage.appendChange(
          validateProjectMaterialChange({
            type: 'context.materials.added',
            materials: changes.map((change) => change.next),
          }),
        );
      return structuredClone(results);
    },
    remove(id: string) {
      const current = material(id);
      if (!current) throw new DomainError('CONTEXT_NOT_FOUND', 'Material not found.');
      if (current.active) {
        storage.replace(structuredClone(current), { ...current, active: false });
        storage.appendChange({ type: 'context.material.removed', id });
      }
      return { id };
    },
  });
}
