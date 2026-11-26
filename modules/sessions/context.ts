import type { ModelMessage } from '../../agent/contracts/model.ts';
import type { SessionMessage } from './session.ts';

/** Request context is a view of complete stored history, never a second session state machine. */
export interface ContextInput {
  messages: SessionMessage[];
  contextTokens: number;
  outputTokens: number;
  overheadTokens?: number;
  /** Approximation calibrated from reported input usage; includes UTF-8 text and private state. */
  tokensPerByte?: number;
}

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** Builds a bounded portable request while retaining whole tool-call/result exchanges. */
export const conversationContext = (input: ContextInput): ModelMessage[] => {
  const messages = input.messages.map(({ modelId: _modelId, id: _id, ...message }) => structuredClone(message));
  const groups: ModelMessage[][] = [];
  for (const message of messages) {
    if (message.role === 'tool' && groups.length)
      groups.at(-1)!.push(message);
    else
      groups.push([message]);
  }
  const available =
    Math.max(0, input.contextTokens - input.outputTokens - (input.overheadTokens ?? 0)) /
    (input.tokensPerByte ?? 0.25);
  if (bytes(messages) <= available)
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
  let used = bytes([note, ...[...selected].flatMap((index) => groups[index])]);
  if (used > available)
    throw new Error(
      'The instructions and current task exceed this model’s input context. Increase its context size or shorten the input.',
    );

  for (let index = groups.length - 1; index >= 0; index--) {
    if (selected.has(index))
      continue;

    // Appending an exchange replaces its array brackets with one separator.
    let size = bytes(groups[index]) - 1;
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
      size = bytes(compact) - 1;
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
};
