import { createHash, randomUUID } from 'node:crypto';
import type {
  BackendContribution,
  ProviderDescription,
} from '../../../core/resource-contributions.ts';
import { DomainError } from '../../../core/ports.ts';
import { ManagedAgentRuntime } from '../../../core/managed-runtime.ts';
import { WORKER_STEP_CHECK_REVISION } from '../../../core/worker-step-checks.ts';
import { ManagedRuntimeConfigSchema } from '../../../protocol/resource-builtins.ts';
import type { RuntimeHost, RuntimeHostOptions } from '../runtime-host.ts';

function modelDescription(provider: ProviderDescription | undefined, model: string) {
  if (!provider) throw new DomainError('CONNECTION_UNAVAILABLE', 'Model connection unavailable.');
  const description = provider.describeModel?.(model) || { supported: true, local: provider.local };
  if (!description.supported)
    throw new DomainError(
      'MODEL_UNSUPPORTED',
      description.reason || 'This provider does not support the configured model.',
    );
  return { local: provider.local && description.local };
}

export function managedContribution(
  options: RuntimeHostOptions,
  host: RuntimeHost,
): BackendContribution {
  return {
    id: 'managed',
    label: 'Buro agent',
    revision: 'managed-contribution-v1',
    editor: 'managed',
    defaultConfig: {},
    parse: (config) => ManagedRuntimeConfigSchema.parse(config),
    dependencies: (config) => [ManagedRuntimeConfigSchema.parse(config).connectionId],
    describe: (input, providers) => {
      const config = ManagedRuntimeConfigSchema.parse(input);
      return modelDescription(providers.get(config.connectionId), config.model);
    },
    template: (connection, model, provider) => {
      if (provider.describeModel?.(model).supported === false) return undefined;
      return {
        label: 'Buro agent',
        config: ManagedRuntimeConfigSchema.parse({ connectionId: connection.id, model }),
        local: modelDescription(provider, model).local,
      };
    },
    create: async ({ id, config: input, providers, providerDescriptions }) => {
      const config = ManagedRuntimeConfigSchema.parse(input);
      const provider = providers.get(config.connectionId)?.provider;
      if (!provider)
        throw new DomainError('CONNECTION_UNAVAILABLE', 'Model connection unavailable.');
      const { PiAgentLoopRunner } = await import('../../agents/pi-loop.ts');
      const runtime = new ManagedAgentRuntime({
        loopRunner: new PiAgentLoopRunner(),
        id,
        model: config.model,
        provider,
        sessions: host.sessions,
        tools: host.tools,
        projects: options.projects,
        idGenerator: randomUUID,
        limits: config.limits,
        requestPolicy: host.requestPolicy,
        budgets: host.budgets,
        segmentPolicy: host.segmentPolicy,
        segmentEvidence: host.segmentEvidence,
        workerStepChecks: host.workerStepChecks,
      });
      return {
        runtime,
        model: config.model,
        providerId: provider.id,
        local: modelDescription(providerDescriptions.get(config.connectionId), config.model).local,
        revision: createHash('sha256')
          .update(
            JSON.stringify([
              'managed-completion-v2',
              host.requestPolicy.revision,
              host.tools.revision,
              host.segmentPolicy ? [host.segmentPolicy.revision, host.segmentPolicy.limits] : null,
              host.workerStepChecks ? WORKER_STEP_CHECK_REVISION : null,
            ]),
          )
          .digest('hex'),
        probe: {
          provider,
          model: config.model,
          contextTokens: config.limits.contextTokens,
          maxOutputTokens: config.limits.maxOutputTokens,
        },
      };
    },
  };
}
