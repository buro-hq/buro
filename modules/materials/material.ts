import type { RecordStore } from '../storage/record-store.ts';

/** User-supplied context, owned by a project and optionally associated with a task. */
export interface Material {
  id: string;
  projectId: string;
  taskId?: string;
  name: string;
  mimeType: string;
  bytes: number;
  textAvailable: boolean;
  note?: string;
  createdAt: string;
}

/** Original bytes and extracted text are private storage, not broadcast notifications. */
export interface MaterialRecord extends Material {
  contentBase64: string;
  text?: string;
}

/** The material module owns its copies independently of caller files and task definitions. */
export interface MaterialStore extends RecordStore<MaterialRecord> {}

/** A format reader receives copied bytes, never arbitrary host paths. */
export interface MaterialLoader {
  id: string;
  /** Chooses whether this reader understands the input. */
  matches(input: { name: string; bytes: Uint8Array }): boolean;
  /** Extracts text or explains that only the original reference is available. */
  load(input: {
    name: string;
    bytes: Uint8Array;
    signal: AbortSignal;
  }): Promise<{ mimeType: string; text?: string; note?: string }>;
}

/** Missing material or unsupported extraction is ordinary feedback. */
export interface MaterialOutcome {
  ok: boolean;
  material?: Material;
  text?: string;
  totalLines?: number;
  contentBase64?: string;
  error?: string;
}

/** Context is available through ordinary queries, without sealing a global loader catalog. */
export interface Materials {
  /** Lists project material, or a task's material together with shared project material. */
  list(input: { projectId: string; taskId?: string }): Promise<Material[]>;
  /** Reads safe metadata. */
  get(input: { id: string }): Promise<Material | undefined>;
  /** Retains already-uploaded bytes; callers never supply a host file path. */
  upload(input: {
    projectId: string;
    taskId?: string;
    name: string;
    contentBase64: string;
    signal?: AbortSignal;
  }): Promise<MaterialOutcome>;
  /** Reads a range of extracted text without forcing the whole document into model context. */
  read(input: { id: string; line?: number; count?: number }): Promise<MaterialOutcome>;
  /** Returns original bytes to an explicit download caller. */
  download(input: { id: string }): Promise<MaterialOutcome>;
  /** Removes the saved copy, preserving the user's original file. */
  delete(input: { id: string }): Promise<void>;
}
