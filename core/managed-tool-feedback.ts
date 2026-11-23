import type { ModelMessage } from '../agent/contracts/model.ts';
import type { RejectedToolBatch } from './model-ports.ts';

export const undispatchedToolResult = Object.freeze({
  content: 'Tool was not dispatched because the turn stopped before execution.',
  isError: true,
});

/** Protocol feedback is a rejection receipt, never a tool execution or permission grant. */
export function rejectedToolBatchMessages(batch: RejectedToolBatch): ModelMessage[] {
  const content = JSON.stringify({
    error: 'UNADVERTISED_TOOL',
    message:
      'The entire tool batch was rejected. No tool in this response was executed. ' +
      'Use only the advertised function tools. To return a structured decision, stop calling tools ' +
      'and answer using the requested final schema.',
    availableTools: batch.availableTools,
  });
  return [
    structuredClone(batch.response.message),
    ...(batch.response.message.toolCalls || []).map((call) => ({
      role: 'tool' as const,
      content,
      toolCallId: call.id,
      toolName: call.name,
    })),
  ];
}
