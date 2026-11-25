import type { SessionMessage } from './session.ts';

/** Makes saved history usable for a new turn without assuming an unrecorded action did or did not happen. */
export const settledHistory = (messages: SessionMessage[]): SessionMessage[] => {
  const history = structuredClone(messages);
  const result: SessionMessage[] = [];
  for (let index = 0; index < history.length; index++) {
    const message = history[index];
    if (message.role === 'tool')
      continue;

    result.push(message);
    if (!message.toolCalls?.length)
      continue;

    const observed = new Map<string | undefined, SessionMessage>();
    while (history[index + 1]?.role === 'tool') {
      const tool = history[++index];
      observed.set(tool.toolCallId, tool);
    }
    for (const call of message.toolCalls)
      result.push(
        observed.get(call.id) ?? {
          role: 'tool',
          toolCallId: call.id,
          toolName: call.name,
          content:
            'The earlier turn stopped before this action result was recorded. Its outcome is unknown. Inspect current files and activity before deciding what to do; do not automatically repeat this action.',
        },
      );
  }
  return result;
};
