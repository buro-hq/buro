import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AgentRuntime, ProjectRegistry } from '../../core/ports.ts';
import { DomainError } from '../../core/ports.ts';
import { ManagedAgentRuntime } from '../../core/managed-runtime.ts';
import { conservativeRequestPolicy, type ManagedRequestPolicy } from '../../core/request-policy.ts';
import { ResourceSelection } from '../../core/resource-selection.ts';
import { CapabilityProbeService, type ProbeReceipt } from '../../core/capability-probe.ts';
import type { RuntimeResource } from '../../protocol/resources.ts';
import { CodexRuntime } from '../codex/runtime.ts';
import { OllamaProvider } from '../models/ollama.ts';
import { DeepSeekProvider } from '../models/deepseek.ts';
import { RequestGate, endpointURL } from '../models/http.ts';
import { FileManagedSessions } from '../files/managed-sessions.ts';
import { FileResourceConfiguration } from '../files/resource-configuration.ts';
import { PrivateJSONFiles } from '../files/private-json.ts';
import { loadModelCredentials } from '../files/model-credentials.ts';
import { RepositoryTools } from '../tools/repository-tools.ts';
import type { EnvironmentExecutors } from '../environments/executors.ts';
import { ProjectRunBudgets } from '../files/project-run-budgets.ts';
import type { ManagedRunBudgetPort } from '../../core/run-budget.ts';

export async function createRuntimeResources(options: {
  directory: string;
  projects: ProjectRegistry;
  executors: EnvironmentExecutors;
  fetch?: typeof fetch;
  codex?: { executable?: string; args?: string[] };
  credentials?: (reference: string) => string | undefined;
  requestPolicy?: ManagedRequestPolicy;
  budgets?: ManagedRunBudgetPort;
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
        ? new OllamaProvider({ ...common, think: connection.think })
        : new DeepSeekProvider({
            ...common,
            apiKey: () => credentials(connection.apiKeyEnv),
            thinking: connection.thinking,
          }),
    );
  }
  const runtimes: AgentRuntime[] = [],
    resources: RuntimeResource[] = [];
  for (const runtime of config.runtimes) {
    if (runtime.client === 'codex') {
      runtimes.push(
        new CodexRuntime({
          projects: options.projects,
          executors: options.executors,
          ...options.codex,
        }),
      );
      resources.push({
        id: runtime.id,
        client: 'codex',
        local: false,
        configurationRevision: createHash('sha256')
          .update(JSON.stringify(['codex-buro-dispatch-v1', options.codex || {}]))
          .digest('hex'),
      });
    } else {
      const provider = providers.get(runtime.connectionId)!;
      runtimes.push(
        new ManagedAgentRuntime({
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
        }),
      );
      resources.push({
        id: runtime.id,
        client: 'managed',
        providerId: provider.id,
        model: runtime.model,
        local: provider.local && !/(?:[:_-]cloud)(?:$|:)/i.test(runtime.model),
        configurationRevision: createHash('sha256')
          .update(
            JSON.stringify([
              provider.revision,
              runtime.model,
              runtime.limits,
              requestPolicy.revision,
            ]),
          )
          .digest('hex'),
      });
    }
  }
  const selection = new ResourceSelection({
    projects: options.projects,
    profiles: config.profiles,
    runtimes: resources,
    defaultProfile: () => configuration.snapshot().defaultProfile,
  });
  const list = async (projectId?: string) => ({
    defaultProfile: configuration.snapshot().defaultProfile,
    profiles: config.profiles,
    runtimes: resources,
    connections: config.connections.map((connection) => ({
      id: connection.id,
      kind: connection.kind,
      endpoint: connection.endpoint,
      ...(connection.kind === 'deepseek'
        ? {
            credentialConfigured: !!credentials(connection.apiKeyEnv),
            apiKeyEnv: connection.apiKeyEnv,
          }
        : {}),
    })),
    ...(projectId ? { selected: selection.forProject(projectId) } : {}),
    probes: (
      await Promise.all(
        resources.map(async (resource) => {
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
  const probe = (runtimeId: string, meta: { id: string; fingerprint: string }) =>
    probeService.probe(meta.id, meta.fingerprint, runtimeId);
  return {
    configuration,
    runtimes,
    resources,
    selection,
    list,
    models,
    probe,
    dispose: () => probeService.dispose(),
  };
}
