import type { RecordStore } from '../storage/record-store.ts';

/** A reusable description, never an execution phase or a privileged role name. */
export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  tools?: string[];
}

/** Owns reusable descriptions, separately from the sessions that use them. */
export interface AgentStore extends RecordStore<Agent> {}

/** Reusable descriptions have no built-in execution privileges. */
export interface Agents {
  /** Lists available descriptions. */
  list(): Promise<Agent[]>;
  /** Reads a description. */
  get(input: { id: string }): Promise<Agent | undefined>;
  /** Creates or replaces a description. */
  save(input: Omit<Agent, 'id'> & { id?: string }): Promise<Agent>;
  /** Removes a description, preserving existing conversations. */
  delete(input: { id: string }): Promise<void>;
}
