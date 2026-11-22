import fs, { constants } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DomainError } from '../../../core/ports.ts';
import {
  validateCheckRecipeInput,
  type CheckRecipeCatalog,
  type CheckRecipeFacts,
  type CheckRecipeInput,
  type ManifestFact,
} from '../../../core/check-recipes.ts';

const maxFileBytes = 262144;
const maxTotalBytes = 1048576;
const unsafe = () =>
  new DomainError(
    'UNSAFE_RECIPE_INPUT',
    'Recipe manifests must be regular repository paths without symlinks.',
  );

/** Exact metadata reads or bounded manifest bytes; callbacks never receive this reader. */
export async function captureCheckRecipeFacts(
  root: string,
  head: string,
  catalog: CheckRecipeCatalog,
): Promise<ReadonlyMap<string, CheckRecipeFacts>> {
  catalog.assertSealed();
  const declarations = catalog.declaredInputs();
  const all = new Map<string, CheckRecipeInput>();
  for (const inputs of declarations.values())
    for (const input of inputs) {
      const validated = validateCheckRecipeInput(input);
      all.set(validated.kind + ':' + validated.path, validated);
    }
  if (all.size > 64)
    throw new DomainError(
      'RECIPE_INPUT_LIMIT',
      'Too many manifest inputs were declared for project inspection.',
    );
  const base = path.resolve(root);
  if ((await fs.realpath(base)) !== base || !(await fs.lstat(base)).isDirectory()) throw unsafe();
  const captured = new Map<string, ManifestFact>();
  let totalBytes = 0;
  for (const [key, input] of all) {
    let filename = base;
    let missing = false;
    let stat: Awaited<ReturnType<typeof fs.lstat>> | undefined;
    for (const part of input.path.split('/')) {
      filename = path.join(filename, part);
      try {
        stat = await fs.lstat(filename);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        missing = true;
        break;
      }
      if (stat.isSymbolicLink()) throw unsafe();
      if (filename !== path.join(base, input.path) && !stat.isDirectory()) throw unsafe();
    }
    if (missing) {
      captured.set(
        key,
        input.kind === 'text'
          ? { path: input.path, kind: 'text', exists: false }
          : { path: input.path, kind: input.kind, exists: false },
      );
      continue;
    }
    if (input.kind === 'directory') {
      if (!stat?.isDirectory()) throw unsafe();
      captured.set(key, { path: input.path, kind: 'directory', exists: true });
      continue;
    }
    if (!stat?.isFile()) throw unsafe();
    if (input.kind === 'file') {
      captured.set(key, { path: input.path, kind: 'file', exists: true });
      continue;
    }
    if (stat.size > maxFileBytes)
      throw new DomainError('RECIPE_INPUT_LIMIT', 'A recipe manifest exceeds its text limit.');
    if ((await fs.realpath(filename)) !== filename) throw unsafe();
    const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      if (!(await handle.stat()).isFile()) throw unsafe();
      const buffer = Buffer.alloc(maxFileBytes + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const result = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!result.bytesRead) break;
        offset += result.bytesRead;
      }
      bytes = buffer.subarray(0, offset);
      if (bytes.length > maxFileBytes)
        throw new DomainError('RECIPE_INPUT_LIMIT', 'A recipe manifest exceeds its text limit.');
    } finally {
      await handle.close();
    }
    totalBytes += bytes.length;
    if (totalBytes > maxTotalBytes)
      throw new DomainError(
        'RECIPE_INPUT_LIMIT',
        'Recipe manifests exceed their total text limit.',
      );
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (content.includes('\0')) throw Error('binary');
    } catch {
      throw new DomainError('INVALID_RECIPE_MANIFEST', 'Recipe manifests must contain UTF-8 text.');
    }
    captured.set(key, {
      path: input.path,
      kind: 'text',
      exists: true,
      content,
      digest: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  return new Map(
    [...declarations].map(([id, inputs]) => [
      id,
      {
        head,
        entries: inputs.map((input) =>
          structuredClone(captured.get(input.kind + ':' + input.path)!),
        ),
      },
    ]),
  );
}
