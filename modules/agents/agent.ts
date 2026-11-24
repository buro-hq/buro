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
