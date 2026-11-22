import type { ModelProvider } from '../agent/contracts/model.ts';
import {
  ResourceConfigSchema,
  ResourceConnectionSchema,
  ResourceIdSchema,
  ResourceProfileSchema,
  RuntimeDefinitionSchema,
  type ResourceConfig,
  type ResourceConnection,
  type ResourceContributionDescriptor,
  type ResourceModel,
  type ResourceProfile,
  type RuntimeDefinition,
} from '../protocol/resources.ts';
import { DomainError, type RegisteredRuntime } from './ports.ts';
import type { ProbeBinding } from './capability-probe.ts';

export interface ResourceRequestGate {
  run<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T>;
}
export type ProviderDescription = {
  local: boolean;
  endpoint?: string;
  capacityKey: string;
  capacity: number;
  credentialReferences: string[];
  modelListing: boolean;
  /** Trusted provider-authored model admission; not a serialized connection DTO. */
  describeModel?: (model: string) => ProviderModelDescription;
};
export type ProviderModelDescription = { local: boolean; supported: boolean; reason?: string };
export type ProviderInstance = {
  provider: ModelProvider;
  listModels?: (signal: AbortSignal) => Promise<ResourceModel[]>;
  dispose?: () => Promise<void>;
};
export type BackendInstance = {
  runtime: RegisteredRuntime;
  /** Identity of actual host policy/options captured by the trusted factory. */
  revision: string;
  model?: string;
  providerId?: string;
  local: boolean;
  probe?: Omit<ProbeBinding, 'configurationRevision'>;
};
export type ProviderContribution = ResourceContributionDescriptor & {
  parse(config: ResourceConfig): ResourceConfig;
  describe(config: ResourceConfig): ProviderDescription;
  describeModel?(config: ResourceConfig, model: string): ProviderModelDescription;
  create(input: {
    id: string;
    config: ResourceConfig;
    fetch: typeof fetch;
    credentials: (reference: string) => string | undefined;
    gate: ResourceRequestGate;
  }): ProviderInstance | Promise<ProviderInstance>;
};
export type BackendContribution = ResourceContributionDescriptor & {
  parse(config: ResourceConfig): ResourceConfig;
  dependencies(config: ResourceConfig): string[];
  describe(
    config: ResourceConfig,
    providers: ReadonlyMap<string, ProviderDescription>,
  ): { local: boolean };
  create(input: {
    id: string;
    config: ResourceConfig;
    providers: ReadonlyMap<string, ProviderInstance>;
    providerDescriptions: ReadonlyMap<string, ProviderDescription>;
  }): BackendInstance | Promise<BackendInstance>;
  template?(
    connection: ResourceConnection,
    model: string,
    provider: ProviderDescription,
  ):
    | {
        label: string;
        config: ResourceConfig;
        local: boolean;
      }
    | undefined;
};
export type ResourceConfigurationInput = {
  defaultProfile: string;
  connections: ResourceConnection[];
  runtimes: RuntimeDefinition[];
  profiles: ResourceProfile[];
};

function immutable<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
const configCopy = (value: unknown) => ResourceConfigSchema.parse(structuredClone(value));
const invalid = () =>
  new DomainError(
    'INVALID_RESOURCE_CONFIGURATION',
    'Resource configuration is invalid for its registered contribution.',
  );
