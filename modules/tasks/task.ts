import type { RecordStore } from '../storage/record-store.ts';

/** Describes the user's intent independently of attempts and model conversations. */
export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

/** Stores tasks without owning runs, sessions, settings or agent definitions. */
export interface TaskStore extends RecordStore<Task> {}

/** Fields supplied when a task is created or edited. */
export interface TaskInput {
  projectId: string;
  title: string;
  description: string;
}

/** Public task operations, also implementable by a future external module. */
export interface Tasks {
  /** Lists task definitions, optionally by project. */
  list(input?: { projectId?: string }): Promise<Task[]>;
  /** Finds a task without starting work. */
  get(input: { id: string }): Promise<Task | undefined>;
  /** Creates user intent. */
  create(input: TaskInput): Promise<Task>;
  /** Replaces editable task fields. */
  update(input: TaskInput & { id: string }): Promise<Task | undefined>;
  /** Removes the definition, preserving independent historical records. */
  delete(input: { id: string }): Promise<void>;
}
