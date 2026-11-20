import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../../core/ports.ts';
import {
  ResourceIdSchema,
  ResourceProfileSchema,
  ResourceConnectionSchema,
  type ResourceConnection,
} from '../../protocol/resources.ts';
import { PrivateJSONFiles } from './private-json.ts';
export const connectionConfigurationRevision = (connection: ResourceConnection) =>
  createHash('sha256')
    .update(JSON.stringify(ResourceConnectionSchema.parse(connection)))
    .digest('hex');
const receiptSchema = z.union([
  z.strictObject({ fingerprint: z.string(), profileId: ResourceIdSchema }),
  z.strictObject({ fingerprint: z.string(), connectionId: ResourceIdSchema }),
]);
export const ManagedLimitsSchema = z
  .strictObject({
    contextTokens: z.number().int().min(1024).max(262144).default(32768),
    maxOutputTokens: z.number().int().min(128).max(32768).default(4096),
    maxRequestsPerTurn: z.number().int().min(1).max(64).default(24),
    maxToolCallsPerTurn: z.number().int().min(1).max(128).default(64),
    maxSessionRequests: z.number().int().min(1).max(1024).default(256),
  })
  .refine((limits) => limits.maxOutputTokens < limits.contextTokens, 'Reserve input context.');
export const ResourceConfigurationSchema = z
  .strictObject({
    version: z.literal(1),
    defaultProfile: ResourceIdSchema,
    connections: z.array(ResourceConnectionSchema).max(16),
    runtimes: z
      .array(
        z.discriminatedUnion('client', [
          z.strictObject({ id: z.literal('codex'), client: z.literal('codex') }),
          z.strictObject({
            id: ResourceIdSchema,
            client: z.literal('managed'),
            connectionId: ResourceIdSchema,
            model: z.string().min(1).max(200),
            limits: ManagedLimitsSchema.default(() => ManagedLimitsSchema.parse({})),
          }),
        ]),
      )
      .min(1)
      .max(32),
    profiles: z.array(ResourceProfileSchema).min(1).max(32),
    receipts: z.record(z.string(), receiptSchema).default({}),
  })
  .superRefine((value, ctx) => {
    const connections = new Set(value.connections.map((item) => item.id)),
      runtimes = new Set(value.runtimes.map((item) => item.id)),
      profiles = new Set(value.profiles.map((item) => item.id));
    if (
      connections.size !== value.connections.length ||
      runtimes.size !== value.runtimes.length ||
      profiles.size !== value.profiles.length
    )
      ctx.addIssue({ code: 'custom', message: 'Resource IDs must be unique.' });
    if (!profiles.has(value.defaultProfile))
      ctx.addIssue({ code: 'custom', message: 'Default resource profile is missing.' });
    for (const runtime of value.runtimes)
      if (
        runtime.client === 'managed' &&
        (runtime.id === 'codex' || !connections.has(runtime.connectionId))
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Managed runtime needs an existing connection and a nonreserved ID.',
        });
    for (const profile of value.profiles)
      if (
        ![
          profile.coordinator,
          profile.worker,
          profile.reviewer,
          ...(profile.workerPool || []),
        ].every((id) => runtimes.has(id))
      )
        ctx.addIssue({ code: 'custom', message: 'A profile references a missing runtime.' });
  });
export type ResourceConfiguration = z.infer<typeof ResourceConfigurationSchema>;
export const defaultResources = () =>
  ResourceConfigurationSchema.parse({
    version: 1,
    defaultProfile: 'codex',
    connections: [
      { id: 'ollama', kind: 'ollama' },
      { id: 'deepseek', kind: 'deepseek' },
    ],
    runtimes: [{ id: 'codex', client: 'codex' }],
    profiles: [
      {
        id: 'codex',
        name: 'Codex',
        policy: 'hybrid',
        coordinator: 'codex',
        worker: 'codex',
        reviewer: 'codex',
      },
    ],
  });
