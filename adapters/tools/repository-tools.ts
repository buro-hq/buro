import type { EnvironmentExecutors } from '../environments/executors.ts';
import { DomainError } from '../../core/ports.ts';
import type { ToolBroker, ToolEffect, ToolResult, ToolScope } from '../../core/model-ports.ts';
import type { ModelToolCall } from '../../agent/contracts/model.ts';
import {
  ToolContributionCatalog,
  toolEffectAllowed,
  type RepositoryToolOperations,
} from '../../core/tool-contributions.ts';
import { createBuiltinToolCatalog } from './builtin-tools.ts';
import { BoundedRepositoryOperations } from './repository-operations.ts';

/** One catalog dispatches builtins and trusted contributed tools through identical effect gates. */
export class RepositoryTools implements ToolBroker {
  #executors: EnvironmentExecutors;
  #catalog: ToolContributionCatalog;
  constructor(
    executors: EnvironmentExecutors,
    catalog: ToolContributionCatalog = createBuiltinToolCatalog(),
  ) {
    catalog.assertSealed();
    this.#executors = executors;
    this.#catalog = catalog;
    void catalog.revision;
  }
  get revision(): string {
    return this.#catalog.revision;
  }
  effect(name: string): ToolEffect {
    return this.#catalog.effect(name);
  }
  definitions(scope: ToolScope) {
    return this.#catalog.definitions(structuredClone(scope));
  }
  async execute(
    call: ModelToolCall,
    scope: ToolScope,
    options: { actionId: string; signal: AbortSignal; onCommandStart?: (command: string) => void },
  ): Promise<ToolResult> {
    options = { ...options };
    options.signal.throwIfAborted();
    let effect: ToolEffect | undefined;
    let effectStarted = false;
    try {
      const tool = this.#catalog.get(call.name);
      effect = tool.effect;
      const captured = structuredClone(scope);
      const authorize = (requested: ToolEffect) => {
        if (requested !== 'read' && requested !== effect)
          throw new DomainError(
            'TOOL_SCOPE',
            'This tool has no authority for this repository effect.',
          );
        if (
          !toolEffectAllowed(requested, captured) ||
          (captured.verificationViewId && requested !== 'read')
        )
          throw new DomainError(
            'TOOL_SCOPE',
            captured.readOnly
              ? 'This session is read only.'
              : requested === 'command' && captured.writeScope.mode === 'strict'
                ? 'Strict scope disables agent commands; final immutable checks still run.'
                : 'This effect is unavailable in the assignment.',
          );
      };
      authorize(effect);
      let accepting = true;
      const pending = new Set<Promise<ToolResult>>(),
        failedMutations: unknown[] = [];
      const perform = (
        requested: ToolEffect,
        action: (bounded: BoundedRepositoryOperations) => Promise<ToolResult>,
      ): Promise<ToolResult> => {
        if (!accepting) {
          const rejected = Promise.reject<ToolResult>(
            new DomainError('TOOL_SCOPE', 'The tool invocation has already finished.'),
          );
          void rejected.catch(() => {});
          return rejected;
        }
        let started = false;
        const bounded = new BoundedRepositoryOperations(
          this.#executors,
          captured,
          options,
          authorize,
          () => {
            started = true;
            effectStarted = true;
          },
        );
        let task: Promise<ToolResult>;
        try {
          task = Promise.resolve(action(bounded));
        } catch (error) {
          task = Promise.reject(error);
        }
        pending.add(task);
        void task.then(
          () => pending.delete(task),
          (error) => {
            if (started && requested !== 'read') failedMutations.push(error);
            pending.delete(task);
          },
        );
        return task;
      };
      const operations = Object.freeze<RepositoryToolOperations>({
        readFile: (input) => perform('read', (bounded) => bounded.readFile(input)),
        listFiles: (input) => perform('read', (bounded) => bounded.listFiles(input)),
        searchText: (input) => perform('read', (bounded) => bounded.searchText(input)),
        readDiff: () => perform('read', (bounded) => bounded.readDiff()),
        editFile: (input) => perform('write', (bounded) => bounded.editFile(input)),
        runCommand: (input) => perform('command', (bounded) => bounded.runCommand(input)),
      });
      let result: ToolResult | undefined,
        handlerError: unknown,
        failed = false;
      try {
        result = await tool.invoke(call.arguments, operations);
      } catch (error) {
        handlerError = error;
        failed = true;
      } finally {
        accepting = false;
      }
      // A handler cannot settle the host action while one of its bounded effects is still running.
      await Promise.allSettled([...pending]);
      if (failed) throw handlerError;
      if (failedMutations.length) throw failedMutations[0];
      return result!;
    } catch (error) {
      if (options.signal.aborted || effectStarted) throw error;
      // Only known validation failures/read effects become ordinary results. Ambiguous writes/processes remain fatal to the host journal.
      if (error instanceof DomainError || effect === undefined || effect === 'read')
        return {
          content: error instanceof Error ? error.message.slice(0, 2000) : 'Tool failed.',
          isError: true,
        };
      throw error;
    }
  }
}
