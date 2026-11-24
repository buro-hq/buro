/** A file changed by an attempt, without assumptions about its purpose or reviewer. */
export interface ChangedFile {
  path: string;
  status: string;
}

/** An inspectable snapshot and an expected outcome of combining it with the source tree. */
export interface ResultOutcome {
  ok: boolean;
  files?: ChangedFile[];
  patch?: string;
  revision?: string;
  error?: string;
}

/** Repository mechanics do not decide when an agent's work is complete. */
export interface RepositoryChanges {
  /** Captures current changes without committing them or changing the workspace index. */
  inspect(input: { workspace: string; base: string }): Promise<ResultOutcome>;
  /** Applies exactly the supplied patch, preserving unrelated source changes. */
  apply(input: { root: string; patch: string }): Promise<ResultOutcome>;
}

/** Combining results is an explicit action separate from run completion. */
export interface Results {
  /** Reads files and a patch for an attempt, including work still in progress. */
  inspect(input: { runId: string }): Promise<ResultOutcome>;
  /** Applies a snapshot; a supplied revision prevents applying changes newer than the reviewed view. */
  apply(input: { runId: string; revision?: string }): Promise<ResultOutcome>;
}