export class FileResourceConfiguration {
  private files: PrivateJSONFiles;
  private queue: Promise<unknown> = Promise.resolve();
  private state: ResourceConfiguration;
  private hasPersisted = false;
  readonly filename: string;
  constructor(directory: string, state: ResourceConfiguration) {
    this.files = new PrivateJSONFiles(directory);
    this.filename = path.join(directory, 'resources.json');
    this.state = ResourceConfigurationSchema.parse(state);
  }
  static async open(directory: string) {
    const files = new PrivateJSONFiles(directory),
      value = await files.load('resources');
    const configuration = new FileResourceConfiguration(
      directory,
      value === undefined ? defaultResources() : ResourceConfigurationSchema.parse(value),
    );
    configuration.hasPersisted = value !== undefined;
    return configuration;
  }
  snapshot() {
    return structuredClone(this.state);
  }
  init() {
    const action = this.queue.then(async () => {
      if ((await this.files.load('resources')) !== undefined) {
        this.hasPersisted = true;
        return { created: false, path: this.filename };
      }
      if (this.hasPersisted) this.configurationChanged();
      await this.files.save('resources', this.state);
      this.hasPersisted = true;
      return { created: true, path: this.filename };
    });
    this.queue = action.catch(() => {});
    return action;
  }
  use(id: string, fingerprint: string, profileId: string) {
    const action = this.queue.then(async () => {
      const receipt = Object.hasOwn(this.state.receipts, id) ? this.state.receipts[id] : undefined;
      if (receipt) {
        if (receipt.fingerprint !== fingerprint || !('profileId' in receipt))
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            'This command ID was used for another resource change.',
          );
        return { profileId: receipt.profileId, appliesTo: 'new-runs' };
      }
      if (!this.state.profiles.some((profile) => profile.id === profileId))
        throw new DomainError('RESOURCE_PROFILE_UNAVAILABLE', 'Resource profile unavailable.');
      await this.assertUnchanged();
      const next = structuredClone(this.state);
      next.defaultProfile = profileId;
      Object.defineProperty(next.receipts, id, {
        value: { fingerprint, profileId },
        enumerable: true,
        writable: true,
        configurable: true,
      });
      await this.files.save('resources', next);
      this.state = next;
      this.hasPersisted = true;
      return { profileId, appliesTo: 'new-runs' };
    });
    this.queue = action.catch(() => {});
    return action;
  }
  save(
    id: string,
    fingerprint: string,
    input: ResourceConnection,
    expectedRevision: string | null,
  ) {
    // Parse and copy before queuing so a caller cannot mutate a pending write.
    const connection = ResourceConnectionSchema.parse(input);
    const action = this.queue.then(async () => {
      const receipt = Object.hasOwn(this.state.receipts, id) ? this.state.receipts[id] : undefined;
      if (receipt) {
        if (receipt.fingerprint !== fingerprint || !('connectionId' in receipt))
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            'This command ID was used for another resource change.',
          );
        return { connectionId: receipt.connectionId, appliesTo: 'service-restart' as const };
      }
      const current = this.state.connections.find((item) => item.id === connection.id);
      if ((current ? connectionConfigurationRevision(current) : null) !== expectedRevision)
        throw new DomainError(
          'RESOURCE_CONNECTION_CONFLICT',
          'This connection changed. Reload its settings before saving.',
        );
      if (
        current &&
        current.kind !== connection.kind &&
        this.state.runtimes.some(
          (runtime) => runtime.client === 'managed' && runtime.connectionId === current.id,
        )
      )
        throw new DomainError(
          'RESOURCE_CONNECTION_IN_USE',
          'A configured runtime uses this provider. Add a separate connection instead.',
        );
      await this.assertUnchanged();
      const next = structuredClone(this.state);
      const index = next.connections.findIndex((item) => item.id === connection.id);
      if (index < 0) {
        if (next.connections.length >= 16)
          throw new DomainError(
            'RESOURCE_CONNECTION_LIMIT',
            'At most 16 model connections can be configured.',
          );
        next.connections.push(connection);
      } else next.connections[index] = connection;
      Object.defineProperty(next.receipts, id, {
        value: { fingerprint, connectionId: connection.id },
        enumerable: true,
        writable: true,
        configurable: true,
      });
      const validated = ResourceConfigurationSchema.parse(next);
      await this.files.save('resources', validated);
      this.state = validated;
      this.hasPersisted = true;
      return { connectionId: connection.id, appliesTo: 'service-restart' as const };
    });
    this.queue = action.catch(() => {});
    return action;
  }
  private configurationChanged(): never {
    throw new DomainError(
      'RESOURCE_CONFIG_CHANGED',
      'Resource configuration was edited externally. Restart the service to load it.',
    );
  }
  private async assertUnchanged() {
    const persisted = await this.files.load('resources');
    if (persisted === undefined) {
      if (this.hasPersisted) this.configurationChanged();
      return;
    }
    const parsed = ResourceConfigurationSchema.safeParse(persisted);
    if (!parsed.success || JSON.stringify(parsed.data) !== JSON.stringify(this.state))
      this.configurationChanged();
  }
}
