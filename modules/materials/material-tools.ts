import type { Runs } from '../runs/run.ts';
import { ToolFailure, type Tool, type ToolContext } from '../tools/tool.ts';
import { objectArguments, textArgument } from '../tools/arguments.ts';
import type { Materials } from './material.ts';

/** Adds context queries without making document availability an admission or completion gate. */
export const materialTools = (input: { materials: Materials; runs: Runs }): Tool[] => {
  const scope = async (
    context: ToolContext,
  ): Promise<{ projectId: string; taskId?: string } | undefined> => {
    const run = context.runId
      ? await input.runs.get({
          id: context.runId,
        })
      : undefined;
    const projectId = run?.projectId ?? context.projectId;
    if (!projectId)
      return undefined;

    return { projectId, taskId: run?.taskId };
  };
  return [
    {
      effect: 'read',
      definition: {
        name: 'materials_list',
        description: 'List context attached to this task or shared with its project.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
      async execute({ context }) {
        const selected = await scope(context);
        return { content: JSON.stringify(selected ? await input.materials.list(selected) : []) };
      },
    },
    {
      effect: 'read',
      definition: {
        name: 'material_read',
        description:
          'Read a range of extracted attachment text. Original images and unsupported files are identified as references, not analyzed text.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            line: { type: 'integer', minimum: 1 },
            count: { type: 'integer', minimum: 1 },
          },
          required: ['id'],
          additionalProperties: false,
        },
      },
      async execute({ arguments: value, context }) {
        const args = objectArguments(value);
        const id = textArgument({
          arguments: args,
          name: 'id',
        })!;
        const selected = await scope(context);
        const material = await input.materials.get({
          id,
        });
        if (!selected || material?.projectId !== selected.projectId)
          throw new ToolFailure('Material not found in this project.');

        for (const name of ['line', 'count'])
          if (
            args[name] !== undefined &&
            (!Number.isSafeInteger(args[name]) || Number(args[name]) < 1)
          )
            throw new ToolFailure(name + ' must be a positive integer.');
        const result = await input.materials.read({
          id,
          line: args.line as number | undefined,
          count: args.count as number | undefined,
        });
        return { content: JSON.stringify(result), isError: !result.ok };
      },
    },
  ];
};
