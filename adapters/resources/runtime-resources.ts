import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import type { RegisteredRuntime, RuntimeSelection } from '../../core/ports.ts';
import { DomainError } from '../../core/ports.ts';
import { ResourceSelection } from '../../core/resource-selection.ts';
import { projectRoleResourceChoices } from '../../core/operation-catalog.ts';
import { freezeBackendCapabilities } from '../../core/backend-capabilities.ts';
import {
  CapabilityProbeService,
  type ProbeReceipt,
  type ProbeBinding,
} from '../../core/capability-probe.ts';
import {
  ResourceContributionCatalog,
  type ProviderInstance,
  type ProviderDescription,
} from '../../core/resource-contributions.ts';
import type {
  ResourceConnection,
  ResourceSetupInput,
  RuntimeResource,
  RoleResourceChoices,
  ResourceCatalog,
} from '../../protocol/resources.ts';
import type { ResourceConfigurationChange } from '../../protocol/domain.ts';
import { RequestGate } from '../models/http.ts';
import {
  FileResourceConfiguration,
  connectionConfigurationRevision,
  resourceConfigurationRevision,
  ResourceConfigurationSchema,
  type ResourceConfiguration,
} from '../files/resource-configuration.ts';
import { PrivateJSONFiles } from '../files/private-json.ts';
import { loadModelCredentials } from '../files/model-credentials.ts';
import { prepareRuntimeHost, type RuntimeHostOptions } from './runtime-host.ts';
import { registerBuiltinResources } from './contributions/builtins.ts';

export type RuntimeResourcesOptions = RuntimeHostOptions & {
  contributions?: ResourceContributionCatalog;
  /** Hosts may install only their own factories, without first-party backend requirements. */
  builtins?: boolean;
  onConfigurationChange?: (change: ResourceConfigurationChange) => void;
};
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
        )
      : value;
const hash = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');

