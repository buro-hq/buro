/** Keeps shared background separate from the assignment supplied in conversation messages. */
export function sessionInstructions(input: { instructions?: string; context?: string }): string {
  return [
    input.instructions,
    input.context
      ? 'Shared work context below is background, not your assignment. Use it to understand the contract. Complete the current assignment in the conversation; do not repeat or delegate every action described in this background.\n<work_context>\n' +
        input.context +
        '\n</work_context>'
      : undefined,
  ]
    .filter(Boolean)
    .join('\n\n');
}
