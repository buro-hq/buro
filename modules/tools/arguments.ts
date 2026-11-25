import { ToolFailure } from './tool.ts';

/** Validates external tool arguments without applying business rules to internal records. */
export const objectArguments = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ToolFailure('Arguments must be a JSON object.');

  return value as Record<string, unknown>;
};

/** Reads text with a useful model-facing error for an invalid argument. */
export const textArgument = (input: {
  arguments: Record<string, unknown>;
  name: string;
  optional?: boolean;
}): string | undefined => {
  const value = input.arguments[input.name];
  if (value === undefined && input.optional)
    return undefined;

  if (typeof value !== 'string')
    throw new ToolFailure(`${input.name} must be a string.`);

  return value;
};
