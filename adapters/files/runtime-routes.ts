import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  RuntimeResourceSchema,
  AssignmentResourceSchema,
  ResourceSnapshotSchema,
} from '../../protocol/resources.ts';
import { RoleSchema } from '../../protocol/workflow-roles.ts';
import { BackendRequirementsSchema } from '../../protocol/backend-capabilities.ts';
import { DomainError } from '../../core/ports.ts';
import type { RuntimeRoute, RuntimeRouteStore } from '../../core/runtime-router.ts';
import { PrivateJSONFiles } from './private-json.ts';
const schema = z.object({
  id: z.string(),
  projectId: z.string(),
  runId: z.string().optional(),
  ownerRunId: z.string().optional(),
  workspace: z.string().optional(),
  resource: RuntimeResourceSchema,
  requirements: BackendRequirementsSchema,
  readOnly: z.boolean().optional(),
  roleId: z.string().optional(),
  operationId: z.string().optional(),
  roleDecision: AssignmentResourceSchema.optional(),
  roleGrant: z.strictObject({ role: RoleSchema, resources: ResourceSnapshotSchema }).optional(),
  purpose: z
    .enum(['coordination', 'implementation', 'review', 'research', 'environment', 'delivery'])
    .optional(),
  verificationViewId: z.string().optional(),
  externalThreadId: z.string().optional(),
  status: z.enum(['starting', 'ready', 'unknown', 'rejected']),
});
const key = (id: string) => createHash('sha256').update(id).digest('hex');
export class FileRuntimeRoutes implements RuntimeRouteStore {
  private files: PrivateJSONFiles;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(directory: string) {
    this.files = new PrivateJSONFiles(directory);
  }
  async load(id: string) {
    const value = await this.files.load(key(id));
    if (value === undefined) return undefined;
    const route = schema.parse(value);
    if (route.id !== id)
      throw new DomainError('INVALID_CHECKPOINT', 'Runtime route identity mismatch.');
    return route;
  }
  save(route: RuntimeRoute) {
    const next = schema.parse(structuredClone(route));
    const authority = (value: RuntimeRoute) =>
      JSON.stringify([
        value.id,
        value.projectId,
        value.runId,
        value.ownerRunId,
        value.workspace,
        value.resource,
        value.requirements,
        value.readOnly,
        value.purpose,
        value.operationId,
        value.roleId,
        value.roleGrant,
        value.verificationViewId,
        value.roleDecision && [
          value.roleDecision.resource,
          value.roleDecision.roleVersion,
          value.roleDecision.preference,
          value.roleDecision.source,
        ],
      ]);
    const saving = this.queue.then(async () => {
      const previous = await this.load(next.id);
      if (
        previous &&
        (authority(previous) !== authority(next) ||
          (previous.externalThreadId !== undefined &&
            previous.externalThreadId !== next.externalThreadId))
      )
        throw new DomainError(
          'INVALID_ASSIGNMENT',
          'A saved runtime route cannot retarget its original grant or session.',
        );
      await this.files.save(key(next.id), next);
    });
    this.queue = saving.catch(() => {});
    return saving;
  }
}
