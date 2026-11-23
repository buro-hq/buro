import { z } from 'zod';
import type { ToolDefinition } from '../agent/contracts/model.ts';
import type { ToolEffect, ToolResult, ToolScope } from './model-ports.ts';
import { DomainError } from './ports.ts';
import { ResourceConfigSchema } from '../protocol/resources.ts';

/** Only bounded workspace operations cross the trusted handler boundary. */
export interface RepositoryToolOperations {
  readFile(input: {
    path: string;
    startLine?: number;
    startColumn?: number;
    lineCount?: number;
    maxChars?: number;
  }): Promise<ToolResult>;
  listFiles(input: { path?: string }): Promise<ToolResult>;
  searchText(input: { query: string; path?: string }): Promise<ToolResult>;
  readDiff(): Promise<ToolResult>;
  editFile(input: { path: string; oldText: string; newText: string }): Promise<ToolResult>;
  runCommand(input: { command: string; timeoutMs?: number }): Promise<ToolResult>;
}
export type ToolContribution<Shape extends z.ZodRawShape = z.ZodRawShape> = {
  name: string;
  revision: string;
  description: string;
  effect: ToolEffect;
  schema: z.ZodObject<Shape>;
  execute(
    input: z.output<z.ZodObject<Shape>>,
    operations: RepositoryToolOperations,
  ): Promise<ToolResult>;
};
export type RegisteredToolContribution = {
  readonly name: string;
  readonly revision: string;
  readonly description: string;
  readonly effect: ToolEffect;
  readonly parameters: Record<string, unknown>;
  invoke(input: unknown, operations: RepositoryToolOperations): Promise<ToolResult>;
};
export const TOOL_EFFECT_POLICY_REVISION = 'repository-tool-effects-v2';
export function toolEffectAllowed(effect: ToolEffect, scope: ToolScope): boolean {
  if (!['read', 'write', 'command'].includes(effect))
    throw new DomainError('INVALID_TOOL_CONTRIBUTION', 'The tool has no registered effect policy.');
  if (effect === 'read') return true;
  if (scope.readOnly || scope.verificationViewId || scope.verificationTree) return false;
  if (effect === 'write')
    return scope.writeScope.mode === 'advisory' || scope.writeScope.plannedPaths.length > 0;
  if (effect === 'command') return scope.writeScope.mode === 'advisory';
  throw new DomainError('INVALID_TOOL_CONTRIBUTION', 'The tool has no registered effect policy.');
}
function immutable<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
const resultSchema = z.strictObject({
  content: z.string(),
  isError: z.boolean().optional(),
  exitCode: z.number().int().nullable().optional(),
});
function assertNoDroppedKeys(input: unknown, parsed: unknown): void {
  if (input === null || typeof input !== 'object') return;
  if (parsed === null || typeof parsed !== 'object')
    throw new Error('Tool arguments must retain declared object fields.');
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(parsed, key)) throw new Error('Unknown tool argument.');
    assertNoDroppedKeys(
      (input as Record<string, unknown>)[key],
      (parsed as Record<string, unknown>)[key],
    );
  }
}

/**
 * Zod 4 clones object shells but retains nested definition aliases. Keep its real parser
 * (including refinements), and fail closed if that semantic graph changes after publication.
 * Parse/run caches are intentionally excluded; they legitimately change on first parse.
 * Accessors and checks are compared by function identity, never executed by this observer.
 * Closed-over callback state remains the trusted contribution's revision responsibility.
 */
function schemaLiveness(
  schema: z.ZodObject,
  changed = {
    code: 'TOOL_CONFIGURATION_CHANGED',
    message:
      'A registered tool argument definition changed. Rebuild the tool catalog before continuing.',
  },
): () => void {
  const identities = new WeakMap<object, number>(),
    symbols = new Map<symbol, number>();
  let nextIdentity = 0;
  const identity = (value: object) => {
    let id = identities.get(value);
    if (id === undefined) {
      id = ++nextIdentity;
      identities.set(value, id);
    }
    return id;
  };
  const symbolIdentity = (value: symbol) => {
    let id = symbols.get(value);
    if (id === undefined) {
      id = ++nextIdentity;
      symbols.set(value, id);
    }
    return id;
  };
  const fingerprint = () => {
    const seen = new WeakMap<object, number>();
    let nextReference = 0;
    const visit = (value: unknown): unknown => {
      if (typeof value === 'function') return ['function', identity(value)];
      if (typeof value === 'symbol') return ['symbol', symbolIdentity(value)];
      if (typeof value === 'undefined') return ['undefined'];
      if (typeof value === 'number') return ['number', Object.is(value, -0) ? '-0' : String(value)];
      if (typeof value === 'bigint') return ['bigint', String(value)];
      if (value === null || typeof value !== 'object') return value;
      const existing = seen.get(value);
      if (existing !== undefined) return ['reference', existing];
      seen.set(value, ++nextReference);
      const metadata = Object.getOwnPropertyDescriptor(value, '_zod');
      const zod =
        metadata &&
        'value' in metadata &&
        metadata.value !== null &&
        typeof metadata.value === 'object'
          ? metadata.value
          : undefined;
      const definition = zod && Object.getOwnPropertyDescriptor(zod, 'def');
      if (definition && 'value' in definition && definition.value !== undefined)
        return ['zod-definition', identity(Object.getPrototypeOf(value)), visit(definition.value)];
      if (value instanceof RegExp) return ['regexp', value.source, value.flags];
      if (value instanceof Set) return ['set', [...value].map(visit)];
      if (value instanceof Map)
        return ['map', [...value].map(([key, item]) => [visit(key), visit(item)])];
      const prototype = Object.getPrototypeOf(value);
      return [
        'object',
        prototype === null ? null : identity(prototype),
        Reflect.ownKeys(value)
          .sort((a, b) => String(a).localeCompare(String(b)))
          .map((key) => {
            const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
            return [
              typeof key === 'symbol' ? ['symbol', symbolIdentity(key)] : key,
              'value' in descriptor
                ? visit(descriptor.value)
                : ['accessor', visit(descriptor.get), visit(descriptor.set)],
            ];
          }),
      ];
    };
    return JSON.stringify(visit(schema));
  };
  const captured = fingerprint();
  return () => {
    let current: string;
    try {
      current = fingerprint();
    } catch {
      throw new DomainError(changed.code, changed.message);
    }
    if (current !== captured) throw new DomainError(changed.code, changed.message);
  };
}

