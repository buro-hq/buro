import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { RegisteredRuntime, ProjectRegistry, RuntimeSelection } from '../../core/ports.ts';
import { DomainError } from '../../core/ports.ts';
import { ManagedAgentRuntime } from '../../core/managed-runtime.ts';
import { conservativeRequestPolicy, type ManagedRequestPolicy } from '../../core/request-policy.ts';
import { ResourceSelection } from '../../core/resource-selection.ts';
import { roleResourceContext, roleResourceEligibility } from '../../core/role-routing.ts';
import type { RoleResourceChoices } from '../../protocol/resources.ts';
import { CapabilityProbeService, type ProbeReceipt } from '../../core/capability-probe.ts';
import type {
  ResourceConnection,
  ResourceSetupInput,
  RuntimeResource,
} from '../../protocol/resources.ts';
import { CodexRuntime } from '../codex/runtime.ts';
import { OllamaProvider } from '../models/ollama.ts';
import { DeepSeekProvider } from '../models/deepseek.ts';
import { RequestGate, endpointURL } from '../models/http.ts';
import { FileManagedSessions } from '../files/managed-sessions.ts';
import {
  FileResourceConfiguration,
  connectionConfigurationRevision,
  resourceConfigurationRevision,
} from '../files/resource-configuration.ts';
import { PrivateJSONFiles } from '../files/private-json.ts';
import { loadModelCredentials } from '../files/model-credentials.ts';
import { RepositoryTools } from '../tools/repository-tools.ts';
import type { EnvironmentExecutors } from '../environments/executors.ts';
import { ProjectRunBudgets } from '../files/project-run-budgets.ts';
import type { ManagedRunBudgetPort } from '../../core/run-budget.ts';
import type { CheckPort, WorkspacePort } from '../../core/execution-ports.ts';
import {
  WORKER_STEP_CHECK_REVISION,
  type WorkerStepCheckPort,
} from '../../core/worker-step-checks.ts';
import {
  boundedWorkSegmentPolicy,
  validateSegmentLimits,
  type SegmentEvidencePort,
  type WorkSegmentPolicy,
} from '../../core/work-segments.ts';
import { RepositorySegmentEvidence } from '../tools/segment-evidence.ts';
import { WorkerStepChecks } from '../checks/worker-step-checks.ts';

