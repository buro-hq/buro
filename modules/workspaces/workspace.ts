/** The files and source revision belonging to one run. */
export interface Workspace {
  path: string;
  source: string;
  base: string;
}

/** A repository or revision may be unavailable without failing the application. */
export interface WorkspaceResult {
  ok: boolean;
  workspace?: Workspace;
  error?: string;
}

/** Workspace preparation is independent of conversations and agent descriptions. */
export interface Workspaces {
  /** Creates an isolated copy, optionally carrying changes from an earlier attempt. */
  create(input: {
    runId: string;
    root: string;
    base?: string;
    previous?: Workspace;
    signal?: AbortSignal;
  }): Promise<WorkspaceResult>;
}
