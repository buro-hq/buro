import path from 'node:path';
import { z } from 'zod';
import { DomainError } from '../../core/ports.ts';
import { ResourceIdSchema, ResourceProfileSchema } from '../../protocol/resources.ts';
import { PrivateJSONFiles } from './private-json.ts';
const endpoint = z.string().url().max(1000);
const connection = z.discriminatedUnion('kind', [
  z.strictObject({
    id: ResourceIdSchema,
    kind: z.literal('ollama'),
    endpoint: endpoint.default('http://127.0.0.1:11434'),
    capacity: z.number().int().min(1).max(8).default(1),
    think: z.union([z.boolean(), z.string().max(40)]).optional(),
  }),
  z.strictObject({
    id: ResourceIdSchema,
    kind: z.literal('deepseek'),
    endpoint: endpoint.default('https://api.deepseek.com'),
    capacity: z.number().int().min(1).max(8).default(2),
    apiKeyEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,99}$/)
      .default('DEEPSEEK_API_KEY'),
    thinking: z.enum(['enabled', 'disabled']).default('disabled'),
  }),
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
    connections: z.array(connection).max(16),
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
    receipts: z
      .record(z.string(), z.object({ fingerprint: z.string(), profileId: ResourceIdSchema }))
      .default({}),
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
      if (![profile.coordinator, profile.worker, profile.reviewer].every((id) => runtimes.has(id)))
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
  readonly filename: string;
  constructor(directory: string, state: ResourceConfiguration) {
    this.files = new PrivateJSONFiles(directory);
    this.filename = path.join(directory, 'resources.json');
    this.state = state;
  }
  static async open(directory: string) {
    const files = new PrivateJSONFiles(directory),
      value = await files.load('resources');
    return new FileResourceConfiguration(
      directory,
      value === undefined ? defaultResources() : ResourceConfigurationSchema.parse(value),
    );
  }
  snapshot() {
    return structuredClone(this.state);
  }
  init() {
    const action = this.queue.then(async () => {
      if ((await this.files.load('resources')) !== undefined)
        return { created: false, path: this.filename };
      await this.files.save('resources', this.state);
      return { created: true, path: this.filename };
    });
    this.queue = action.catch(() => {});
    return action;
  }
  use(id: string, fingerprint: string, profileId: string) {
    const action = this.queue.then(async () => {
      const receipt = Object.hasOwn(this.state.receipts, id) ? this.state.receipts[id] : undefined;
      if (receipt) {
        if (receipt.fingerprint !== fingerprint)
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            'This command ID was used for another resource change.',
          );
        return { profileId: receipt.profileId, appliesTo: 'new-runs' };
      }
      if (!this.state.profiles.some((profile) => profile.id === profileId))
        throw new DomainError('RESOURCE_PROFILE_UNAVAILABLE', 'Resource profile unavailable.');
      const persisted = await this.files.load('resources');
      if (
        persisted !== undefined &&
        JSON.stringify(ResourceConfigurationSchema.parse(persisted)) !== JSON.stringify(this.state)
      )
        throw new DomainError(
          'RESOURCE_CONFIG_CHANGED',
          'Resource configuration was edited externally. Restart the service to load it.',
        );
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
      return { profileId, appliesTo: 'new-runs' };
    });
    this.queue = action.catch(() => {});
    return action;
  }
}
