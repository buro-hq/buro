import type { RecordStore } from '../storage/record-store.ts';

/** A diagnostic observation; it is not a command or a source of restored application state. */
export interface Activity {
  id: string;
  sessionId: string;
  runId?: string;
  type: string;
  createdAt: string;
  data: Record<string, unknown>;
}

/** Stores activity independently of the current session and run records. */
export interface ActivityStore extends RecordStore<Activity> {}

/** Public history queries are independent of state restoration. */
export interface ActivityHistory {
  /** Returns observations for one session or run. */
  list(input?: { sessionId?: string; runId?: string }): Promise<Activity[]>;
  /** Appends a diagnostic observation. */
  append(input: Omit<Activity, 'id' | 'createdAt'>): Promise<Activity>;
}
