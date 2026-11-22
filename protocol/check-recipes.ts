/** Service-observed recipe provenance; manifest content stays private to discovery. */
export type CheckRecipeSource = {
  contributionId: string;
  revision: string;
  label: string;
  head: string;
  inputs: {
    path: string;
    kind: 'text' | 'file' | 'directory';
    exists: boolean;
    /** SHA-256 of captured bytes, present only for an existing text manifest. */
    digest?: string;
  }[];
};
