import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DomainError, type ProjectRegistry } from '../../core/ports.ts';
import type { AuthorizedMaterialText } from '../../core/project-analysis.ts';
import { ContextMaterialSchema, type ContextMaterial } from '../../protocol/context.ts';

/** Resolve exact saved references, never paths supplied by an analyzer or model. */
export async function readAuthorizedMaterialText(
  projects: ProjectRegistry,
  projectId: string,
  selected: readonly ContextMaterial[],
  signal: AbortSignal,
): Promise<AuthorizedMaterialText[]> {
  const snapshot = projects.get(projectId).snapshot();
  const root = path.resolve(snapshot.project.root);
  if ((await fs.realpath(root)) !== root)
    throw new DomainError('CONTEXT_CORRUPT', 'Material paths cannot contain symlinks.');
  const read = async (relative: string, hash: string) => {
    let current = root;
    for (const part of ['.buro', ...relative.split('/')]) {
      signal.throwIfAborted();
      current = path.join(current, part);
      const stat = await fs.lstat(current);
      if (
        stat.isSymbolicLink() ||
        (current !== path.join(root, '.buro', relative) && !stat.isDirectory())
      )
        throw new DomainError('CONTEXT_CORRUPT', 'Material paths cannot contain symlinks.');
    }
    const stat = await fs.lstat(current);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024)
      throw new DomainError(
        'CONTEXT_CORRUPT',
        'Material is unavailable or exceeds its saved limits.',
      );
    const data = await fs.readFile(current);
    if (data.length > 8 * 1024 * 1024 || createHash('sha256').update(data).digest('hex') !== hash)
      throw new DomainError('CONTEXT_CORRUPT', 'The saved material changed.');
    signal.throwIfAborted();
    return data;
  };
  const result: AuthorizedMaterialText[] = [];
  for (const input of selected) {
    signal.throwIfAborted();
    const material = ContextMaterialSchema.parse(input);
    const stored = snapshot.contextMaterials?.find((saved) => saved.id === material.id);
    if (
      !stored ||
      (
        [
          'name',
          'mimeType',
          'hash',
          'relativePath',
          'textPath',
          'textHash',
          'representation',
        ] as const
      ).some((key) => stored[key] !== material[key])
    )
      throw new DomainError(
        'CONTEXT_NOT_FOUND',
        'The selected material is not an authorized saved copy.',
      );
    const raw = await read(material.relativePath, material.hash);
    if (!!material.textPath !== !!material.textHash)
      throw new DomainError('CONTEXT_CORRUPT', 'Saved extracted text needs its matching hash.');
    const data =
      material.textPath && material.textHash
        ? await read(material.textPath, material.textHash)
        : raw;
    const reference =
      material.representation === 'reference' ||
      (material.representation === undefined &&
        !material.textPath &&
        !material.mimeType.startsWith('text/'));
    const base = {
      id: material.id,
      name: material.name,
      mimeType: material.mimeType,
      hash: material.hash,
      ...(material.textHash ? { textHash: material.textHash } : {}),
      ...(material.note ? { note: material.note } : {}),
    };
    if (reference) {
      result.push({
        ...base,
        representation: 'reference',
        note: material.note || 'Original reference only; no text or image pixels were analyzed.',
      });
      continue;
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    } catch {
      throw new DomainError('CONTEXT_CORRUPT', 'Saved material text is not UTF-8.');
    }
    if (text.includes('\0'))
      throw new DomainError('CONTEXT_CORRUPT', 'Saved material text contains binary content.');
    result.push({ ...base, representation: 'text', text });
  }
  return result;
}
