import { createHash } from 'node:crypto';
import type { BackendContribution } from '../../../core/resource-contributions.ts';
import { NativeRuntimeConfigSchema } from '../../../protocol/resource-builtins.ts';
import { CodexRuntime } from '../../codex/runtime.ts';
import type { RuntimeHostOptions } from '../runtime-host.ts';

export function codexContribution(host: RuntimeHostOptions): BackendContribution {
  const configured = {
    ...host.codex,
    ...(host.codex?.args ? { args: Object.freeze([...host.codex.args]) } : {}),
  };
  return {
    id: 'codex',
    label: 'Codex',
    revision: 'codex-contribution-v1',
    editor: 'codex',
    defaultConfig: {},
    parse: (config) => NativeRuntimeConfigSchema.parse(config),
    dependencies: () => [],
    describe: () => ({ local: false }),
    create: ({ id, config: input }) => {
      const config = NativeRuntimeConfigSchema.parse(input);
      const nativeOptions = {
        ...configured,
        args: configured.args ? [...configured.args] : undefined,
        model: config.model ?? configured.model,
        reasoningEffort: config.reasoningEffort ?? configured.reasoningEffort,
      };
      const runtime = new CodexRuntime({
        ...nativeOptions,
        id,
        projects: host.projects,
        executors: host.executors,
      });
      return {
        runtime,
        ...(nativeOptions.model ? { model: nativeOptions.model } : {}),
        local: false,
        revision: createHash('sha256').update(JSON.stringify(nativeOptions)).digest('hex'),
      };
    },
  };
}
