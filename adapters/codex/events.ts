import type { RuntimeEvent } from '../../core/runtime-events.ts';

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
const string = (value: unknown) => (typeof value === 'string' ? value : undefined);

/** Only allowlisted public activity crosses the adapter boundary. */
export function normalizeCodexEvent(
  event: { method: string; params: unknown },
  runId: string,
  sequence: number,
): RuntimeEvent[] {
  const p = object(event.params),
    item = object(p.item),
    turn = object(p.turn);
  const threadId = string(p.threadId);
  if (!threadId) return [];
  const id = JSON.stringify([
    event.method,
    threadId,
    string(item.id) || string(turn.id) || sequence,
  ]);
  const base = { id, runId, threadId };
  if (event.method === 'turn/started')
    return [{ ...base, type: 'turn.started', turnId: string(turn.id) }];
  if (event.method === 'turn/completed')
    return [
      {
        ...base,
        type: 'turn.completed',
        turnId: string(turn.id),
        status:
          turn.status === 'completed'
            ? 'completed'
            : turn.status === 'interrupted'
              ? 'interrupted'
              : 'failed',
      },
    ];
  if (!['item/started', 'item/completed'].includes(event.method)) return [];
  const completed = event.method === 'item/completed';
  if (item.type === 'agentMessage' && completed && typeof item.text === 'string')
    return [{ ...base, type: 'message.completed', text: item.text.slice(0, 12000) }];
  if (item.type === 'commandExecution' && typeof item.id === 'string') {
    const command = string(item.command) || '';
    return completed
      ? [
          {
            ...base,
            type: 'command.completed',
            commandId: item.id,
            command,
            exitCode:
              typeof item.exitCode === 'number' || item.exitCode === null
                ? item.exitCode
                : undefined,
            output: (string(item.aggregatedOutput) || '').slice(-30000),
          },
        ]
      : [{ ...base, type: 'command.started', commandId: item.id, command }];
  }
  if (item.type !== 'subAgentActivity' && item.type !== 'collabAgentToolCall') return [];
  const children =
    item.type === 'subAgentActivity'
      ? [item.agentThreadId]
      : Array.isArray(item.receiverThreadIds)
        ? item.receiverThreadIds
        : [];
  const states = object(item.agentsStates);
  return children
    .filter((child): child is string => typeof child === 'string' && !!child && child !== threadId)
    .map((child) => {
      const state = object(Object.hasOwn(states, child) ? states[child] : undefined);
      return {
        ...base,
        id: JSON.stringify([id, child]),
        type: 'agent.activity',
        threadId: child,
        parentThreadId: threadId,
        completed: item.kind === 'completed' || state.status === 'completed',
        message: string(state.message)?.slice(0, 12000),
        activityHints: {
          path: string(item.agentPath),
          prompt: string(item.prompt)?.slice(0, 4000),
          name: string(item.agentNickname),
        },
      };
    });
}
