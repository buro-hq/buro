import { PROJECT_DIRECTORY, LEGACY_PROJECT_DIRECTORY } from '../protocol/project-directory.ts';
import { roleIdPattern } from '../protocol/domain.ts';
import type { TeamPlan } from '../protocol/execution.ts';
export type { TeamPlan } from '../protocol/execution.ts';
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
  checkpoint(workspace: string, runId: string): Promise<string>;
}
export interface CheckPort {
  run(
    projectId: string,
    workspace: string,
    checkIds: string[],
    signal: AbortSignal,
    profile?: ProjectProfile,
    options?: { requirePreparedIsolation?: boolean },
  ): Promise<{ passed: number; total: number; results: Check[] }>;
}
export type ExecutionPolicy = ExecutionPolicyView & {
  turnTimeoutMs: number;
  context?: string;
  profile?: ProjectProfile;
};
export type PlannedWorker = TeamPlan['team'][number];
export const terminal = (run: Run) =>
  !run.status || ['completed', 'failed', 'interrupted', 'needs-attention'].includes(run.status);
const matches = (file: string, p: string) =>
  p === '.' || p === './' || (p.endsWith('/') ? file.startsWith(p) : file === p);
export function inScope(file: string, allowed: string[], protectedPaths: string[] = []) {
  return (
    !file.startsWith('/') &&
    !file.split('/').includes('..') &&
    !file.includes('\\') &&
    !['.git', PROJECT_DIRECTORY, LEGACY_PROJECT_DIRECTORY, 'node_modules'].some(
      (p) => file === p || file.startsWith(p + '/'),
    ) &&
    !protectedPaths.some((p) => matches(file, p)) &&
    allowed.some((p) => matches(file, p))
  );
}
export function resolveTeam(
  plan: TeamPlan,
  catalog: Role[],
  policy: ExecutionPolicy,
  now: string,
): { roles: Role[]; origins: Record<string, 'created' | 'reused'> } {
  if (plan.team.length > policy.maxWorkers) throw Error('Invalid number of workers.');
  const ids = new Set<string>(),
    owned: string[] = [];
  const origins: Record<string, 'created' | 'reused'> = {};
  const roles = plan.team.map((worker) => {
    if (!roleIdPattern.test(worker.roleId))
      throw Error(
        `Invalid roleId ${JSON.stringify(worker.roleId)}: provide a nonempty ID, for example react_developer or react-developer. Use lowercase Latin letters, digits, underscores and hyphens, up to 64 characters, starting with a letter.`,
      );
    if (
      ['reviewer', 'coordinator', 'local_preview', 'delivery_pr', 'production_delivery'].includes(
        worker.roleId,
      )
    )
      throw Error(`roleId ${worker.roleId} is reserved by the service. Choose a worker ID.`);
    if (ids.has(worker.roleId))
      throw Error(`Duplicate roleId ${worker.roleId}. Every worker needs a separate ID.`);
    ids.add(worker.roleId);
    if (
      !worker.paths.length ||
      worker.paths.some(
        (p) =>
          p.startsWith('/') ||
          p.includes('..') ||
          p.includes('\\') ||
          !inScope(p, policy.allowedPaths, policy.protectedPaths),
      )
    )
      throw Error('The plan exceeds the allowed scope.');
    for (const p of worker.paths) {
      if (
        owned.some(
          (q) =>
            p === q ||
            p.startsWith(q.endsWith('/') ? q : q + '/') ||
            q.startsWith(p.endsWith('/') ? p : p + '/'),
        )
      )
        throw Error('Workers have overlapping file ownership.');
      owned.push(p);
    }
    const existing = catalog.find((r) => r.id === worker.roleId);
    if (worker.action === 'reuse') {
      if (!existing) throw Error('The selected role is not in the catalog.');
      origins[worker.roleId] = 'reused';
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
    origins[worker.roleId] = 'created';
    return {
      id: worker.roleId,
      version: 1,
      title: worker.title,
      description: worker.description,
      instructions: worker.instructions,
      kind: worker.kind,
      createdAt: now,
      updatedAt: now,
    };
  });
  if (plan.steps.some((s) => !ids.has(s.owner) && !['coordinator', 'reviewer'].includes(s.owner)))
    throw Error(
      'steps.owner must exactly match a worker roleId or coordinator/reviewer; use the ID rather than the role title.',
    );
  return { roles, origins };
}
