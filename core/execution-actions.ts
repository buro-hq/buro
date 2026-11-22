import { z } from 'zod';
import type { EnvelopeSchema, TeamPlan } from '../protocol/execution.ts';
import type { ToolResult } from './model-ports.ts';
import { DomainError } from './ports.ts';
import { captureContributionArguments, parseContributionResult } from './tool-contributions.ts';

export type WorkerProposal = TeamPlan['team'][number];
export type ExecutionResult = z.infer<typeof EnvelopeSchema>;

/** Each operation validates its current owner and records its own real effects and evidence. */
export interface ExecutionActionOperations {
  delegate(input: { worker: WorkerProposal }): Promise<ToolResult>;
  check(input: Record<string, never>): Promise<ToolResult>;
  review(input: { result: ExecutionResult }): Promise<ToolResult>;
  finish(input: { result: ExecutionResult }): Promise<ToolResult>;
  askUser(input: { question: string }): Promise<ToolResult>;
  plan(input: { summary: string; steps: { step: string; owner: string }[] }): Promise<ToolResult>;
}

export type ExecutionActionContribution<Shape extends z.ZodRawShape = z.ZodRawShape> = {
  id: string;
  revision: string;
  description: string;
  schema: z.ZodObject<Shape>;
  execute(
    input: z.output<z.ZodObject<Shape>>,
    operations: ExecutionActionOperations,
  ): Promise<ToolResult>;
};
export type ExecutionActionDecision = { action: string; input: unknown };
export type ExecutionActionDefinition = {
  id: string;
  revision: string;
  description: string;
  parameters: Record<string, unknown>;
};
type RegisteredAction = {
  definition: ExecutionActionDefinition;
  schema: z.ZodObject;
  assertCurrent(): void;
  parse(input: unknown): unknown;
  invoke(input: unknown, operations: ExecutionActionOperations): Promise<ToolResult>;
};
const envelope = z.strictObject({
  decision: z.strictObject({ action: z.string().min(1), input: z.unknown() }),
});
const invalid = () =>
  new DomainError(
    'INVALID_EXECUTION_ACTION',
    'An execution action requires an ID, revision, description and strict structured arguments.',
  );

/** A single grammar works with native structured clients and managed providers. */
function assertStructuredObjects(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const schema = value as Record<string, unknown>;
  if (schema.type === 'object' || schema.properties !== undefined) {
    const properties = schema.properties as Record<string, unknown> | undefined;
    const required = schema.required ?? [];
    if (
      schema.additionalProperties !== false ||
      !properties ||
      !Array.isArray(required) ||
      required.length !== Object.keys(properties).length ||
      Object.keys(properties).some((key) => !required.includes(key))
    )
      throw invalid();
  }
  for (const key of ['properties', '$defs'] as const) {
    const children = schema[key];
    if (children && typeof children === 'object')
      for (const child of Object.values(children)) assertStructuredObjects(child);
  }
  assertStructuredObjects(schema.items);
  for (const key of ['anyOf', 'oneOf', 'allOf', 'prefixItems'] as const)
    if (Array.isArray(schema[key])) for (const child of schema[key]) assertStructuredObjects(child);
}

