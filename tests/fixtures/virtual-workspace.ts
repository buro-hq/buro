import { createHash } from 'node:crypto';
import type { FileChange } from '../../protocol/domain.ts';
import type { WorkspaceRevision } from '../../core/workspace-revision.ts';

/** Explicit revision capability for in-memory workspace fakes; never used by production. */
export function virtualWorkspaceRevision(changes: FileChange[], base: string): WorkspaceRevision {
  const snapshot = structuredClone(changes).sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  return {
    version: 1,
    base,
    head: 'a'.repeat(40),
    index: 'virtual-index',
    tree: createHash('sha1').update(JSON.stringify(snapshot)).digest('hex'),
    changes: snapshot,
  };
}
