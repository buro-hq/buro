import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import type { Commands } from '../commands/command.ts';
import type { Projects } from '../projects/project.ts';
import { objectArguments } from '../tools/arguments.ts';
import type { Tool } from '../tools/tool.ts';

const string = { type: 'string' };
const integer = { type: 'integer', minimum: 1 };

/** File operations execute inside the command sandbox, including their final filesystem access. */
export const fileTools = (input: { commands: Commands; projects: Projects }): Tool[] => {
  const definitions = [
    {
      name: 'list_files',
      operation: 'list',
      effect: 'read',
      description: 'List files in a workspace directory, excluding private metadata.',
      properties: { path: string },
      required: [],
    },
    {
      name: 'read_file',
      operation: 'read',
      effect: 'read',
      description:
        'Read text with line numbers. Select line and count to inspect a narrower range.',
      properties: { path: string, line: integer, count: integer },
      required: ['path'],
    },
    {
      name: 'write_file',
      operation: 'write',
      effect: 'write',
      description: 'Create or replace a complete text file in the workspace.',
      properties: { path: string, content: string },
      required: ['path', 'content'],
    },
    {
      name: 'edit_file',
      operation: 'edit',
      effect: 'write',
      description:
        'Replace exact text in a workspace file. Include enough context for a unique match, or explicitly choose replaceAll.',
      properties: { path: string, find: string, replace: string, replaceAll: { type: 'boolean' } },
      required: ['path', 'find', 'replace'],
    },
    {
      name: 'delete_file',
      operation: 'delete',
      effect: 'write',
      description: 'Remove a file or directory from this run’s workspace.',
      properties: { path: string },
      required: ['path'],
    },
  ];
  const worker = readFileSync(fileURLToPath(new URL('./worker.cjs', import.meta.url)), 'utf8');
  return definitions.map((definition) => ({
    effect: definition.effect as Tool['effect'],
    definition: {
      name: definition.name,
      description: definition.description,
      parameters: {
        type: 'object',
        properties: definition.properties,
        required: definition.required,
        additionalProperties: false,
      },
    },
    async execute({ arguments: value, context }) {
      const args = objectArguments(value);
      const project = context.projectId
        ? await input.projects.get({
            id: context.projectId,
          })
        : undefined;
      const result = await input.commands.run({
        workspace: context.workspace,
        source: project?.root,
        argv: [process.execPath, '-e', worker],
        stdin: JSON.stringify({
          ...args,
          path: args.path ?? '.',
          operation: definition.operation,
        }),
        readOnly: context.readOnly || definition.effect === 'read',
        allowNetwork: false,
        signal: context.signal,
      });
      return {
        content:
          (result.stdout || result.stderr || result.error || 'No output.') +
          (result.truncated ? '\n[Output truncated; request a narrower range.]' : ''),
        isError: !!result.error || result.exitCode !== 0,
        exitCode: result.exitCode,
      };
    },
  }));
};
