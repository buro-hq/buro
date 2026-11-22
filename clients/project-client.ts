import type {
  CreateGoal,
  Goal,
  Role,
  SaveRole,
  Snapshot,
  ResourceConfigurationChange,
} from '../protocol/domain.ts';
import type { ClientCommand } from '../protocol/schema.ts';
export type Connection = 'connecting' | 'connected' | 'reconnecting' | 'offline';
export interface ProjectClient {
  readonly mode: 'service' | 'replay';
  connect(): Promise<Snapshot>;
  snapshot(): Snapshot;
  onChange(listener: (snapshot: Snapshot) => void): () => void;
  onConnection(listener: (state: Connection) => void): () => void;
  onServiceInvalidation?(listener: (change: ResourceConfigurationChange) => void): () => void;
  getResourceGeneration?(): number;
  getResourceRevision?(): string | undefined;
  command<T>(command: ClientCommand): Promise<T>;
  createGoal(input: CreateGoal): Promise<Goal>;
  deleteGoal(projectId: string, id: string): Promise<unknown>;
  saveRole(input: SaveRole): Promise<Role>;
  close(): void;
}
