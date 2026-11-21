import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RuntimeResourceSchema, AssignmentResourceSchema } from '../../protocol/resources.ts';
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
  roleDecision: AssignmentResourceSchema.optional(),
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
    return this.files.save(key(route.id), schema.parse(route));
  }
}
