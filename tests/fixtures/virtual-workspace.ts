import { createHash } from 'node:crypto';
import type { FileChange } from '../../protocol/domain.ts';
import type { WorkspaceRevision } from '../../core/workspace-revision.ts';
import type { OpenVerificationViewOptions } from '../../core/verification-view.ts';
import { VerificationViewSchema } from '../../protocol/verification.ts';

export const VIRTUAL_BASE_COMMIT = '1'.repeat(40);

/** Explicit mock view descriptor; no files or confinement are claimed by this fixture. */
export const virtualVerificationViews = {
  async openVerificationView(
    sourceWorkspace: string,
    revision: WorkspaceRevision,
    options: OpenVerificationViewOptions,
  ) {
    const id = 'virtual-' + crypto.randomUUID();
    const directory = sourceWorkspace + '-' + id;
    return VerificationViewSchema.parse({
      version: 1,
      id,
      projectId: options.projectId,
      runId: options.runId,
      sourceWorkspace,
      readRoot: directory + '/read',
      outputRoot: directory + '/output',
      base: revision.base,
      tree: revision.tree,
      outputPaths: options.outputPaths,
    });
  },
  async releaseVerificationView() {},
};

/** Explicit revision capability for in-memory workspace fakes; never used by production. */
export function virtualWorkspaceRevision(changes: FileChange[], base: string): WorkspaceRevision {
  const snapshot = structuredClone(changes).sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  return {
    version: 1,
    base,
    head: base,
    index: 'virtual-index',
    tree: createHash('sha1').update(JSON.stringify(snapshot)).digest('hex'),
    changes: snapshot,
  };
}
