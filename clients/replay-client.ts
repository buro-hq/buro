import type { CreateGoal, Goal, Role, SaveRole, Snapshot } from '../protocol/domain.ts';
import { CommandSchema, type ClientCommand } from '../protocol/schema.ts';
import type { Connection, ProjectClient } from './project-client.ts';

/** Explicit offline demo adapter. No daemon, core or Cordis dependencies. */
export class ReplayProjectClient implements ProjectClient {
  readonly mode = 'replay' as const;
  state: Snapshot;
  listeners = new Set<(s: Snapshot) => void>();
  constructor(snapshot: Snapshot) {
    this.state = snapshot;
  }
  async connect() {
    return this.snapshot();
  }
  snapshot() {
    return this.state;
  }
  onChange(fn: (s: Snapshot) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  onConnection(_fn: (s: Connection) => void) {
    return () => {};
  }
  notify() {
    for (const fn of this.listeners) fn(this.state);
  }
  async createGoal(input: CreateGoal) {
    const goal: Goal = {
      ...input,
      id: 'G-' + crypto.randomUUID(),
      status: 'draft',
      createdAt: new Date().toISOString(),
    };
    this.state = { ...this.state, goals: [...this.state.goals, goal] };
    this.persist();
    this.notify();
    return goal;
  }
  async deleteGoal(_projectId: string, id: string) {
    this.state = { ...this.state, goals: this.state.goals.filter((g) => g.id !== id) };
    this.persist();
    this.notify();
    return { id };
  }
  persist() {
    localStorage.setItem('project-panel-drafts-v1', JSON.stringify(this.state.goals));
  }
  async saveRole(_input: SaveRole): Promise<Role> {
    throw Error('Connect to the service to edit roles.');
  }
  async command<T>(input: ClientCommand): Promise<T> {
    const command = CommandSchema.parse(input);
    if (command.method !== 'goal.update')
      throw Error('This command is unavailable in replay mode.');
    const params = command.params;
    const previous = this.state.goals.find(
      (goal) => goal.id === params.id && goal.projectId === params.projectId,
    );
    if (!previous) throw Error('Goal not found.');
    if ((previous.revision || 1) !== params.expectedRevision)
      throw Error('The goal changed. Reopen the editor.');
    const goal: Goal = {
      ...previous,
      title: params.title,
      body: params.body,
      criteria: params.criteria,
      repairEnvironment: !!params.repairEnvironment,
      parentRunId: params.parentRunId,
      outcome: params.outcome,
      materialIds: params.materialIds ?? previous.materialIds,
      revision: (previous.revision || 1) + 1,
    };
    this.state = {
      ...this.state,
      goals: this.state.goals.map((item) => (item.id === goal.id ? goal : item)),
    };
    this.persist();
    this.notify();
    return goal as T;
  }
  close() {
    this.listeners.clear();
  }
}