function parseConfig(
  parse: (config: ResourceConfig) => ResourceConfig,
  config: unknown,
): ResourceConfig {
  try {
    return configCopy(parse(configCopy(config)));
  } catch {
    throw invalid();
  }
}
function descriptor(input: ResourceContributionDescriptor): ResourceContributionDescriptor {
  if (
    !ResourceIdSchema.safeParse(input.id).success ||
    typeof input.label !== 'string' ||
    !input.label.trim() ||
    typeof input.revision !== 'string' ||
    !input.revision.trim()
  )
    throw new DomainError(
      'INVALID_RESOURCE_CONTRIBUTION',
      'A contribution needs an ID, label and revision.',
    );
  if (input.editor !== undefined && (typeof input.editor !== 'string' || !input.editor.trim()))
    throw new DomainError(
      'INVALID_RESOURCE_CONTRIBUTION',
      'A contribution editor must have a nonempty ID.',
    );
  return immutable({
    id: input.id,
    label: input.label,
    revision: input.revision,
    ...(input.editor ? { editor: input.editor } : {}),
    defaultConfig: configCopy(input.defaultConfig),
    ...(input.configSchema ? { configSchema: configCopy(input.configSchema) } : {}),
  });
}
function checkedDescription(
  value: ProviderDescription,
  describeModel?: (model: string) => ProviderModelDescription,
): ProviderDescription {
  if (
    typeof value?.local !== 'boolean' ||
    typeof value.modelListing !== 'boolean' ||
    typeof value.capacityKey !== 'string' ||
    !value.capacityKey.trim() ||
    !Number.isSafeInteger(value.capacity) ||
    value.capacity < 1 ||
    (value.endpoint !== undefined && typeof value.endpoint !== 'string') ||
    !Array.isArray(value.credentialReferences) ||
    value.credentialReferences.some((ref) => typeof ref !== 'string' || !ref.trim())
  )
    throw new DomainError(
      'INVALID_RESOURCE_CONTRIBUTION',
      'A provider returned invalid resource metadata.',
    );
  const local = value.local;
  return immutable({
    local: value.local,
    ...(value.endpoint === undefined ? {} : { endpoint: value.endpoint }),
    capacityKey: value.capacityKey,
    capacity: value.capacity,
    credentialReferences: [...value.credentialReferences],
    modelListing: value.modelListing,
    describeModel: (model: string) => {
      const result = describeModel ? describeModel(model) : { local, supported: true };
      if (
        typeof result?.local !== 'boolean' ||
        typeof result.supported !== 'boolean' ||
        (result.reason !== undefined && typeof result.reason !== 'string')
      )
        throw new DomainError(
          'INVALID_RESOURCE_CONTRIBUTION',
          'A provider returned invalid model metadata.',
        );
      return Object.freeze({
        local: local && result.local,
        supported: result.supported,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      });
    },
  });
}
/** Trusted registrations are fixed before any saved configuration is admitted. */
export class ResourceContributionCatalog {
  #providers = new Map<string, ProviderContribution>();
  #backends = new Map<string, BackendContribution>();
  #sealed = false;
  get sealed() {
    return this.#sealed;
  }
  assertSealed() {
    if (!this.#sealed)
      throw new DomainError(
        'RESOURCE_CONTRIBUTIONS_UNSEALED',
        'Seal resource contributions before loading configuration.',
      );
  }
  #assertWritable() {
    if (this.#sealed)
      throw new DomainError(
        'RESOURCE_CONTRIBUTIONS_SEALED',
        'Resource contributions are already sealed.',
      );
  }
  registerProvider(input: ProviderContribution) {
    this.#assertWritable();
    const publicDescriptor = descriptor(input);
    if (this.#providers.has(input.id))
      throw new DomainError(
        'RESOURCE_PROVIDER_EXISTS',
        'A provider contribution with this ID is already registered.',
      );
    if (
      typeof input.parse !== 'function' ||
      typeof input.describe !== 'function' ||
      typeof input.create !== 'function' ||
      (input.describeModel !== undefined && typeof input.describeModel !== 'function')
    )
      throw new DomainError(
        'INVALID_RESOURCE_CONTRIBUTION',
        'A provider needs configuration, metadata and creation callbacks.',
      );
    const { parse, describe, describeModel, create } = input;
    this.#providers.set(
      input.id,
      Object.freeze({
        ...publicDescriptor,
        parse: (config: ResourceConfig) => parseConfig(parse, config),
        describe: (config: ResourceConfig) => {
          const captured = immutable(parseConfig(parse, config));
          return checkedDescription(
            describe(captured),
            describeModel ? (model) => describeModel(captured, model) : undefined,
          );
        },
        create: (input: Parameters<ProviderContribution['create']>[0]) =>
          create({ ...input, config: immutable(parseConfig(parse, input.config)) }),
      }),
    );
  }
  registerBackend(input: BackendContribution) {
    this.#assertWritable();
    const publicDescriptor = descriptor(input);
    if (this.#backends.has(input.id))
      throw new DomainError(
        'RESOURCE_BACKEND_EXISTS',
        'A backend contribution with this ID is already registered.',
      );
    if (
      typeof input.parse !== 'function' ||
      typeof input.dependencies !== 'function' ||
      typeof input.describe !== 'function' ||
      typeof input.create !== 'function' ||
      (input.template !== undefined && typeof input.template !== 'function')
    )
      throw new DomainError(
        'INVALID_RESOURCE_CONTRIBUTION',
        'A backend needs configuration, dependency, metadata and creation callbacks.',
      );
    const { parse, dependencies, describe, create, template } = input;
    const parseDependencies = (config: ResourceConfig) => {
      const value = dependencies(immutable(parseConfig(parse, config)));
      if (
        !Array.isArray(value) ||
        value.some((id) => !ResourceIdSchema.safeParse(id).success) ||
        new Set(value).size !== value.length
      )
        throw new DomainError(
          'INVALID_RESOURCE_CONTRIBUTION',
          'A backend returned invalid provider dependencies.',
        );
      return [...value];
    };
    const describeBackend = (
      config: ResourceConfig,
      providers: ReadonlyMap<string, ProviderDescription>,
    ) => {
      const value = describe(immutable(parseConfig(parse, config)), providers);
      if (typeof value?.local !== 'boolean')
        throw new DomainError(
          'INVALID_RESOURCE_CONTRIBUTION',
          'A backend returned invalid locality metadata.',
        );
      return Object.freeze({ local: value.local });
    };
    this.#backends.set(
      input.id,
      Object.freeze({
        ...publicDescriptor,
        parse: (config: ResourceConfig) => parseConfig(parse, config),
        dependencies: parseDependencies,
        describe: describeBackend,
        create: (input: Parameters<BackendContribution['create']>[0]) =>
          create({ ...input, config: immutable(parseConfig(parse, input.config)) }),
        ...(template
          ? {
              template: (
                connection: ResourceConnection,
                model: string,
                provider: ProviderDescription,
              ) => {
                const captured = immutable(this.parseConnection(connection));
                const metadata = checkedDescription(provider, provider.describeModel);
                const value = template(captured, model, metadata);
                if (value === undefined) return undefined;
                if (
                  typeof value?.label !== 'string' ||
                  !value.label.trim() ||
                  typeof value.local !== 'boolean'
                )
                  throw new DomainError(
                    'INVALID_RESOURCE_CONTRIBUTION',
                    'A backend returned an invalid model template.',
                  );
                const config = parseConfig(parse, value.config);
                const ids = parseDependencies(config);
                if (ids.some((id) => id !== captured.id))
                  throw new DomainError(
                    'RESOURCE_DEPENDENCY_UNAVAILABLE',
                    'The model template references an unavailable provider connection.',
                  );
                const available = new Map(ids.map((id) => [id, metadata]));
                const declared = describeBackend(config, available);
                return {
                  label: value.label,
                  config,
                  local: value.local && declared.local && ids.every(() => metadata.local),
                };
              },
            }
          : {}),
      }),
    );
  }
  seal() {
    this.#sealed = true;
    return this;
  }
  provider(id: string): ProviderContribution {
    this.assertSealed();
    const value = this.#providers.get(id);
    if (!value)
      throw new DomainError(
        'RESOURCE_PROVIDER_UNAVAILABLE',
        'The configured provider contribution is not registered.',
      );
    return value;
  }
  backend(id: string): BackendContribution {
    this.assertSealed();
    const value = this.#backends.get(id);
    if (!value)
      throw new DomainError(
        'RESOURCE_BACKEND_UNAVAILABLE',
        'The configured backend contribution is not registered.',
      );
    return value;
  }
  providerDescriptors() {
    this.assertSealed();
    return [...this.#providers.values()].map(descriptor).map((value) => structuredClone(value));
  }
  backendDescriptors() {
    this.assertSealed();
    return [...this.#backends.values()].map(descriptor).map((value) => structuredClone(value));
  }
  parseConnection(input: unknown): ResourceConnection {
    this.assertSealed();
    const connection = ResourceConnectionSchema.parse(input);
    return { ...connection, config: this.provider(connection.provider).parse(connection.config) };
  }
  parseRuntime(input: unknown): RuntimeDefinition {
    this.assertSealed();
    const runtime = RuntimeDefinitionSchema.parse(input);
    return { ...runtime, config: this.backend(runtime.backend).parse(runtime.config) };
  }
  validateConfiguration<T extends ResourceConfigurationInput>(input: T): T {
    this.assertSealed();
    const value = structuredClone(input);
    value.defaultProfile = ResourceIdSchema.parse(value.defaultProfile);
    value.connections = value.connections.map((connection) => this.parseConnection(connection));
    value.runtimes = value.runtimes.map((runtime) => this.parseRuntime(runtime));
    value.profiles = value.profiles.map((profile) => ResourceProfileSchema.parse(profile));
    for (const list of [value.connections, value.runtimes, value.profiles])
      if (new Set(list.map((item) => item.id)).size !== list.length)
        throw new DomainError('RESOURCE_ID_EXISTS', 'Resource IDs must be unique.');
    const providers = new Map(
      value.connections.map((connection) => [
        connection.id,
        this.provider(connection.provider).describe(connection.config),
      ]),
    );
    const runtimes = new Map<string, { local: boolean }>();
    for (const runtime of value.runtimes) {
      const backend = this.backend(runtime.backend);
      const ids = backend.dependencies(runtime.config);
      if (ids.some((id) => !providers.has(id)))
        throw new DomainError(
          'RESOURCE_DEPENDENCY_UNAVAILABLE',
          'A backend references a missing provider connection.',
        );
      const dependencies = new Map(ids.map((id) => [id, providers.get(id)!]));
      const description = backend.describe(runtime.config, dependencies);
      runtimes.set(runtime.id, {
        local: description.local && ids.every((id) => providers.get(id)!.local),
      });
    }
    if (!value.profiles.some((profile) => profile.id === value.defaultProfile))
      throw new DomainError(
        'RESOURCE_PROFILE_UNAVAILABLE',
        'The default resource profile is missing.',
      );
    for (const profile of value.profiles) {
      const ids = [
        profile.coordinator,
        profile.worker,
        profile.reviewer,
        ...(profile.workerPool || []),
      ];
      if (ids.some((id) => !runtimes.has(id)))
        throw new DomainError(
          'RESOURCE_DEPENDENCY_UNAVAILABLE',
          'A profile references a missing backend instance.',
        );
      if (profile.policy === 'local-only' && ids.some((id) => !runtimes.get(id)!.local))
        throw new DomainError(
          'DATA_POLICY_BLOCKED',
          'A local-only execution profile cannot include remote model runtimes.',
        );
    }
    return value;
  }
}
