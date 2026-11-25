import type { ToolDefinition } from '../../agent/contracts/model.ts';
import { ToolFailure, type Tool, type ToolContext, type ToolResult, type Tools } from './tool.ts';

/** Owns tools; registration does not grant a particular invocation write access. */
export class ToolRegistry implements Tools {
  private tools = new Map<string, Tool>();

  /** Registers or replaces one tool without changing unrelated tools. */
  register(tool: Tool): void {
    this.tools.set(tool.definition.name, {
      effect: tool.effect,
      definition: structuredClone(tool.definition),
      execute: tool.execute.bind(tool),
    });
  }

  /** Lists tools selected for this invocation, excluding effects forbidden by its access. */
  definitions(input: { names?: string[]; readOnly?: boolean } = {}): ToolDefinition[] {
    return [...this.tools.values()]
      .filter((tool) => !input.names || input.names.includes(tool.definition.name))
      .filter((tool) => !input.readOnly || tool.effect === 'read')
      .map((tool) => structuredClone(tool.definition));
  }

  /** Dispatches one known tool, returning ordinary failures without ending the conversation. */
  async execute(input: {
    name: string;
    arguments: unknown;
    context: ToolContext;
    names?: string[];
  }): Promise<ToolResult> {
    input.context.signal.throwIfAborted();
    const tool = this.tools.get(input.name);
    if (!tool || (input.names && !input.names.includes(input.name)))
      return {
        content: `Tool ${input.name} is unavailable. Choose an advertised tool.`,
        isError: true,
      };

    if (input.context.readOnly && tool.effect !== 'read')
      return { content: 'This invocation is read-only. No action was performed.', isError: true };

    try {
      return await tool.execute({
        arguments: structuredClone(input.arguments),
        context: {
          ...input.context,
          tools: input.context.tools ? [...input.context.tools] : undefined,
        },
      });
    } catch (error) {
      if (error instanceof ToolFailure)
        return { content: error.message, isError: true };

      throw error;
    }
  }
}
