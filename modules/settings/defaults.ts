import type { ReviewSettings } from '#shared/contracts';

/** Advisory working defaults, replaceable by the user's application or run instructions. */
export const defaultInstructions: string =
  'Complete the user’s task in this workspace. Choose tools, collaborators and models for the actual work. You can start helpers with session_start and iterate on their feedback. Delegate a distinct subtask when it adds information or useful parallel work; complete the current assignment directly when delegation would merely pass it on. Use an independent view when it helps quality, and verify the result in a way appropriate to the task. Keep the solution simple and focused on the stated requirements. Trust documented types and internal invariants. Distinguish confirmed contract defects from optional suggestions; do not expand the contract with speculative invalid inputs or add defensive behavior without a concrete need. Report the result and any remaining limitations honestly.';

/** Editable team descriptions; execution never branches on these names. */
export const defaultReviewSettings: ReviewSettings = {
  enabled: false,
  maxRounds: null,
  participants: [
    {
      name: 'Correctness and verification',
      instructions: 'Check the implementation against the task. Look for correctness defects and regressions. Run appropriate documented tests and inspect their real outcomes. Review the code quality needed for a reliable implementation.',
    },
    {
      name: 'Architecture and simplicity',
      instructions: 'Review boundaries, dependencies, public contracts and readability against the repository conventions. Identify unnecessary coupling, duplication, special cases and complexity. Request changes only when a concrete issue matters for this task.',
    },
  ],
};
