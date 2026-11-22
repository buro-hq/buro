import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { RegisteredRuntime, RuntimeSelection } from '../../core/ports.ts';
import { DomainError } from '../../core/ports.ts';
import { ResourceSelection } from '../../core/resource-selection.ts';
import { roleResourceContext, roleResourceEligibility } from '../../core/role-routing.ts';
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
} from '../../protocol/resources.ts';
import { RequestGate } from '../models/http.ts';
import {
  FileResourceConfiguration,
  connectionConfigurationRevision,
  resourceConfigurationRevision,
} from '../files/resource-configuration.ts';
import { PrivateJSONFiles } from '../files/private-json.ts';
import { loadModelCredentials } from '../files/model-credentials.ts';
import { prepareRuntimeHost, type RuntimeHostOptions } from './runtime-host.ts';
import { registerBuiltinResources } from './contributions/builtins.ts';

export type RuntimeResourcesOptions = RuntimeHostOptions & {
  contributions?: ResourceContributionCatalog;
  /** Hosts may install only their own factories, without first-party backend requirements. */
  builtins?: boolean;
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

export async function createRuntimeResources(options: RuntimeResourcesOptions) {
  const host = prepareRuntimeHost(options);
  const catalog = options.contributions || new ResourceContributionCatalog();
  if (options.builtins !== false) registerBuiltinResources(catalog, options, host);
  catalog.seal();
  const configuration = await FileResourceConfiguration.open(host.local, catalog);
  const config = configuration.snapshot();
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
  const gates = new Map([...capacities].map(([key, capacity]) => [key, new RequestGate(capacity)]));
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
    const projectRoleChoices = (projectId: string): RoleResourceChoices[] => {
      const snapshot = options.projects.get(projectId).snapshot();
      const selected = activeSelection.forProject(projectId);
      const strict = snapshot.profile?.scope?.mode === 'strict';
      return [
        ...(snapshot.roles || []).map((role) => ({ id: role.id, version: role.version })),
        ...['coordinator', 'reviewer', 'local_preview', 'delivery_pr', 'production_delivery']
          .filter((id) => !(snapshot.roles || []).some((role) => role.id === id))
          .map((id) => ({ id, version: undefined })),
        { id: '*', version: undefined },
      ].map((role) => {
        const context = roleResourceContext(role.id, strict);
        return {
          roleId: role.id,
          ...(role.version !== undefined ? { roleVersion: role.version } : {}),
          purpose: context.purpose,
          requirements: context.requirements || {},
          choices: roleResourceEligibility(selected, context.requirements, context.purpose).map(
            (choice) =>
              pendingRuntime(choice.resource.id)
                ? {
                    ...choice,
                    eligible: false,
                    reason: 'Restart the service to activate this runtime configuration.',
                  }
                : choice,
          ),
        };
      });
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
      ...(projectId
        ? {
            selected: activeSelection.forProject(projectId),
            roleChoices: projectRoleChoices(projectId),
          }
        : {}),
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
    const mutate = <T>(action: () => Promise<T>) => {
      const next = mutationTail.then(action);
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
      return mutate(() => configuration.save(id, fingerprint, definition, expectedRevision));
    };
    const saveSetup = (input: ResourceSetupInput, meta: { id: string; fingerprint: string }) => {
      const setup = structuredClone(input),
        { id, fingerprint } = meta;
      return mutate(() => configuration.saveSetup(id, fingerprint, setup));
    };
    const useProfile = (profileId: string, meta: { id: string; fingerprint: string }) => {
      const { id, fingerprint } = meta;
      return mutate(() => {
        assertActiveProfile(profileId);
        return configuration.use(id, fingerprint, profileId);
      });
    };
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
