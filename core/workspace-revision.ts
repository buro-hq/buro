import type { FileChange } from '../protocol/domain.ts';

/** A host-captured source revision. Git trees include content and executable/symlink modes. */
export type WorkspaceRevision = {
  version: 1;
  base: string;
  head: string;
  /** Semantic staged entries/flags, excluding refreshable index stat metadata. */
  index: string;
  tree: string;
  /** Derived from the immutable captured tree, not a later live directory read. */
  changes: FileChange[];
};

export function sameWorkspaceRevision(a: WorkspaceRevision, b: WorkspaceRevision) {
  return (
    a.version === b.version &&
    a.base === b.base &&
    a.head === b.head &&
    a.index === b.index &&
    a.tree === b.tree
  );
}
