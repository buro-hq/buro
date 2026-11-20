import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { DomainError } from '../../core/ports.ts';
import { PrivateJSONFiles } from './private-json.ts';

const schema = z.record(
  z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/),
  z
    .string()
    .trim()
    .min(1)
    .max(4096)
    .regex(/^[^\r\n]+$/),
);

/** Private references resolve here; credentials never become resource DTOs or environment mutations. */
export async function loadModelCredentials(directory: string) {
  let raw: unknown;
  try {
    raw = await new PrivateJSONFiles(directory).load('model-credentials');
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      'INVALID_CREDENTIAL_STORE',
      'The private model credential record could not be read.',
    );
  }
  let saved: Record<string, string> = {};
  if (raw !== undefined) {
    const stat = await fs.lstat(path.join(directory, 'model-credentials.json'));
    if (stat.mode & 0o077)
      throw new DomainError(
        'INVALID_CREDENTIAL_STORE',
        'Model credentials require private file permissions (0600).',
      );
    const result = schema.safeParse(raw);
    if (!result.success)
      throw new DomainError(
        'INVALID_CREDENTIAL_STORE',
        'The private model credential record is invalid.',
      );
    saved = result.data;
  }
  return (reference: string): string | undefined => {
    if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(reference)) return undefined;
    const environment = Object.hasOwn(process.env, reference) ? process.env[reference] : undefined;
    return environment || (Object.hasOwn(saved, reference) ? saved[reference] : undefined);
  };
}