async function createRuntimeGeneration(
  options: RuntimeResourcesOptions,
  sharedGates = new Map<string, RequestGate>(),
  captured?: ResourceConfiguration,
) {
  const host = prepareRuntimeHost(options);
  const catalog = options.contributions || new ResourceContributionCatalog();
  if (!catalog.sealed && options.builtins !== false)
    registerBuiltinResources(catalog, options, host);
  catalog.seal();
  const configuration = await FileResourceConfiguration.open(host.local, catalog);
  const config = captured || configuration.snapshot();
  const credentials = options.credentials || (await loadModelCredentials(host.local));
  const probes = new PrivateJSONFiles(path.join(host.local, 'resource-probes'));
  const descriptions = new Map<string, ProviderDescription>();
  const capacities = new Map<string, number>();
  for (const connection of config.connections) {
    const description = catalog.provider(connection.provider).describe(connection.config);
    descriptions.set(connection.id, description);
    capacities.set(
      description.capacityKey,
      Math.min(capacities.get(description.capacityKey) ?? Infinity, description.capacity),
    );
  }
  const gates = sharedGates;
  for (const [key, capacity] of capacities) {
    const gate = gates.get(key);
    if (!gate) gates.set(key, new RequestGate(capacity));
  }
  const providers = new Map<string, ProviderInstance>();
  const acquiredProviders = new Set<ProviderInstance>();
  const providerIdentities = new Map<string, string>();
  const runtimes: RegisteredRuntime[] = [];
  const resources: RuntimeResource[] = [];
  const bindings = new Map<string, ProbeBinding>();
  let transferred = false;
  let disposal: Promise<void> | undefined;
  let probeService: CapabilityProbeService | undefined;
  const dispose = () => {
    if (disposal) return disposal;
    disposal = (async () => {
      const failures: unknown[] = [];
      const drain = async (actions: (() => Promise<void> | undefined)[]) => {
        const results = await Promise.allSettled(
          actions.map((action) => Promise.resolve().then(action)),
        );
        failures.push(
          ...results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
        );
      };
      await drain([() => probeService?.dispose()]);
      if (!transferred)
        await drain([...new Set(runtimes)].map((runtime) => () => runtime.dispose()));
      await drain([...acquiredProviders].map((instance) => () => instance.dispose?.()));
      if (failures.length) throw new AggregateError(failures, 'Resource cleanup failed.');
    })();
    return disposal;
  };
  try {
    for (const connection of config.connections) {
      const contribution = catalog.provider(connection.provider);
      const description = descriptions.get(connection.id)!;
      const instance = await contribution.create({
        id: connection.id,
        config: structuredClone(connection.config),
        fetch: options.fetch || fetch,
        credentials,
        gate: gates.get(description.capacityKey)!,
      });
      acquiredProviders.add(instance);
      if (
        [...providers.values()].some(
          (existing) => existing === instance || existing.provider === instance.provider,
        )
      )
        throw new DomainError(
          'INVALID_PROVIDER_INSTANCE',
          'Each connection needs its own provider instance.',
        );
      providers.set(connection.id, instance);
      if (
        instance.provider.id !== connection.id ||
        instance.provider.local !== description.local ||
        !instance.provider.revision ||
        typeof instance.provider.complete !== 'function' ||
        (description.modelListing && typeof instance.listModels !== 'function')
      )
        throw new DomainError(
          'INVALID_PROVIDER_INSTANCE',
          'Provider identity or locality differs from its registered configuration.',
        );
      providerIdentities.set(
        connection.id,
        hash([
          contribution.id,
          contribution.revision,
          connection.config,
          instance.provider.id,
          instance.provider.revision,
          instance.provider.local,
          capacities.get(description.capacityKey),
        ]),
      );
    }
    for (const definition of config.runtimes) {
      const contribution = catalog.backend(definition.backend);
      const dependencies = contribution.dependencies(definition.config).sort();
      const dependencyDescriptions = new Map(dependencies.map((id) => [id, descriptions.get(id)!]));
      const instance = await contribution.create({
        id: definition.id,
        config: structuredClone(definition.config),
        providers: new Map(dependencies.map((id) => [id, providers.get(id)!])),
        providerDescriptions: dependencyDescriptions,
      });
      const runtime = instance.runtime;
      if (runtimes.includes(runtime))
        throw new DomainError(
          'INVALID_RUNTIME_INSTANCE',
          'Each execution resource needs its own backend instance.',
        );
      runtimes.push(runtime);
      const capabilities = freezeBackendCapabilities(runtime.capabilities);
      if (
        runtime.id !== definition.id ||
        !instance.revision ||
        instance.local !==
          (contribution.describe(definition.config, dependencyDescriptions).local &&
            dependencies.every((id) => descriptions.get(id)!.local)) ||
        (instance.providerId !== undefined && !dependencies.includes(instance.providerId)) ||
        (capabilities.structuredTurns && typeof runtime.turn !== 'function') ||
        (capabilities.resumeSessions && typeof runtime.resume !== 'function')
      )
        throw new DomainError(
          'INVALID_RUNTIME_INSTANCE',
          'Backend mechanics or identity differ from the registered configuration.',
        );
      if (
        instance.probe &&
        (!dependencies.some((id) => providers.get(id)!.provider === instance.probe!.provider) ||
          typeof instance.probe.model !== 'string' ||
          !instance.probe.model ||
          !Number.isSafeInteger(instance.probe.contextTokens) ||
          instance.probe.contextTokens < 1 ||
          !Number.isSafeInteger(instance.probe.maxOutputTokens) ||
          instance.probe.maxOutputTokens < 1)
      )
        throw new DomainError(
          'INVALID_RUNTIME_INSTANCE',
          'A diagnostic must use a declared provider dependency and explicit token settings.',
        );
      const configurationRevision = hash([
        contribution.id,
        contribution.revision,
        definition,
        dependencies.map((id) => [id, providerIdentities.get(id)]),
        instance.revision,
        capabilities,
      ]);
      const resource: RuntimeResource = {
        id: definition.id,
        backendId: contribution.id,
        ...(instance.providerId ? { providerId: instance.providerId } : {}),
        ...(instance.model ? { model: instance.model } : {}),
        local: instance.local,
        capabilities,
        configurationRevision,
      };
      resources.push(resource);
      if (instance.probe) bindings.set(definition.id, { ...instance.probe, configurationRevision });
    }
    const activeSelection = new ResourceSelection({
      projects: options.projects,
      profiles: config.profiles,
      runtimes: resources,
      defaultProfile: () => configuration.snapshot().defaultProfile,
    });
    // Editing a connection never retargets an active provider or a frozen run.
    const pending = (connectionId: string) => {
      const saved = configuration.snapshot().connections.find((item) => item.id === connectionId);
      const active = config.connections.find((item) => item.id === connectionId);
      return (
        !!saved &&
        (!active ||
          connectionConfigurationRevision(saved) !== connectionConfigurationRevision(active))
      );
    };
    const assertActive = (connectionId: string) => {
      if (pending(connectionId))
        throw new DomainError(
          'CONNECTION_RESTART_REQUIRED',
          'Restart the service to apply this model connection before starting new work.',
        );
    };
    const pendingRuntime = (runtimeId: string) => {
      const saved = configuration.snapshot().runtimes.find((item) => item.id === runtimeId);
      const active = config.runtimes.find((item) => item.id === runtimeId);
      return (
        !!saved &&
        (!active ||
          hash(saved) !== hash(active) ||
          catalog.backend(saved.backend).dependencies(saved.config).some(pending))
      );
    };
    const profileRuntimeIds = (profile: (typeof config.profiles)[number]) => [
      profile.coordinator,
      profile.worker,
      profile.reviewer,
      ...(profile.workerPool || []),
    ];
    const pendingProfile = (profileId: string) => {
      const saved = configuration.snapshot().profiles.find((item) => item.id === profileId);
      const active = config.profiles.find((item) => item.id === profileId);
      return (
        !!saved &&
        (!active || hash(saved) !== hash(active) || profileRuntimeIds(saved).some(pendingRuntime))
      );
    };
    const assertActiveProfile = (profileId: string) => {
      const active = config.profiles.find((item) => item.id === profileId);
      const saved = configuration.snapshot().profiles.find((item) => item.id === profileId);
      if (!saved)
        throw new DomainError('RESOURCE_PROFILE_UNAVAILABLE', 'Resource profile unavailable.');
      if (!active || hash(saved) !== hash(active))
        throw new DomainError(
          'RESOURCE_PROFILE_RESTART_REQUIRED',
          'Restart the service to activate this execution profile before selecting it.',
        );
      if (profileRuntimeIds(active).some(pendingRuntime))
        throw new DomainError(
          'CONNECTION_RESTART_REQUIRED',
          "Restart the service to apply this profile's resource connections before selecting it.",
        );
    };
    const selection: RuntimeSelection = {
      forProject(projectId) {
        const selected = activeSelection.forProject(projectId);
        for (const resource of [
          selected.coordinator,
          selected.worker,
          selected.reviewer,
          ...(selected.workerPool || []),
        ])
          if (pendingRuntime(resource.id))
            throw new DomainError(
              'CONNECTION_RESTART_REQUIRED',
              'Restart the service to apply this execution resource before starting new work.',
            );
        return selected;
      },
    };
    const roleChoicesFor = (
      input: Parameters<typeof projectRoleResourceChoices>[0],
    ): RoleResourceChoices[] => {
      return projectRoleResourceChoices(input).map((entry) => ({
        ...entry,
        choices: entry.choices.map((choice) =>
          pendingRuntime(choice.resource.id)
            ? {
                ...choice,
                eligible: false,
                reason: 'Restart the service to activate this runtime configuration.',
              }
            : choice,
        ),
      }));
    };
    const selectionMessages: Record<string, string> = {
      RESOURCE_PROFILE_REQUIRED:
        'Configure and select an execution profile before starting model work.',
      RESOURCE_PROFILE_UNAVAILABLE:
        'The selected execution profile is unavailable. Select an active profile.',
      INVALID_RESOURCE_POOL: 'The selected execution profile needs a valid worker pool.',
      RUNTIME_UNAVAILABLE: 'The selected execution profile uses an unavailable runtime.',
      DATA_POLICY_BLOCKED: 'The selected execution profile conflicts with its data policy.',
    };
    const selectionView = (
      projectId?: string,
    ): Pick<ResourceCatalog, 'selected' | 'roleChoices' | 'selectionIssue'> => {
      try {
        const selected = projectId
          ? activeSelection.forProject(projectId)
          : activeSelection.forMachine();
        const snapshot = projectId ? options.projects.get(projectId).snapshot() : undefined;
        return {
          selected,
          roleChoices: roleChoicesFor({
            profile: snapshot?.profile,
            roles: snapshot?.roles || [],
            resources: selected,
            strict: snapshot?.profile?.scope?.mode === 'strict',
          }),
        };
      } catch (error) {
        if (!(error instanceof DomainError) || !Object.hasOwn(selectionMessages, error.code))
          throw error;
        return {
          roleChoices: [],
          selectionIssue: { code: error.code, message: selectionMessages[error.code] },
        };
      }
    };
    const list = async (projectId?: string) => ({
      defaultProfile: configuration.snapshot().defaultProfile,
      providers: catalog.providerDescriptors(),
      backends: catalog.backendDescriptors(),
      probeRuntimeIds: [...bindings.keys()],
      profiles: structuredClone(config.profiles),
      runtimes: structuredClone(resources),
      configurationRevision: resourceConfigurationRevision(configuration.snapshot()),
      configured: {
        runtimes: configuration.snapshot().runtimes.map((definition) => ({
          definition,
          restartRequired: pendingRuntime(definition.id),
        })),
        profiles: configuration.snapshot().profiles.map((profile) => ({
          profile,
          restartRequired: pendingProfile(profile.id),
        })),
      },
      connections: configuration.snapshot().connections.map((connection) => {
        const description = catalog.provider(connection.provider).describe(connection.config);
        return {
          ...connection,
          revision: connectionConfigurationRevision(connection),
          credentialConfigured: description.credentialReferences.every((reference) => {
            try {
              return !!credentials(reference);
            } catch {
              return false;
            }
          }),
          local: description.local,
          modelListing: description.modelListing,
          ...(description.endpoint ? { endpoint: description.endpoint } : {}),
          ...(descriptions.get(connection.id)?.endpoint
            ? { activeEndpoint: descriptions.get(connection.id)!.endpoint }
            : {}),
          restartRequired: pending(connection.id),
        };
      }),
      ...selectionView(projectId),
      probes: (
        await Promise.all(
          resources.map(async (resource) => {
            if (pendingRuntime(resource.id)) return undefined;
            const result = (await probes.load(resource.id)) as
              | { configurationRevision?: string }
              | undefined;
            return result?.configurationRevision === resource.configurationRevision
              ? result
              : undefined;
          }),
        )
      ).filter(Boolean),
    });
    const models = async (connectionId: string) => {
      // Admit against all writes already submitted when this request arrived, without holding
      // the metadata mutation queue for the duration of the HTTP request.
      const priorMutations = mutationTail;
      await priorMutations;
      assertActive(connectionId);
      const provider = providers.get(connectionId);
      if (!provider)
        throw new DomainError('CONNECTION_UNAVAILABLE', 'Model connection unavailable.');
      if (!provider.listModels)
        throw new DomainError(
          'MODEL_LISTING_UNSUPPORTED',
          'This provider does not support model discovery.',
        );
      const connection = config.connections.find((item) => item.id === connectionId)!;
      const description = descriptions.get(connectionId)!;
      return (await provider.listModels(AbortSignal.timeout(15000))).map((model) => ({
        ...model,
        templates: catalog.backendDescriptors().flatMap((descriptor) => {
          const template = catalog
            .backend(descriptor.id)
            .template?.(connection, model.id, description);
          return template ? [{ ...template, backend: descriptor.id }] : [];
        }),
      }));
    };
    probeService = new CapabilityProbeService({
      binding: (runtimeId) => {
        const binding = bindings.get(runtimeId);
        if (!binding)
          throw new DomainError(
            'PROBE_UNSUPPORTED',
            'This backend does not provide a raw-model capability diagnostic.',
          );
        return binding;
      },
      store: {
        loadRequest: async (id) => (await probes.load('request-' + id)) as ProbeReceipt | undefined,
        saveRequest: (receipt) => probes.save('request-' + receipt.id, receipt),
        saveResult: (result) => probes.save(result.runtimeId, result),
      },
      now: () => new Date().toISOString(),
      id: randomUUID,
    });
    const probe = async (runtimeId: string, meta: { id: string; fingerprint: string }) => {
      const priorMutations = mutationTail;
      await priorMutations;
      const runtime = config.runtimes.find((item) => item.id === runtimeId);
      const saved = configuration.snapshot().runtimes.find((item) => item.id === runtimeId);
      if (saved && (!runtime || hash(saved) !== hash(runtime)))
        throw new DomainError(
          'RESOURCE_RUNTIME_RESTART_REQUIRED',
          'Restart the service to activate this model runtime before checking it.',
        );
      if (!runtime || !bindings.has(runtimeId))
        throw new DomainError(
          'PROBE_UNSUPPORTED',
          'This backend does not provide a raw-model capability diagnostic.',
        );
      for (const id of catalog.backend(runtime.backend).dependencies(runtime.config))
        assertActive(id);
      return probeService!.probe(meta.id, meta.fingerprint, runtimeId);
    };
    // Serialize public mutations so lifecycle guards observe all earlier acknowledged writes,
    // including before an idempotent selection receipt is replayed. File persistence stays authoritative.
    let mutationTail: Promise<unknown> = Promise.resolve();
    const mutate = <T>(
      action: () => Promise<T>,
      appliesTo: ResourceConfigurationChange['appliesTo'],
    ) => {
      const next = mutationTail.then(async () => {
        const before = resourceConfigurationRevision(configuration.snapshot());
        const result = await action();
        const revision = resourceConfigurationRevision(configuration.snapshot());
        if (revision !== before) {
          try {
            void Promise.resolve(
              options.onConfigurationChange?.({ topic: 'resources', revision, appliesTo }),
            ).catch(() => {});
          } catch {
            // Notification failures never invalidate an already persisted command receipt.
          }
        }
        return result;
      });
      mutationTail = next.catch(() => {});
      return next;
    };
    const saveConnection = (
      connection: ResourceConnection,
      expectedRevision: string | null,
      meta: { id: string; fingerprint: string },
    ) => {
      const definition = structuredClone(connection),
        { id, fingerprint } = meta;
      return mutate(
        () => configuration.save(id, fingerprint, definition, expectedRevision),
        'service-restart',
      );
    };
    const saveSetup = (input: ResourceSetupInput, meta: { id: string; fingerprint: string }) => {
      const setup = structuredClone(input),
        { id, fingerprint } = meta;
      return mutate(() => configuration.saveSetup(id, fingerprint, setup), 'service-restart');
    };
    const useProfile = (profileId: string, meta: { id: string; fingerprint: string }) => {
      const { id, fingerprint } = meta;
      return mutate(() => {
        assertActiveProfile(profileId);
        return configuration.use(id, fingerprint, profileId);
      }, 'new-runs');
    };
    if (!captured) for (const [key, capacity] of capacities) gates.get(key)!.setCapacity(capacity);
    return {
      configuration,
      runtimes,
      resources,
      selection,
      list,
      models,
      probe,
      saveConnection,
      saveSetup,
      useProfile,
      takeRuntimes: () => {
        if (transferred || disposal)
          throw new DomainError(
            'RESOURCE_OWNERSHIP_TRANSFERRED',
            'Backend ownership has already been transferred or closed.',
          );
        transferred = true;
        return [...runtimes];
      },
      dispose,
    };
  } catch (error) {
    try {
      await dispose();
    } catch {
      /* Preserve the startup error. */
    }
    throw error;
  }
}

