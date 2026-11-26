/** Keeps shared policy and background separate from the assignment supplied in conversation messages. */
export const sessionInstructions = (input: { instructions?: string; policy?: string; context?: string }): string => [
  input.policy
    ? 'Shared work policy below applies to every conversation in this work, including this one. Follow it while completing the current assignment; it is not itself an assignment to delegate or repeat.\n<work_policy>\n' +
    input.policy +
    '\n</work_policy>'
    : undefined,
  input.instructions,
  input.context
    ? 'Shared work context below is background, not your assignment. Use it to understand the contract. Complete the current assignment in the conversation; do not repeat or delegate every action described in this background.\n<work_context>\n' +
    input.context +
    '\n</work_context>'
    : undefined,
]
  .filter(Boolean)
  .join('\n\n');
