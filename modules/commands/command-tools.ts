import type { Projects } from '../projects/project.ts';
import { objectArguments, textArgument } from '../tools/arguments.ts';
import { ToolFailure, type Tool } from '../tools/tool.ts';
import type { Commands } from './command.ts';

/** Exposes shell work through the same isolated process interface used by file tools. */
export function commandTools(input: { commands: Commands; projects: Projects }): Tool[] {
  return [false, true].map(
    (readOnly) =>
      ({
        effect: readOnly ? 'read' : 'command',
        definition: {
          name: readOnly ? 'command_read' : 'command',
          description: readOnly
            ? 'Run a read-only shell command in the workspace. Writes are blocked by the OS sandbox.'
            : 'Run a shell command in the workspace, including builds and tests. A nonzero exit returns output without ending the task.',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string' },
              timeoutMs: { type: 'integer', minimum: 1 },
              allowNetwork: { type: 'boolean' },
            },
            required: ['command'],
            additionalProperties: false,
          },
        },
        async execute({ arguments: value, context }) {
          const args = objectArguments(value);
          const command = textArgument({
            arguments: args,
            name: 'command',
          })!;
          if (
            args.timeoutMs !== undefined &&
            (!Number.isSafeInteger(args.timeoutMs) || Number(args.timeoutMs) < 1)
          )
            throw new ToolFailure('timeoutMs must be a positive integer.');

          if (args.allowNetwork !== undefined && typeof args.allowNetwork !== 'boolean')
            throw new ToolFailure('allowNetwork must be a boolean.');

          const project = context.projectId
            ? await input.projects.get({
                id: context.projectId,
              })
            : undefined;
          const result = await input.commands.run({
            workspace: context.workspace,
            source: project?.root,
            argv: ['/bin/sh', '-c', command],
            readOnly: readOnly || context.readOnly,
            allowNetwork: args.allowNetwork === undefined ? !readOnly : args.allowNetwork === true,
            timeoutMs: args.timeoutMs as number | undefined,
            signal: context.signal,
          });
          return {
            content: JSON.stringify(result),
            isError: !!result.error || result.exitCode !== 0,
            exitCode: result.exitCode,
          };
        },
      }) as Tool,
  );
}