/** Capture the actual Zod parser and detached JSON grammar shared by trusted contributions. */
export function captureContributionArguments<Shape extends z.ZodRawShape>(
  input: z.ZodObject<Shape>,
  errors = {
    arguments: { code: 'TOOL_ARGUMENTS', message: 'Invalid tool arguments.' },
    changed: {
      code: 'TOOL_CONFIGURATION_CHANGED',
      message:
        'A registered tool argument definition changed. Rebuild the tool catalog before continuing.',
    },
  },
) {
  const schema = input.strict();
  const parameters = immutable(structuredClone(z.toJSONSchema(schema)));
  const assertCurrent = schemaLiveness(schema, errors.changed);
  return {
    schema,
    parameters,
    assertCurrent,
    parse(value: unknown): z.output<typeof schema> {
      assertCurrent();
      let parsed: z.output<typeof schema>;
      try {
        const captured = structuredClone(value);
        const validated = schema.parse(captured);
        assertNoDroppedKeys(captured, validated);
        parsed = immutable(ResourceConfigSchema.parse(validated)) as z.output<typeof schema>;
      } catch {
        assertCurrent();
        throw new DomainError(errors.arguments.code, errors.arguments.message);
      }
      assertCurrent();
      return parsed;
    },
  };
}

/** Invalid post-handler output must remain distinguishable from argument rejection. */
export function parseContributionResult(value: unknown): ToolResult {
  return structuredClone(resultSchema.parse(value));
}

/** Startup registrations are trusted application code, not a hostile-plugin sandbox. */
export class ToolContributionCatalog {
  #tools = new Map<string, RegisteredToolContribution>();
  #schemaChecks = new Map<string, () => void>();
  #sealed = false;
  get sealed() {
    return this.#sealed;
  }
  assertSealed() {
    if (!this.#sealed)
      throw new DomainError(
        'TOOL_CONTRIBUTIONS_UNSEALED',
        'Seal tools before creating an execution broker.',
      );
  }
  register<Shape extends z.ZodRawShape>(input: ToolContribution<Shape>): void {
    if (this.#sealed)
      throw new DomainError('TOOL_CONTRIBUTIONS_SEALED', 'Tool contributions are already sealed.');
    if (
      !input ||
      typeof input.name !== 'string' ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(input.name) ||
      typeof input.revision !== 'string' ||
      !input.revision.trim() ||
      typeof input.description !== 'string' ||
      !input.description.trim() ||
      !['read', 'write', 'command'].includes(input.effect) ||
      !(input.schema instanceof z.ZodObject) ||
      typeof input.execute !== 'function'
    )
      throw new DomainError(
        'INVALID_TOOL_CONTRIBUTION',
        'A tool requires a name, revision, description, effect and object argument schema.',
      );
    if (this.#tools.has(input.name))
      throw new DomainError('TOOL_EXISTS', 'A tool with this name is already registered.');
    const { name, revision, description, effect, execute } = input;
    const { parameters, assertCurrent, parse } = captureContributionArguments(input.schema);
    this.#schemaChecks.set(name, assertCurrent);
    this.#tools.set(
      name,
      Object.freeze({
        name,
        revision,
        description,
        effect,
        parameters,
        invoke: async (value: unknown, operations: RepositoryToolOperations) => {
          const parsed = parse(value);
          const result = await execute(parsed, operations);
          // Invalid post-handler output cannot disguise a potentially completed mutation as a preflight rejection.
          return parseContributionResult(result);
        },
      }),
    );
  }
  seal() {
    for (const check of this.#schemaChecks.values()) check();
    this.#sealed = true;
    return this;
  }
  get(name: string): RegisteredToolContribution {
    this.assertSealed();
    const tool = this.#tools.get(name);
    if (!tool) throw new DomainError('TOOL_UNAVAILABLE', 'Unknown tool.');
    this.#schemaChecks.get(name)!();
    return tool;
  }
  effect(name: string): ToolEffect {
    return this.get(name).effect;
  }
  get revision(): string {
    this.assertSealed();
    for (const check of this.#schemaChecks.values()) check();
    return JSON.stringify([
      TOOL_EFFECT_POLICY_REVISION,
      ...[...this.#tools.values()].map(({ name, revision, description, effect, parameters }) => ({
        name,
        revision,
        description,
        effect,
        parameters,
      })),
    ]);
  }
  definitions(scope: ToolScope): ToolDefinition[] {
    this.assertSealed();
    for (const check of this.#schemaChecks.values()) check();
    return [...this.#tools.values()]
      .filter((tool) => toolEffectAllowed(tool.effect, scope))
      .map(({ name, description, effect, parameters }) => ({
        name,
        description:
          description +
          (effect === 'command'
            ? ' Suggested project checks: ' +
              JSON.stringify(scope.commands.map((command) => command.command))
            : ''),
        parameters: structuredClone(parameters),
      }));
  }
}
