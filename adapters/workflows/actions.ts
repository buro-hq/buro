import { z } from 'zod';
import { ExecutionActionCatalog } from '../../core/execution-actions.ts';
import { EnvelopeSchema, WorkerProposalSchema } from '../../protocol/execution.ts';
import { ResourceIdSchema } from '../../protocol/resources.ts';
import { WorkerTaskSchema } from '../../protocol/worker-tasks.ts';

/** Default capabilities describe available work; the model chooses their order. */
export function registerBuiltinExecutionActions(catalog: ExecutionActionCatalog): void {
  catalog.register({
    id: 'delegate',
    revision: 'delegate-v1',
    description:
      'Assign a focused task to one specialist when useful. Reuse an existing worker role or propose a reusable role. Respect resource preferences and file permissions. Wait for the actual result before deciding what to do next.',
    schema: z.strictObject({
      worker: WorkerProposalSchema.extend({
        runtimeId: ResourceIdSchema.nullable(),
        runtimeReason: z.string().trim().max(1000),
        assignment: WorkerTaskSchema.nullable(),
      }),
    }),
    execute: (input, operations) => operations.delegate(input),
  });
  catalog.register({
    id: 'check',
    revision: 'check-v1',
    description:
      'Run the registered service checks on the current workspace revision. Use the observed failures and scope evidence to choose the next action. Passing checks alone do not accept the result.',
    schema: z.strictObject({}),
    execute: (input, operations) => operations.check(input),
  });
  catalog.register({
    id: 'review',
    revision: 'review-v1',
    description:
      'Request a fresh independent read-only review of the current result and verified revision. Inspect the actual findings before deciding whether to repair, investigate, delegate or finish.',
    schema: z.strictObject({ result: EnvelopeSchema }),
    execute: (input, operations) => operations.review(input),
  });
  catalog.register({
    id: 'finish',
    revision: 'finish-v1',
    description:
      'Submit the result for service acceptance. Requires current successful checks, fresh independent approval of exactly this revision and settled effects. Your success claim cannot replace this evidence.',
    schema: z.strictObject({ result: EnvelopeSchema }),
    execute: (input, operations) => operations.finish(input),
  });
  catalog.register({
    id: 'ask_user',
    revision: 'ask-user-v1',
    description:
      'Ask the user a concrete question when required information or a decision is unavailable. Preserve completed work and explain what answer is needed to continue.',
    schema: z.strictObject({ question: z.string().trim().min(1) }),
    execute: (input, operations) => operations.askUser(input),
  });
  catalog.register({
    id: 'plan',
    revision: 'plan-v1',
    description:
      'Record or update a working plan as facts change. Planning is optional and does not dispatch workers, grant permissions or certify completion.',
    schema: z.strictObject({
      summary: z.string(),
      steps: z.array(z.strictObject({ step: z.string().min(1), owner: z.string().min(1) })),
    }),
    execute: (input, operations) => operations.plan(input),
  });
}

export function createBuiltinExecutionActions(): ExecutionActionCatalog {
  const catalog = new ExecutionActionCatalog();
  registerBuiltinExecutionActions(catalog);
  return catalog.seal();
}
