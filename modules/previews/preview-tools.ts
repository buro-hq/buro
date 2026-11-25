import { objectArguments, textArgument } from '../tools/arguments.ts';
import { ToolFailure, type Tool } from '../tools/tool.ts';
import type { Previews } from './preview.ts';

/** Optional foreground previews use the same broker and explicit access as other tools. */
export function previewTools(input: { previews: Previews }): Tool[] {
  return [
    {
      effect: 'command',
      definition: {
        name: 'preview_start',
        description:
          'Start an optional foreground preview server in this run workspace. Use PORT and HOST environment variables in the command. It stays alive until explicitly stopped or the application exits.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            port: { type: 'integer', minimum: 1, maximum: 65535 },
          },
          required: ['command'],
          additionalProperties: false,
        },
      },
      async execute({ arguments: value, context }) {
        context.signal.throwIfAborted();
        if (!context.runId) throw new ToolFailure('A preview needs a run workspace.');
        const args = objectArguments(value),
          command = textArgument({ arguments: args, name: 'command' })!;
        const result = await input.previews.start({
          runId: context.runId,
          command,
          port: args.port as number | undefined,
        });
        return { content: JSON.stringify(result), isError: !result.ok };
      },
    },
    ...[false, true].map(
      (stop): Tool => ({
        effect: stop ? 'command' : 'read',
        definition: {
          name: stop ? 'preview_stop' : 'preview_status',
          description: stop
            ? 'Stop one preview belonging to this run.'
            : 'Read the status and output of one preview belonging to this run.',
          parameters: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
            additionalProperties: false,
          },
        },
        async execute({ arguments: value, context }) {
          const args = objectArguments(value),
            id = textArgument({ arguments: args, name: 'id' })!,
            preview = await input.previews.get({ id });
          if (!context.runId || preview?.runId !== context.runId)
            throw new ToolFailure('Preview not found in this run.');
          if (stop) await input.previews.stop({ id });
          return { content: JSON.stringify(stop ? await input.previews.get({ id }) : preview) };
        },
      }),
    ),
  ];
}