/** Trusted startup contributions expose bounded host operations, never a workflow callback. */
export class ExecutionActionCatalog {
  #actions = new Map<string, RegisteredAction>();
  #sealed = false;
  get sealed() {
    return this.#sealed;
  }
  assertSealed(): void {
    if (!this.#sealed)
      throw new DomainError('EXECUTION_ACTIONS_UNSEALED', 'Seal actions before executing a goal.');
  }
  register<Shape extends z.ZodRawShape>(input: ExecutionActionContribution<Shape>): void {
    if (this.#sealed)
      throw new DomainError('EXECUTION_ACTIONS_SEALED', 'Execution actions are already sealed.');
    if (
      !input ||
      typeof input.id !== 'string' ||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(input.id) ||
      typeof input.revision !== 'string' ||
      !input.revision.trim() ||
      typeof input.description !== 'string' ||
      !input.description.trim() ||
      !(input.schema instanceof z.ZodObject) ||
      typeof input.execute !== 'function'
    )
      throw invalid();
    if (this.#actions.has(input.id))
      throw new DomainError('EXECUTION_ACTION_EXISTS', 'An action with this ID already exists.');
    const { id, revision, description, execute } = input;
    const captured = captureContributionArguments(input.schema, {
      arguments: { code: 'EXECUTION_ACTION_ARGUMENTS', message: 'Invalid action arguments.' },
      changed: {
        code: 'EXECUTION_ACTIONS_CHANGED',
        message: 'The configured action arguments changed. Restore the captured action catalog.',
      },
    });
    assertStructuredObjects(captured.parameters);
    this.#actions.set(id, {
      definition: Object.freeze({ id, revision, description, parameters: captured.parameters }),
      schema: captured.schema,
      assertCurrent: captured.assertCurrent,
      parse: captured.parse,
      async invoke(value, operations) {
        const parsed = captured.parse(value);
        const result = await execute(parsed, operations);
        return parseContributionResult(result);
      },
    });
  }
  seal() {
    for (const action of this.#actions.values()) action.assertCurrent();
    this.#sealed = true;
    return this;
  }
  private actions(): RegisteredAction[] {
    this.assertSealed();
    const actions = [...this.#actions.values()].sort((a, b) =>
      a.definition.id.localeCompare(b.definition.id),
    );
    for (const action of actions) action.assertCurrent();
    return actions;
  }
  definitions(): ExecutionActionDefinition[] {
    return this.actions().map((action) => structuredClone(action.definition));
  }
  get revision(): string {
    return JSON.stringify(['execution-actions-v1', this.definitions()]);
  }
  outputSchema(): Record<string, unknown> {
    const actions = this.actions();
    if (!actions.length)
      throw new DomainError('EXECUTION_ACTIONS_EMPTY', 'No execution actions are configured.');
    const branches = actions.map((action) =>
      z
        .strictObject({ action: z.literal(action.definition.id), input: action.schema })
        .describe(action.definition.description),
    );
    const decision =
      branches.length === 1
        ? branches[0]
        : z.union([branches[0], branches[1], ...branches.slice(2)]);
    return structuredClone(z.toJSONSchema(z.strictObject({ decision })));
  }
  private selection(raw: unknown): { action: RegisteredAction; input: unknown } {
    this.actions();
    const parsed = envelope.safeParse(raw);
    if (!parsed.success)
      throw new DomainError('INVALID_EXECUTION_DECISION', 'Return one configured action decision.');
    const action = this.#actions.get(parsed.data.decision.action);
    if (!action)
      throw new DomainError('EXECUTION_ACTION_UNAVAILABLE', 'This action is not configured.');
    return { action, input: parsed.data.decision.input };
  }
  parse(raw: unknown): ExecutionActionDecision {
    const selected = this.selection(raw);
    return {
      action: selected.action.definition.id,
      input: selected.action.parse(selected.input),
    };
  }
  async invoke(raw: unknown, operations: ExecutionActionOperations): Promise<ToolResult> {
    const selected = this.selection(raw);
    let accepting = true;
    let tail: Promise<unknown> = Promise.resolve();
    const pending: Promise<ToolResult>[] = [];
    const perform = <Input>(operation: (input: Input) => Promise<ToolResult>, input: Input) => {
      if (!accepting) {
        const rejected = Promise.reject<ToolResult>(
          new DomainError('EXECUTION_ACTION_CLOSED', 'This action invocation has finished.'),
        );
        void rejected.catch(() => {});
        return rejected;
      }
      const captured = structuredClone(input);
      // Ordered host operations cannot outlive the action or overlap another model decision.
      const task = tail.then(() => operation.call(operations, captured));
      tail = task;
      pending.push(task);
      void task.catch(() => {});
      return task;
    };
    const bounded = Object.freeze<ExecutionActionOperations>({
      delegate: (input) => perform(operations.delegate, input),
      check: (input) => perform(operations.check, input),
      review: (input) => perform(operations.review, input),
      finish: (input) => perform(operations.finish, input),
      askUser: (input) => perform(operations.askUser, input),
      plan: (input) => perform(operations.plan, input),
    });
    let result: ToolResult | undefined;
    let handlerError: unknown;
    let failed = false;
    try {
      result = await selected.action.invoke(selected.input, bounded);
    } catch (error) {
      handlerError = error;
      failed = true;
    } finally {
      accepting = false;
    }
    const settled = await Promise.allSettled(pending);
    const rejected = settled.find((entry) => entry.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
    if (failed) throw handlerError;
    return result!;
  }
}
