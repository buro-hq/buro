import { z } from 'zod';
import type { Role } from '../protocol/domain.ts';
import { ResourceIdSchema } from '../protocol/resources.ts';
import {
  RoleSchema,
  WorkflowIdentitySchema,
  type WorkflowIdentity,
} from '../protocol/workflow-roles.ts';
import { DomainError, type ProjectDocument } from './ports.ts';
import type { ServiceOperation } from './operation-catalog.ts';

const templateSchema = z.strictObject({
  id: ResourceIdSchema,
  revision: z.string().min(1),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1000),
  instructions: z.string().trim().min(1).max(16000),
  kind: z.enum(['implementation', 'testing', 'review', 'coordination', 'general']),
});
export type RoleTemplate = z.infer<typeof templateSchema>;
export type WorkflowContribution = {
  id: string;
  revision: string;
  templateFor(operation: ServiceOperation): string | undefined;
};
type ResolvedWorkflow = Readonly<WorkflowContribution>;
function immutable<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) immutable(item);
    Object.freeze(value);
  }
  return value;
}
export class RoleTemplateCatalog {
  #templates = new Map<string, RoleTemplate>();
  #sealed = false;
  get sealed() {
    return this.#sealed;
  }
  assertSealed() {
    if (!this.#sealed)
      throw new DomainError('ROLE_TEMPLATES_UNSEALED', 'Seal role templates before using them.');
  }
  register(input: RoleTemplate): void {
    if (this.#sealed)
      throw new DomainError('ROLE_TEMPLATES_SEALED', 'Role templates are already sealed.');
    const result = templateSchema.safeParse(structuredClone(input));
    if (!result.success)
      throw new DomainError(
        'INVALID_ROLE_TEMPLATE',
        'A role template contains only validated role content and a revision.',
      );
    if (this.#templates.has(result.data.id))
      throw new DomainError(
        'ROLE_TEMPLATE_EXISTS',
        'A role template with this ID is already registered.',
      );
    this.#templates.set(result.data.id, immutable(result.data));
  }
  seal() {
    this.#sealed = true;
    return this;
  }
  get(id: string): RoleTemplate {
    this.assertSealed();
    const template = this.#templates.get(id);
    if (!template)
      throw new DomainError(
        'ROLE_TEMPLATE_UNAVAILABLE',
        'The selected role template is not registered.',
      );
    return template;
  }
  list() {
    this.assertSealed();
    return [...this.#templates.values()].map((template) => structuredClone(template));
  }
}
export class WorkflowCatalog {
  #workflows = new Map<string, ResolvedWorkflow>();
  #sealed = false;
  get sealed() {
    return this.#sealed;
  }
  assertSealed() {
    if (!this.#sealed)
      throw new DomainError('WORKFLOWS_UNSEALED', 'Seal workflows before selecting one.');
  }
  register(input: WorkflowContribution): void {
    if (this.#sealed) throw new DomainError('WORKFLOWS_SEALED', 'Workflows are already sealed.');
    if (
      !input ||
      !WorkflowIdentitySchema.safeParse({ id: input.id, revision: input.revision }).success ||
      typeof input.templateFor !== 'function'
    )
      throw new DomainError(
        'INVALID_WORKFLOW',
        'A workflow needs an ID, revision and role-template selector.',
      );
    if (this.#workflows.has(input.id))
      throw new DomainError('WORKFLOW_EXISTS', 'A workflow with this ID is already registered.');
    const { id, revision, templateFor } = input;
    this.#workflows.set(
      id,
      Object.freeze({
        id,
        revision,
        templateFor: (operation: ServiceOperation) => {
          const selected = templateFor(immutable(structuredClone(operation)));
          if (selected !== undefined && !ResourceIdSchema.safeParse(selected).success)
            throw new DomainError(
              'INVALID_WORKFLOW',
              'A workflow selector must return only a registered template ID.',
            );
          return selected;
        },
      }),
    );
  }
  seal() {
    this.#sealed = true;
    return this;
  }
  get(id: string): ResolvedWorkflow {
    this.assertSealed();
    const workflow = this.#workflows.get(id);
    if (!workflow)
      throw new DomainError('WORKFLOW_UNAVAILABLE', 'The configured workflow is not registered.');
    return workflow;
  }
  list() {
    this.assertSealed();
    return [...this.#workflows.values()].map(({ id, revision }) => ({ id, revision }));
  }
}
export interface WorkflowRoleResolver {
  readonly workflow: WorkflowIdentity;
  ensureRole(
    doc: Pick<ProjectDocument, 'roleVersions'>,
    operation: ServiceOperation,
    now: string,
  ): { role: Role; created: boolean };
}
/** The host supplies role identity and time. A template contributes content, never grants or model routing. */
export function instantiateWorkflowRole(
  template: RoleTemplate,
  workflow: WorkflowIdentity,
  roleId: string,
  now: string,
): Role {
  const content = templateSchema.parse(structuredClone(template));
  return RoleSchema.parse({
    id: ResourceIdSchema.parse(roleId),
    version: 1,
    title: content.title,
    description: content.description,
    instructions: content.instructions,
    kind: content.kind,
    createdAt: now,
    updatedAt: now,
    provenance: {
      origin: 'workflow',
      workflow: WorkflowIdentitySchema.parse(workflow),
      template: { id: content.id, revision: content.revision },
    },
  });
}
export function createWorkflowRoleResolver(options: {
  templates: RoleTemplateCatalog;
  workflows: WorkflowCatalog;
  workflowId: string;
}): WorkflowRoleResolver {
  const templates = options.templates,
    workflows = options.workflows;
  templates.assertSealed();
  workflows.assertSealed();
  const selected = workflows.get(options.workflowId),
    workflow = immutable({ id: selected.id, revision: selected.revision });
  return Object.freeze({
    workflow,
    ensureRole: (
      doc: Pick<ProjectDocument, 'roleVersions'>,
      operation: ServiceOperation,
      now: string,
    ) => {
      if (operation.roles.kind !== 'fixed')
        throw new DomainError(
          'WORKFLOW_ROLE_UNAVAILABLE',
          'This operation does not bind a service role.',
        );
      const roleId = operation.roles.roleId;
      const existing = doc.roleVersions.filter((role) => role.id === roleId).at(-1);
      if (existing) return { role: structuredClone(existing), created: false };
      const templateId = selected.templateFor(operation);
      if (templateId === undefined)
        throw new DomainError(
          'WORKFLOW_ROLE_UNAVAILABLE',
          'The selected workflow has no role template for this operation.',
        );
      const role = instantiateWorkflowRole(templates.get(templateId), workflow, roleId, now);
      doc.roleVersions.push(role);
      return { role: structuredClone(role), created: true };
    },
  });
}
/** Role versions are append-only. Later edits create a new user-authored version. */
export function validateRoleHistoryTransitions(
  previous: readonly Role[],
  next: readonly Role[],
): void {
  const keys = new Map<string, string>();
  const latest = new Map<string, number>();
  const identity = (role: Role | undefined) => {
    const result = RoleSchema.safeParse(role);
    return result.success ? JSON.stringify(result.data) : undefined;
  };
  for (const role of next) {
    const key = JSON.stringify([role.id, role.version]);
    if (keys.has(key))
      throw new DomainError(
        'ROLE_HISTORY_CHANGED',
        'A role version must have one immutable definition.',
      );
    const value = identity(role);
    if (value === undefined)
      throw new DomainError('ROLE_HISTORY_CHANGED', 'Role history contains an invalid version.');
    keys.set(key, value);
  }
  for (let index = 0; index < previous.length; index++) {
    const before = previous[index];
    if (identity(next[index]) !== identity(before))
      throw new DomainError(
        'ROLE_HISTORY_CHANGED',
        'Existing role versions and provenance cannot be removed, reordered or changed.',
      );
    latest.set(before.id, before.version);
  }
  for (const role of next.slice(previous.length)) {
    if (role.version !== (latest.get(role.id) || 0) + 1)
      throw new DomainError(
        'ROLE_HISTORY_CHANGED',
        'New role versions must append the next version.',
      );
    latest.set(role.id, role.version);
  }
}

/** A captured version keeps its original content/provenance even when later plans add other roles. */
export function validateCapturedRoleSnapshots(
  previous: ProjectDocument,
  next: ProjectDocument,
): void {
  for (const before of previous.runs) {
    const after = next.runs.find((run) => run.id === before.id);
    if (!after) continue;
    if (before.workflow && JSON.stringify(before.workflow) !== JSON.stringify(after.workflow))
      throw new DomainError(
        'WORKFLOW_CHANGED',
        'The saved run workflow identity cannot be changed.',
      );
    for (const captured of before.roleSnapshots || []) {
      const matching =
        after.roleSnapshots?.filter(
          (role) => role.id === captured.id && role.version === captured.version,
        ) || [];
      const referenced = [
        after.roleResources?.[captured.id],
        after.assignmentResources?.[captured.id],
        ...Object.values(after.operationResources || {}).map((roles) => roles[captured.id]),
      ].some((decision) => decision?.roleVersion === captured.version);
      if (
        (referenced && matching.length !== 1) ||
        matching.length > 1 ||
        matching.some(
          (role) =>
            JSON.stringify(RoleSchema.parse(role)) !== JSON.stringify(RoleSchema.parse(captured)),
        )
      )
        throw new DomainError(
          'ROLE_HISTORY_CHANGED',
          'A captured role version and its provenance cannot be rewritten.',
        );
    }
  }
}
