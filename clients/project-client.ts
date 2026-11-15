import type { CreateGoal, Goal, Role, SaveRole, Snapshot } from '../protocol/domain.ts';
import type { ClientCommand } from '../protocol/schema.ts';
export type Connection = 'connecting' | 'connected' | 'reconnecting' | 'offline';
export interface ProjectClient {
  readonly mode: 'service' | 'replay';
  connect(): Promise<Snapshot>;
  snapshot(): Snapshot;
  onChange(listener: (snapshot: Snapshot) => void): () => void;
  onConnection(listener: (state: Connection) => void): () => void;
  command<T>(command: ClientCommand): Promise<T>;
  createGoal(input: CreateGoal): Promise<Goal>;
  deleteGoal(projectId: string, id: string): Promise<unknown>;
  saveRole(input: SaveRole): Promise<Role>;
  close(): void;
}
