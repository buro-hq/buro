export type { VerificationView } from '../protocol/verification.ts';
import { CheckOutputPathSchema } from '../protocol/verification.ts';

/** A selected set of checks shares one output grant; nested roots add no authority. */
export function canonicalOutputPaths(values: readonly string[]): string[] {
  const paths = [...new Set(values.map((value) => CheckOutputPathSchema.parse(value)))].sort(
    (left, right) => left.length - right.length || left.localeCompare(right),
  );
  return paths.filter(
    (value, index) => !paths.slice(0, index).some((parent) => value.startsWith(parent + '/')),
  );
}

export type OpenVerificationViewOptions = {
  projectId: string;
  runId: string;
  outputPaths: string[];
  signal?: AbortSignal;
};