/** New work uses the latest settings; frozen sessions retain their original backend generation. */
export async function createRuntimeResources(options: RuntimeResourcesOptions) {
  const gates = new Map<string, RequestGate>();
  const generationOptions = { ...options, onConfigurationChange: undefined };
  const generations = new Set<Awaited<ReturnType<typeof createRuntimeGeneration>>>();
  const versions = new Map<string, { runtime: RegisteredRuntime; resource: RuntimeResource }>();
  const key = (resource: RuntimeResource) =>
    JSON.stringify([resource.id, resource.configurationRevision]);
  const archives = new PrivateJSONFiles(path.join(options.directory, 'local/resource-generations'));
  const definitionKey = (config: ResourceConfiguration) =>
    hash([config.connections, config.runtimes, config.profiles]);
  let current = await createRuntimeGeneration(generationOptions, gates);
  const initial = current;
  const resources = [...current.resources];
  let activated = definitionKey(current.configuration.snapshot());
  let closed = false;
  let disposal: Promise<void> | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  const retain = (generation: typeof current) => {
    generations.add(generation);
    for (const resource of generation.resources) {
      const runtime = generation.runtimes.find((runtime) => runtime.id === resource.id)!;
      if (!versions.has(key(resource)))
        versions.set(key(resource), { runtime, resource: structuredClone(resource) });
    }
  };
  retain(current);
  try {
    const directory = path.join(options.directory, 'local/resource-generations');
    const names = await fs.readdir(directory).catch((error) => {
      if (error.code === 'ENOENT') return [] as string[];
      throw error;
    });
    for (const name of names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
      const saved = ResourceConfigurationSchema.parse(await archives.load(name.slice(0, -5)));
      if (definitionKey(saved) === activated) continue;
      try {
        retain(await createRuntimeGeneration(generationOptions, gates, saved));
      } catch (error) {
        // Retired extensions do not block current work. Their frozen routes remain unavailable.
        if (
          !(error instanceof DomainError) ||
          ![
            'RESOURCE_PROVIDER_UNAVAILABLE',
            'RESOURCE_BACKEND_UNAVAILABLE',
            'MODEL_UNSUPPORTED',
          ].includes(error.code)
        )
          throw error;
      }
    }
  } catch (error) {
    await Promise.allSettled([...generations].map((generation) => generation.dispose()));
    throw error;
  }
  const assertOpen = () => {
    if (closed) throw new DomainError('RUNTIME_CLOSED', 'The resource service stopped.');
  };
  const mutate = <T>(operation: (generation: typeof current) => Promise<T>, rebuild: boolean) => {
    const result = tail.then(async () => {
      assertOpen();
      const before = resourceConfigurationRevision(current.configuration.snapshot());
      if (rebuild) {
        const config = current.configuration.snapshot();
        await archives.save(definitionKey(config), config);
      }
      const receipt = await operation(current);
      const saved = current.configuration.snapshot();
      const activating = definitionKey(saved) !== activated;
      if (activating) {
        const replacement = await createRuntimeGeneration(generationOptions, gates);
        retain(replacement);
        current = replacement;
        resources.splice(0, resources.length, ...replacement.resources);
        activated = definitionKey(saved);
      }
      const revision = resourceConfigurationRevision(saved);
      if (revision !== before || activating) {
        try {
          void Promise.resolve(
            options.onConfigurationChange?.({
              topic: 'resources',
              revision,
              appliesTo: 'new-runs',
            }),
          ).catch(() => {});
        } catch {
          /* Persistence and activation already succeeded. */
        }
      }
      return receipt && typeof receipt === 'object' && 'appliesTo' in receipt
        ? { ...receipt, appliesTo: 'new-runs' as const }
        : receipt;
    });
    tail = result.catch(() => {});
    return result;
  };
  return {
    get configuration() {
      return current.configuration;
    },
    get runtimes() {
      return current.runtimes;
    },
    resources,
    resolveRuntime: (resource: RuntimeResource) => {
      const found = versions.get(key(resource));
      return found && hash(found.resource) === hash(resource) ? found.runtime : undefined;
    },
    selection: {
      forProject(projectId: string) {
        assertOpen();
        return current.selection.forProject(projectId);
      },
    },
    async list(projectId?: string) {
      await tail;
      assertOpen();
      return current.list(projectId);
    },
    async models(connectionId: string) {
      await tail;
      assertOpen();
      return current.models(connectionId);
    },
    async probe(runtimeId: string, meta: { id: string; fingerprint: string }) {
      await tail;
      assertOpen();
      return current.probe(runtimeId, meta);
    },
    saveConnection: (...args: Parameters<typeof current.saveConnection>) =>
      mutate((generation) => generation.saveConnection(...args), true),
    saveSetup: (...args: Parameters<typeof current.saveSetup>) =>
      mutate((generation) => generation.saveSetup(...args), true),
    useProfile: (...args: Parameters<typeof current.useProfile>) =>
      mutate((generation) => generation.useProfile(...args), false),
    takeRuntimes: () => initial.takeRuntimes(),
    dispose() {
      if (disposal) return disposal;
      closed = true;
      disposal = (async () => {
        await tail;
        const results = await Promise.allSettled(
          [...generations].map((generation) => generation.dispose()),
        );
        const failures = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        );
        if (failures.length) throw new AggregateError(failures, 'Resource cleanup failed.');
      })();
      return disposal;
    },
  };
}