export async function createRuntimeResources(options: {
  directory: string;
  projects: ProjectRegistry;
  executors: EnvironmentExecutors;
  fetch?: typeof fetch;
  codex?: {
    executable?: string;
    args?: string[];
    model?: string;
    reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
    networkAccess?: boolean;
    onEvent?: (event: { method: string; params: unknown }) => void;
  };
  credentials?: (reference: string) => string | undefined;
  requestPolicy?: ManagedRequestPolicy;
  budgets?: ManagedRunBudgetPort;
  workspaces?: Pick<WorkspacePort, 'changes'>;
  segmentPolicy?: WorkSegmentPolicy;
  segmentEvidence?: SegmentEvidencePort;
  checks?: CheckPort;
  workerStepChecks?: WorkerStepCheckPort;
}) {
  const local = path.join(options.directory, 'local');
  options.executors.protectPrivatePaths([local]);
  const configuration = await FileResourceConfiguration.open(local),
    config = configuration.snapshot();
  const credentials = options.credentials || (await loadModelCredentials(local));
  const sessions = new FileManagedSessions(path.join(local, 'managed-sessions'));
  const probes = new PrivateJSONFiles(path.join(local, 'resource-probes'));
  const tools = new RepositoryTools(options.executors);
  const budgets = options.budgets || new ProjectRunBudgets(options.projects);
  const requestPolicy = options.requestPolicy || conservativeRequestPolicy;
  const segmentEvidence =
    options.segmentEvidence ||
    (options.workspaces ? new RepositorySegmentEvidence(options.workspaces) : undefined);
  const segmentPolicy =
    options.segmentPolicy || (segmentEvidence ? boundedWorkSegmentPolicy : undefined);
  if (segmentPolicy) {
    validateSegmentLimits(segmentPolicy.limits);
    if (!segmentEvidence || segmentPolicy.revision !== segmentPolicy.limits.revision)
      throw new DomainError('INVALID_SEGMENT_POLICY', 'The work segment policy is incomplete.');
  }
  const workerStepChecks =
    options.workerStepChecks ||
    (segmentEvidence && options.checks
      ? new WorkerStepChecks({
          projects: options.projects,
          checks: options.checks,
          evidence: segmentEvidence,
          executors: options.executors,
        })
      : undefined);
  if (
    typeof requestPolicy.revision !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,100}$/.test(requestPolicy.revision) ||
    typeof requestPolicy.prepare !== 'function'
  )
    throw new DomainError('INVALID_REQUEST_POLICY', 'The request policy needs a stable revision.');
  const connectionKey = (connection: (typeof config.connections)[number]) =>
    JSON.stringify([connection.kind, endpointURL(connection.endpoint).href]);
  const capacities = new Map<string, number>();
  for (const connection of config.connections)
    capacities.set(
      connectionKey(connection),
      Math.min(capacities.get(connectionKey(connection)) || Infinity, connection.capacity),
    );
  const gates = new Map([...capacities].map(([key, capacity]) => [key, new RequestGate(capacity)]));
  const providers = new Map<string, OllamaProvider | DeepSeekProvider>();
  for (const connection of config.connections) {
    const common = {
      id: connection.id,
      endpoint: connection.endpoint,
      fetch: options.fetch,
      gate: gates.get(connectionKey(connection))!,
    };
    providers.set(
      connection.id,
      connection.kind === 'ollama'
        ? new OllamaProvider({ ...common, think: connection.think, trust: connection.trust })
        : new DeepSeekProvider({
            ...common,
            apiKey: () => credentials(connection.apiKeyEnv),
            thinking: connection.thinking,
          }),
    );
  }
  const runtimes: RegisteredRuntime[] = [],
    resources: RuntimeResource[] = [];
  for (const runtime of config.runtimes) {
    if (runtime.client === 'codex') {
      const nativeOptions = {
        ...options.codex,
        model: runtime.model ?? options.codex?.model,
        reasoningEffort: runtime.reasoningEffort ?? options.codex?.reasoningEffort,
      };
      const adapter = new CodexRuntime({
        ...nativeOptions,
        id: runtime.id,
        projects: options.projects,
        executors: options.executors,
      });
      runtimes.push(adapter);
      resources.push({
        id: runtime.id,
        client: 'codex',
        ...(nativeOptions.model ? { model: nativeOptions.model } : {}),
        local: false,
        capabilities: structuredClone(adapter.capabilities),
        configurationRevision: createHash('sha256')
          .update(
            JSON.stringify([
              'native-backend-instance-v2',
              runtime.id,
              nativeOptions,
              adapter.capabilities,
            ]),
          )
          .digest('hex'),
      });
    } else {
      const provider = providers.get(runtime.connectionId)!;
      const { PiAgentLoopRunner } = await import('../agents/pi-loop.ts');
      const adapter = new ManagedAgentRuntime({
        loopRunner: new PiAgentLoopRunner(),
        id: runtime.id,
        model: runtime.model,
        provider,
        sessions,
        tools,
        projects: options.projects,
        idGenerator: randomUUID,
        limits: runtime.limits,
        requestPolicy,
        budgets,
        segmentPolicy,
        segmentEvidence,
        workerStepChecks,
      });
      runtimes.push(adapter);
      resources.push({
        id: runtime.id,
        client: 'managed',
        providerId: provider.id,
        model: runtime.model,
        local: provider.local && !/(?:[:_-]cloud)(?:$|:)/i.test(runtime.model),
        capabilities: structuredClone(adapter.capabilities),
        configurationRevision: createHash('sha256')
          .update(
            JSON.stringify([
              runtime.id,
              adapter.capabilities,
              provider.revision,
              runtime.model,
              runtime.limits,
              requestPolicy.revision,
              ...(segmentPolicy ? [[segmentPolicy.revision, segmentPolicy.limits]] : []),
              ...(workerStepChecks ? [WORKER_STEP_CHECK_REVISION] : []),
            ]),
          )
          .digest('hex'),
      });
    }
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
        JSON.stringify(saved) !== JSON.stringify(active) ||
        (saved.client === 'managed' && pending(saved.connectionId)))
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
      (!active ||
        JSON.stringify(saved) !== JSON.stringify(active) ||
        profileRuntimeIds(saved).some(pendingRuntime))
    );
  };
  const assertActiveProfile = (profileId: string) => {
    const active = config.profiles.find((item) => item.id === profileId);
    const saved = configuration.snapshot().profiles.find((item) => item.id === profileId);
    if (!saved)
      throw new DomainError('RESOURCE_PROFILE_UNAVAILABLE', 'Resource profile unavailable.');
    if (!active || JSON.stringify(saved) !== JSON.stringify(active))
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
    probeRuntimeIds: config.runtimes
      .filter((runtime) => runtime.client === 'managed' && providers.has(runtime.connectionId))
      .map((runtime) => runtime.id),
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
    connections: configuration.snapshot().connections.map((connection) => ({
      ...connection,
      revision: connectionConfigurationRevision(connection),
      credentialConfigured: connection.kind !== 'deepseek' || !!credentials(connection.apiKeyEnv),
      activeEndpoint: config.connections.find((item) => item.id === connection.id)?.endpoint,
      restartRequired: pending(connection.id),
    })),
    ...(projectId
      ? {
          selected: activeSelection.forProject(projectId),
          roleChoices: projectRoleChoices(projectId),
        }
      : {}),
    probes: (
      await Promise.all(
        resources.map(async (resource) => {
          if (resource.providerId && pending(resource.providerId)) return undefined;
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
    if (!provider) throw new DomainError('CONNECTION_UNAVAILABLE', 'Model connection unavailable.');
    return provider.listModels(AbortSignal.timeout(15000));
  };
  const probeService = new CapabilityProbeService({
    binding: (runtimeId) => {
      const runtime = config.runtimes.find((item) => item.id === runtimeId);
      const resource = resources.find((item) => item.id === runtimeId);
      if (!runtime || runtime.client !== 'managed' || !resource)
        throw new DomainError(
          'PROBE_UNSUPPORTED',
          'Select a managed model runtime for the capability probe.',
        );
      return {
        provider: providers.get(runtime.connectionId)!,
        model: runtime.model,
        configurationRevision: resource.configurationRevision,
        contextTokens: runtime.limits.contextTokens,
        maxOutputTokens: runtime.limits.maxOutputTokens,
      };
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
    if (saved && (!runtime || JSON.stringify(saved) !== JSON.stringify(runtime)))
      throw new DomainError(
        'RESOURCE_RUNTIME_RESTART_REQUIRED',
        'Restart the service to activate this model runtime before checking it.',
      );
    if (!runtime || runtime.client !== 'managed')
      throw new DomainError(
        'PROBE_UNSUPPORTED',
        'Select an active managed model runtime for the capability probe.',
      );
    assertActive(runtime.connectionId);
    return probeService.probe(meta.id, meta.fingerprint, runtimeId);
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
    dispose: () => probeService.dispose(),
  };
}
