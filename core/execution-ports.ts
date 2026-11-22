import { PROJECT_DIRECTORY } from '../protocol/project-directory.ts';
import { roleIdPattern } from '../protocol/domain.ts';
import { WorkflowIdentitySchema, type WorkflowIdentity } from '../protocol/workflow-roles.ts';
/** Shared admission policy for roles that the workflow may allocate as workers. */
export const isWorkerRoleId = (roleId: string) =>
  roleIdPattern.test(roleId) &&
  !['reviewer', 'coordinator', 'local_preview', 'delivery_pr', 'production_delivery'].includes(
    roleId,
  );
import type { WorkerProposal } from '../protocol/execution.ts';
import type { WorkScope } from '../protocol/work-scope.ts';
import type { WorkspaceRevision } from './workspace-revision.ts';
import type { VerificationView, OpenVerificationViewOptions } from './verification-view.ts';
import type {
  Run,
  FileChange,
  Check,
  ExecutionPolicyView,
  Role,
  ProjectProfile,
  ContextMaterial,
} from '../protocol/domain.ts';
export interface WorkspacePort {
  prepare(
    projectId: string,
    runId: string,
    base?: string,
    options?: {
      profile?: ProjectProfile;
      signal?: AbortSignal;
      repairEnvironment?: boolean;
      managedEnvironment?: boolean;
      materials?: ContextMaterial[];
    },
  ): Promise<{ path: string; base: string }>;
  restore?(
    projectId: string,
    runId: string,
    workspace: string,
    base: string,
    options?: {
      profile?: ProjectProfile;
      repairEnvironment?: boolean;
      managedEnvironment?: boolean;
      materials?: ContextMaterial[];
    },
  ): Promise<{ path: string; base: string }>;
  synchronizeDependencies?(workspace: string, signal: AbortSignal): Promise<Check | undefined>;
  changes(workspace: string, base: string): Promise<FileChange[]>;
  captureRevision(workspace: string, base: string): Promise<WorkspaceRevision>;
  openVerificationView?(
    workspace: string,
    revision: WorkspaceRevision,
    options: OpenVerificationViewOptions,
  ): Promise<VerificationView>;
  releaseVerificationView?(view: VerificationView): Promise<void>;
  checkpoint(workspace: string, runId: string, expected?: WorkspaceRevision): Promise<string>;
}
export interface CheckPort {
  releaseVerificationView?(view: VerificationView): Promise<void>;
  run(
    projectId: string,
    workspace: string,
    checkIds: string[],
    signal: AbortSignal,
    profile?: ProjectProfile,
    options?: { requirePreparedIsolation?: boolean; verificationView?: VerificationView },
  ): Promise<{ passed: number; total: number; results: Check[] }>;
}
export type ExecutionPolicy = ExecutionPolicyView & {
  turnTimeoutMs: number;
  context?: string;
  profile?: ProjectProfile;
};
export const terminal = (run: Run) =>
  !run.status || ['completed', 'failed', 'interrupted', 'needs-attention'].includes(run.status);
const normalizedPath = (value: string) =>
  value
    .split('/')
    .filter((part) => part && part !== '.')
    .join('/');
const matches = (file: string, planned: string) => {
  const candidate = normalizedPath(file),
    selected = normalizedPath(planned);
  return (
    !selected ||
    (planned.endsWith('/')
      ? candidate === selected || candidate.startsWith(selected + '/')
      : candidate === selected)
  );
};
/** Hard authorization is independent of the user's planned-path preference. */
export function hardPathAllowed(file: string, protectedPaths: readonly string[] = []) {
  const segments = file.replace(/\/$/, '').split('/');
  return (
    !!file.trim() &&
    !file.startsWith('/') &&
    !/^[a-z]:/i.test(normalizedPath(file)) &&
    !/[\x00-\x1f\x7f]/.test(file) &&
    !segments.includes('..') &&
    !file.includes('\\') &&
    !['.git', PROJECT_DIRECTORY, 'node_modules'].some((p) =>
      segments.some((part) => part.toLowerCase() === p.toLowerCase()),
    ) &&
    !protectedPaths.some((p) => matches(file, p))
  );
}
export function matchesPlannedPath(file: string, plannedPaths: readonly string[]) {
  return plannedPaths.some((planned) => matches(file, planned));
}
export function writeAllowed(file: string, scope: WorkScope) {
  return (
    hardPathAllowed(file, scope.protectedPaths) &&
    (scope.mode === 'advisory' || matchesPlannedPath(file, scope.plannedPaths))
  );
}
/** A selector grants future file access, so an exact file cannot authorize a directory grant. */
export function planPathAllowed(selector: string, parentScope: WorkScope) {
  if (!hardPathAllowed(selector, parentScope.protectedPaths)) return false;
  if (parentScope.mode === 'advisory') return true;
  const selected = normalizedPath(selector);
  if (selected && !selector.endsWith('/')) return writeAllowed(selector, parentScope);
  return parentScope.plannedPaths.some((parent) => {
    const boundary = normalizedPath(parent);
    if (!boundary) return true;
    return parent.endsWith('/') && (selected === boundary || selected.startsWith(boundary + '/'));
  });
}
/** Resolve one specialist independently of any working plan or future delegations. */
export function resolveWorkerRole(
  worker: WorkerProposal,
  catalog: Role[],
  policy: ExecutionPolicy,
  now: string,
  workflow: WorkflowIdentity,
): Role {
  if (policy.maxWorkers !== undefined && policy.maxWorkers < 1)
    throw Error('Invalid number of workers.');
  if (!roleIdPattern.test(worker.roleId))
    throw Error(
      `Invalid roleId ${JSON.stringify(worker.roleId)}: provide a nonempty ID, for example react_developer or react-developer. Use lowercase Latin letters, digits, underscores and hyphens, up to 64 characters, starting with a letter.`,
    );
  if (!isWorkerRoleId(worker.roleId))
    throw Error(`roleId ${worker.roleId} is reserved by the service. Choose a worker ID.`);
  if (
    (policy.scope.mode === 'strict' && !worker.paths.length) ||
    worker.paths.some((p) => !planPathAllowed(p, policy.scope))
  )
    throw Error('The worker contains an unauthorized path or exceeds the strict work scope.');
  const owned: string[] = [];
  for (const p of worker.paths) {
    const path = normalizedPath(p);
    if (
      owned.some(
        (q) => !path || !q || path === q || path.startsWith(q + '/') || q.startsWith(path + '/'),
      )
    )
      throw Error('The worker has overlapping file ownership selectors.');
    owned.push(path);
  }
  const existing = catalog.find((role) => role.id === worker.roleId);
  if (worker.action === 'reuse') {
    if (!existing)
      throw Error(
        `roleId ${JSON.stringify(worker.roleId)} not in the catalog; action="create" or reuse an existing specialist.`,
      );
    return existing;
  }
  if (existing) throw Error('This role already exists; reuse it.');
  if (
    !worker.title.trim() ||
    !worker.description.trim() ||
    !worker.instructions.trim() ||
    worker.instructions.length > 16000
  )
    throw Error('Invalid new role definition.');
  return {
    id: worker.roleId,
    version: 1,
    title: worker.title,
    description: worker.description,
    instructions: worker.instructions,
    kind: worker.kind,
    provenance: { origin: 'coordinator', workflow: WorkflowIdentitySchema.parse(workflow) },
    createdAt: now,
    updatedAt: now,
  };
}
