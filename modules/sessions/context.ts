import type { ModelMessage } from '../../agent/contracts/model.ts';
import type { SessionMessage } from './session.ts';

/** Request context is a view of complete stored history, never a second session state machine. */
export interface ContextInput {
  messages: SessionMessage[];
  contextTokens: number;
  outputTokens: number;
  toolTokens?: number;
}

/** Builds a bounded portable request while retaining whole tool-call/result exchanges. */
export function conversationContext(input: ContextInput): ModelMessage[] {
  const messages = input.messages.map(({ modelId: _modelId, id: _id, ...message }) => {
    return structuredClone(message);
  });
  const groups: ModelMessage[][] = [];
  for (const message of messages) {
    if (message.role === 'tool' && groups.length)
      groups.at(-1)!.push(message);
    else
      groups.push([message]);
  }
  const available =
    Math.max(0, input.contextTokens - input.outputTokens - (input.toolTokens ?? 0)) * 4;
  if (JSON.stringify(messages).length <= available)
    return messages;

  const note: ModelMessage = {
    role: 'user',
    content:
      'Some conversation content is outside this request context; complete history is still saved. Files and completed actions are preserved. Inspect current files as needed. Do not repeat external actions merely because older context is missing.',
  };
  const firstUser = groups.findIndex((group) => group[0].role === 'user');
  const lastUser = groups.reduce(
    (last, group, index) => (group[0].role === 'user' ? index : last),
    -1,
  );
  const selected = new Set(
    groups.flatMap((group, index) =>
      group[0].role === 'system' || index === firstUser || index === lastUser ? [index] : []),
  );
  let used =
    JSON.stringify(note).length +
    [...selected].reduce((size, index) => size + JSON.stringify(groups[index]).length, 0);
  if (used > available)
    throw new Error(
      'The instructions and current task exceed this model’s input context. Increase its context size or shorten the input.',
    );

  for (let index = groups.length - 1; index >= 0; index--) {
    if (selected.has(index))
      continue;

    let size = JSON.stringify(groups[index]).length;
    if (used + size > available) {
      // A large result must not evict the current task. Shorten only observed tool output,
      // retaining its call ID and arguments so the request remains a valid conversation.
      const compact = groups[index].map((message) =>
        message.role === 'tool'
          ? {
              ...message,
              content:
                '[Large tool output omitted from this request. The complete result remains in session history; read a narrower range if needed.]',
            }
          : message);
      size = JSON.stringify(compact).length;
      if (used + size > available)
        break;

      groups[index] = compact;
    }

    selected.add(index);
    used += size;
  }
  const result: ModelMessage[] = [];
  let noticed = false;
  for (let index = 0; index < groups.length; index++) {
    if (selected.has(index))
      result.push(...groups[index]);
    else if (!noticed) {
      result.push(note);
      noticed = true;
    }
  }
  return result;
}
