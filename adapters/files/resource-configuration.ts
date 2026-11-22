import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../../core/ports.ts';
import {
  ResourceIdSchema,
  ResourceProfileSchema,
  ResourceConnectionSchema,
  ResourceSetupInputSchema,
  RuntimeDefinitionSchema,
  type ResourceConnection,
  type ResourceSetupInput,
} from '../../protocol/resources.ts';
import { ResourceContributionCatalog } from '../../core/resource-contributions.ts';
import { PrivateJSONFiles } from './private-json.ts';
export const connectionConfigurationRevision = (connection: ResourceConnection) =>
  createHash('sha256')
    .update(JSON.stringify(ResourceConnectionSchema.parse(connection)))
    .digest('hex');
const receiptSchema = z.union([
  z.strictObject({ fingerprint: z.string(), profileId: ResourceIdSchema }),
  z.strictObject({ fingerprint: z.string(), connectionId: ResourceIdSchema }),
  z.strictObject({
    fingerprint: z.string(),
    setupProfileId: ResourceIdSchema,
    runtimeIds: z.array(ResourceIdSchema),
  }),
]);
export const ResourceConfigurationSchema = z
  .strictObject({
    version: z.literal(1),
    defaultProfile: ResourceIdSchema.nullable(),
    connections: z.array(ResourceConnectionSchema),
    runtimes: z.array(RuntimeDefinitionSchema),
    profiles: z.array(ResourceProfileSchema),
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
    if (value.defaultProfile !== null && !profiles.has(value.defaultProfile))
      ctx.addIssue({ code: 'custom', message: 'Default resource profile is missing.' });
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
/** Machine settings only: command receipts and separate private credentials do not affect the revision. */
export function resourceConfigurationRevision(configuration: ResourceConfiguration) {
  const { version, defaultProfile, connections, runtimes, profiles } =
    ResourceConfigurationSchema.parse(configuration);
  return createHash('sha256')
    .update(JSON.stringify({ version, defaultProfile, connections, runtimes, profiles }))
    .digest('hex');
}
export const defaultResources = () =>
  ResourceConfigurationSchema.parse({
    version: 1,
    defaultProfile: null,
    connections: [],
    runtimes: [],
    profiles: [],
  });
export class FileResourceConfiguration {
  private files: PrivateJSONFiles;
  private queue: Promise<unknown> = Promise.resolve();
  private state: ResourceConfiguration;
  private hasPersisted = false;
  readonly filename: string;
  private catalog: ResourceContributionCatalog;
  constructor(
    directory: string,
    state: ResourceConfiguration,
    catalog: ResourceContributionCatalog,
  ) {
    catalog.assertSealed();
    this.catalog = catalog;
    this.files = new PrivateJSONFiles(directory);
    this.filename = path.join(directory, 'resources.json');
    this.state = this.validate(state);
  }
  static async open(directory: string, catalog: ResourceContributionCatalog) {
    catalog.assertSealed();
    const files = new PrivateJSONFiles(directory),
      value = await files.load('resources');
    const configuration = new FileResourceConfiguration(
      directory,
      value === undefined ? defaultResources() : ResourceConfigurationSchema.parse(value),
      catalog,
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
        await this.assertUnchanged();
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
      const validated = this.validate(next);
      await this.files.save('resources', validated);
      this.state = validated;
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
    const connection = this.catalog.parseConnection(input);
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
        current.provider !== connection.provider &&
        this.state.runtimes.some((runtime) =>
          this.catalog.backend(runtime.backend).dependencies(runtime.config).includes(current.id),
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
        next.connections.push(connection);
      } else next.connections[index] = connection;
      Object.defineProperty(next.receipts, id, {
        value: { fingerprint, connectionId: connection.id },
        enumerable: true,
        writable: true,
        configurable: true,
      });
      const validated = this.validate(next);
      await this.files.save('resources', validated);
      this.state = validated;
      this.hasPersisted = true;
      return { connectionId: connection.id, appliesTo: 'service-restart' as const };
    });
    this.queue = action.catch(() => {});
    return action;
  }
  saveSetup(id: string, fingerprint: string, input: ResourceSetupInput) {
    const setup = ResourceSetupInputSchema.parse(structuredClone(input));
    setup.runtimes = setup.runtimes.map((runtime) => this.catalog.parseRuntime(runtime));
    const action = this.queue.then(async () => {
      const receipt = Object.hasOwn(this.state.receipts, id) ? this.state.receipts[id] : undefined;
      if (receipt) {
        if (receipt.fingerprint !== fingerprint || !('setupProfileId' in receipt))
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            'This command ID was used for another resource change.',
          );
        return {
          profileId: receipt.setupProfileId,
          runtimeIds: [...receipt.runtimeIds],
          appliesTo: 'service-restart' as const,
        };
      }
      if (resourceConfigurationRevision(this.state) !== setup.expectedRevision)
        throw new DomainError(
          'RESOURCE_SETUP_CONFLICT',
          'Resource settings changed. Reload them before creating the execution profile.',
        );
      const ids = new Set(setup.runtimes.map((runtime) => runtime.id));
      if (
        ids.size !== setup.runtimes.length ||
        setup.runtimes.some((runtime) =>
          this.state.runtimes.some((item) => item.id === runtime.id),
        ) ||
        this.state.profiles.some((profile) => profile.id === setup.profile.id)
      )
        throw new DomainError(
          'RESOURCE_SETUP_ID_EXISTS',
          'Runtime and profile IDs must be new and unique. Existing definitions cannot be replaced.',
        );
      await this.assertUnchanged();
      const next = structuredClone(this.state);
      next.runtimes.push(...setup.runtimes);
      next.profiles.push(setup.profile);
      const runtimeIds = setup.runtimes.map((runtime) => runtime.id);
      Object.defineProperty(next.receipts, id, {
        value: { fingerprint, setupProfileId: setup.profile.id, runtimeIds },
        enumerable: true,
        writable: true,
        configurable: true,
      });
      const validated = this.validate(next);
      await this.files.save('resources', validated);
      this.state = validated;
      this.hasPersisted = true;
      return { profileId: setup.profile.id, runtimeIds, appliesTo: 'service-restart' as const };
    });
    this.queue = action.catch(() => {});
    return action;
  }
  private validate(value: unknown): ResourceConfiguration {
    return this.catalog.validateConfiguration(ResourceConfigurationSchema.parse(value));
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
    let parsed: ResourceConfiguration;
    try {
      parsed = this.validate(persisted);
    } catch {
      this.configurationChanged();
    }
    if (JSON.stringify(parsed) !== JSON.stringify(this.state)) this.configurationChanged();
  }
}
