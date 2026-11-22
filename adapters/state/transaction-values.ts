import { DomainError } from '../../core/ports.ts';
import type { UsageCommand } from '../../core/usage-authority.ts';
const failure = (code: string, message: string) => new DomainError(code, message);
const validString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

/** A receipt round trip must preserve the exact JSON result returned to the first caller. */
function jsonValue(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  if (!value || typeof value !== 'object' || ancestors.has(value))
    throw failure('USAGE_RESULT_NOT_JSON', 'A transaction result must be JSON-safe.');
  const array = Array.isArray(value);
  if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw failure('USAGE_RESULT_NOT_JSON', 'A transaction result must be JSON-safe.');
  ancestors.add(value);
  try {
    if (array) {
      const keys = Reflect.ownKeys(value);
      if (
        keys.length !== value.length + 1 ||
        keys.some(
          (key) =>
            key !== 'length' &&
            (typeof key !== 'string' ||
              !/^(0|[1-9][0-9]*)$/.test(key) ||
              Number(key) >= value.length),
        )
      )
        throw failure('USAGE_RESULT_NOT_JSON', 'A transaction result must be JSON-safe.');
      return Array.from({ length: value.length }, (_item, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
          throw failure('USAGE_RESULT_NOT_JSON', 'A transaction result must be JSON-safe.');
        return jsonValue(descriptor.value, ancestors);
      });
    }
    const result: [string, unknown][] = [];
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string'))
      throw failure('USAGE_RESULT_NOT_JSON', 'A transaction result must be JSON-safe.');
    for (const key of (keys as string[]).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in descriptor) || !descriptor.enumerable)
        throw failure('USAGE_RESULT_NOT_JSON', 'A transaction result must be JSON-safe.');
      if (descriptor.value !== undefined)
        result.push([key, jsonValue(descriptor.value, ancestors)]);
    }
    return Object.fromEntries(result);
  } finally {
    ancestors.delete(value);
  }
}
export const json = (value: unknown) => JSON.stringify(jsonValue(value));
export function encodeResult(value: unknown) {
  return value === undefined ? '{"kind":"void"}' : json({ kind: 'json', value });
}
export function decodeResult(value: string): unknown {
  const receipt = JSON.parse(value) as { kind: string; value?: unknown };
  if (receipt.kind === 'void' && Object.keys(receipt).length === 1) return undefined;
  if (
    receipt.kind === 'json' &&
    Object.hasOwn(receipt, 'value') &&
    Object.keys(receipt).length === 2
  )
    return jsonValue(receipt.value);
  throw failure('INVALID_USAGE_RECEIPT', 'The saved command receipt is invalid.');
}
export function thenable(value: unknown): boolean {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
  for (
    let current: object | null = value as object;
    current;
    current = Object.getPrototypeOf(current)
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(current, 'then');
    if (descriptor) return !('value' in descriptor) || typeof descriptor.value === 'function';
  }
  return false;
}
export function commandCopy(command: UsageCommand): UsageCommand {
  const keys = command && typeof command === 'object' ? Reflect.ownKeys(command) : [];
  if (
    keys.length !== 2 ||
    !keys.includes('id') ||
    !keys.includes('fingerprint') ||
    keys.some((key) => !('value' in Object.getOwnPropertyDescriptor(command, key)!)) ||
    !validString(command.id) ||
    !validString(command.fingerprint)
  )
    throw failure('INVALID_USAGE_COMMAND', 'A command identity and fingerprint are required.');
  return { id: command.id, fingerprint: command.fingerprint };
}
